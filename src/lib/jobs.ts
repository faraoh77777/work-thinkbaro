import type { AIChunk, AIJob, Note, NoteVersion, Recording } from './types'
import { newId, nowIso } from './types'
import { ApiError } from './aiClient'
import type { AiClient } from './aiClient'
import * as db from './db'
import { joinOutputs, planChunks, sha256, tail } from './text'

export interface JobEnv {
  client: AiClient
  /** 구간 크기(코드포인트) — 제공자 한도 때문에 나누는 단위 */
  chunkBudget: number
  maxAudioBytes: number
  signal?: AbortSignal
  onProgress?: (job: AIJob) => void
}

/** 출력이 잘릴 때 한 구간에서 이어쓰기를 시도하는 최대 횟수(무한 반복 방지) */
export const MAX_CONTINUATIONS = 8
const CONTEXT_SRC = 600
const CONTEXT_OUT = 800
const CONTINUE_TAIL = 6000

const msg = (e: unknown): string => (e instanceof ApiError ? e.message : '알 수 없는 오류가 발생했습니다.')

async function save(job: AIJob, env: JobEnv): Promise<void> {
  await db.putJob(job)
  env.onProgress?.(structuredClone(job))
}

export function jobSummary(job: AIJob): { done: number; total: number } {
  return { done: job.chunks.filter((c) => c.status === 'done').length, total: job.chunks.length }
}

/** 마지막 compose 작업(진행 중·실패·중단 포함)이 지금 원문과 맞는지 확인해 재개할 수 있게 돌려준다. */
export async function findResumable(note: Note): Promise<AIJob | null> {
  const hash = await sha256(note.sourceText)
  const jobs = await db.listJobs(note.id)
  const j = jobs.find((x) => x.operation === 'compose' && x.status !== 'completed')
  return j && j.inputHash === hash && j.noteType === note.type ? j : null
}

/** 상세 작성. 같은 원문의 미완료 작업이 있으면 완료된 구간을 재사용하고 실패한 구간부터 이어간다. */
export async function runCompose(note: Note, env: JobEnv, resume?: AIJob | null): Promise<{ job: AIJob; proposal: NoteVersion | null }> {
  const hash = await sha256(note.sourceText)
  const plan = planChunks(note.sourceText, env.chunkBudget)
  if (!plan.length) throw new ApiError('bad_request', '작성할 본문이 없습니다.', false)
  let job: AIJob
  if (resume && resume.inputHash === hash && resume.noteType === note.type && resume.chunks.length === plan.length) {
    job = resume
    for (const c of job.chunks) if (c.status === 'running') c.status = c.output ? 'incomplete' : 'pending'
  } else {
    const t = nowIso()
    job = {
      id: newId(),
      noteId: note.id,
      operation: 'compose',
      noteType: note.type,
      inputRevision: note.revision,
      inputHash: hash,
      status: 'queued',
      chunks: plan.map((c) => ({ index: c.index, sourceRange: [c.start, c.end], status: 'pending', output: '', retryCount: 0 })),
      createdAt: t,
      updatedAt: t,
    }
  }
  job.status = 'running'
  job.error = undefined
  await save(job, env)

  for (let i = 0; i < job.chunks.length; i++) {
    const ch = job.chunks[i]!
    if (ch.status === 'done') continue
    if (env.signal?.aborted) return finish(job, env, 'cancelled', '사용자가 취소했습니다.')
    const prev = i > 0 ? job.chunks[i - 1]! : null
    ch.status = 'running'
    ch.error = undefined
    let acc = ch.output
    try {
      for (let step = 0; ; step++) {
        const r = await env.client.compose(
          {
            noteType: note.type,
            jobId: job.id,
            chunkIndex: i,
            chunkCount: job.chunks.length,
            sourceText: plan[i]!.text,
            sourceRange: [plan[i]!.start, plan[i]!.end],
            continueFrom: acc ? tail(acc, CONTINUE_TAIL) : undefined,
            previousSourceTail: i > 0 ? tail(plan[i - 1]!.text, CONTEXT_SRC) : undefined,
            previousOutputTail: prev?.output ? tail(prev.output, CONTEXT_OUT) : undefined,
            inputRevision: note.revision,
          },
          env.signal,
        )
        acc = acc ? acc + r.text : r.text
        ch.output = acc
        if (!r.truncated) {
          ch.status = 'done'
          break
        }
        // 잘린 응답은 완료가 아니다 → 이어쓰기
        ch.status = 'incomplete'
        await save(job, env)
        if (step + 1 >= MAX_CONTINUATIONS) break
        ch.status = 'running'
      }
    } catch (e) {
      const cancelled = e instanceof ApiError && e.code === 'cancelled'
      if (cancelled) {
        ch.status = ch.output ? 'incomplete' : 'pending'
      } else {
        ch.status = 'failed'
        ch.retryCount++
        ch.error = msg(e)
      }
      return finish(job, env, cancelled ? 'cancelled' : 'failed', cancelled ? '사용자가 취소했습니다.' : msg(e))
    }
    await save(job, env)
    if (ch.status === 'incomplete') return finish(job, env, 'incomplete', `${i + 1}번째 구간의 AI 출력이 끝나기 전에 잘렸습니다. "이어서 쓰기"로 계속하세요.`)
  }

  const text = joinOutputs(job.chunks.map((c) => c.output))
  job.status = 'completed'
  await save(job, env)
  const proposal = await makeProposal(note, job, text, false)
  return { job, proposal }
}

async function finish(job: AIJob, env: JobEnv, status: AIJob['status'], error: string): Promise<{ job: AIJob; proposal: NoteVersion | null }> {
  job.status = status
  job.error = error
  await save(job, env)
  return { job, proposal: null }
}

/** AI 결과는 현재 편집 내용을 덮어쓰지 않고 "제안" 버전으로만 보관한다. */
export async function makeProposal(note: Note, job: AIJob, content: string, incomplete: boolean): Promise<NoteVersion> {
  const p: NoteVersion = {
    id: newId(),
    noteId: note.id,
    kind: 'proposal',
    target: 'generated',
    status: 'pending',
    content,
    createdAt: nowIso(),
    inputHash: job.inputHash,
    inputRevision: job.inputRevision,
    label: `AI 상세 작성 제안 (${job.chunks.length}개 구간)`,
    incomplete,
  }
  await db.putVersion(p)
  return p
}

/** 완료된 구간까지의 결과만 따로 보고 싶을 때 */
export function partialText(job: AIJob): string {
  return joinOutputs(job.chunks.filter((c) => c.status === 'done').map((c) => c.output))
}

// ── 전사 ───────────────────────────────────────────────
export async function runTranscribe(rec: Recording, note: Note, env: JobEnv, resume?: AIJob | null): Promise<{ job: AIJob; text: string | null }> {
  let job: AIJob
  if (resume && resume.operation === 'transcribe' && resume.chunks.length === rec.segments.length) {
    job = resume
  } else {
    const t = nowIso()
    job = {
      id: newId(),
      noteId: note.id,
      operation: 'transcribe',
      noteType: note.type,
      inputRevision: note.revision,
      inputHash: rec.id,
      status: 'queued',
      chunks: rec.segments.map((s): AIChunk => ({ index: s.index, sourceRange: [s.index, s.index], status: 'pending', output: '', retryCount: 0 })),
      createdAt: t,
      updatedAt: t,
    }
  }
  job.status = 'running'
  job.error = undefined
  await save(job, env)
  for (const ch of job.chunks) {
    if (ch.status === 'done') continue
    if (env.signal?.aborted) return { job: (await finish(job, env, 'cancelled', '사용자가 취소했습니다.')).job, text: null }
    ch.status = 'running'
    try {
      const blob = await db.segmentBlob(rec, ch.index)
      if (blob.size === 0) throw new ApiError('bad_request', '저장된 오디오가 비어 있습니다.', false)
      if (blob.size > env.maxAudioBytes) throw new ApiError('payload_too_large', '이 녹음 구간이 한 번에 전사할 수 있는 크기를 넘었습니다.', false)
      const r = await env.client.transcribe(blob, { jobId: job.id, chunkIndex: ch.index, locale: 'ko-KR' }, env.signal)
      ch.output = r.text
      ch.status = 'done'
    } catch (e) {
      const cancelled = e instanceof ApiError && e.code === 'cancelled'
      ch.status = cancelled ? 'pending' : 'failed'
      if (!cancelled) {
        ch.retryCount++
        ch.error = msg(e)
      }
      return { job: (await finish(job, env, cancelled ? 'cancelled' : 'failed', cancelled ? '사용자가 취소했습니다.' : msg(e))).job, text: null }
    }
    await save(job, env)
  }
  job.status = 'completed'
  await save(job, env)
  return { job, text: job.chunks.map((c) => c.output.trim()).filter(Boolean).join('\n') }
}
