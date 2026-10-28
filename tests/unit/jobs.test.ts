import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import * as db from '../../src/lib/db'
import { blankNote } from '../../src/lib/db'
import { ApiError } from '../../src/lib/aiClient'
import type { AiClient } from '../../src/lib/aiClient'
import { findResumable, runCompose, runTranscribe, MAX_CONTINUATIONS } from '../../src/lib/jobs'
import { planChunks } from '../../src/lib/text'
import type { ComposeRequest, ComposeResponse } from '../../shared/api'

let n = 0
beforeEach(() => db.configureDb(`jobs-${Date.now()}-${n++}`))

// 모의 AI는 이 단위 테스트(작업 로직 검증)에서만 쓴다. 실서비스 TC의 통과 근거가 아니다.
function fakeClient(handler: (r: ComposeRequest, call: number) => ComposeResponse | Error): AiClient & { calls: ComposeRequest[] } {
  const calls: ComposeRequest[] = []
  return {
    calls,
    status: async () => ({ configured: true, provider: 'fake', textReady: true, transcribeReady: true, chunkBudgetChars: 1000, maxAudioBytes: 1e6, reasons: [] }),
    title: async () => ({ title: 't', inputRevision: 0 }),
    compose: async (r) => {
      calls.push(r)
      const out = handler(r, calls.length)
      if (out instanceof Error) throw out
      return out
    },
    transcribe: async (_a, m) => ({ text: `전사${m.chunkIndex}`, jobId: m.jobId, chunkIndex: m.chunkIndex, complete: true }),
  }
}
const ok = (r: ComposeRequest, text: string, truncated = false): ComposeResponse => ({ text, truncated, coveredRange: r.sourceRange, inputRevision: r.inputRevision })

const longNote = async () => {
  const src = Array.from({ length: 9 }, (_, i) => `문단${i} ` + '가'.repeat(400)).join('\n\n')
  return db.saveNote({ ...blankNote('idea'), sourceText: src }, 0)
}

describe('compose job', () => {
  it('TC-013: runs chunks in order, fails mid-way, then resumes from the failed chunk without duplicates', async () => {
    const note = await longNote()
    const total = planChunks(note.sourceText, 1000).length
    expect(total).toBeGreaterThan(3)
    let failAt = 4 // 4번째 호출(= 구간 인덱스 3)에서 네트워크 실패
    const c1 = fakeClient((r, call) => (call === failAt ? new ApiError('network', '끊김', true) : ok(r, `[결과${r.chunkIndex}]`)))
    const first = await runCompose(note, { client: c1, chunkBudget: 1000, maxAudioBytes: 1e6 })
    expect(first.job.status).toBe('failed')
    expect(first.proposal).toBeNull()
    expect(first.job.chunks.map((c) => c.status).slice(0, 4)).toEqual(['done', 'done', 'done', 'failed'])
    expect(first.job.chunks[3]!.retryCount).toBe(1)

    failAt = -1
    const stored = (await findResumable(note))!
    expect(stored.id).toBe(first.job.id)
    const c2 = fakeClient((r) => ok(r, `[결과${r.chunkIndex}]`))
    const second = await runCompose(note, { client: c2, chunkBudget: 1000, maxAudioBytes: 1e6 }, stored)
    expect(second.job.status).toBe('completed')
    // 완료된 3개 구간은 다시 호출하지 않는다
    expect(c2.calls.map((c) => c.chunkIndex)).toEqual(Array.from({ length: total - 3 }, (_, i) => i + 3))
    const text = second.proposal!.content
    expect(text).toBe(Array.from({ length: total }, (_, i) => `[결과${i}]`).join('\n\n'))
    expect(second.proposal!.kind).toBe('proposal')
    // 원본 노트는 AI 결과로 바뀌지 않는다
    expect((await db.getNote(note.id))!.generatedContent).toBe('')
    expect((await db.getNote(note.id))!.sourceText).toBe(note.sourceText)
  })

  it('passes sourceRange, chunk counts and context tails; context is never part of sourceText', async () => {
    const note = await longNote()
    const c = fakeClient((r) => ok(r, `OUT${r.chunkIndex}-` + 'x'.repeat(50)))
    await runCompose(note, { client: c, chunkBudget: 1000, maxAudioBytes: 1e6 })
    const plan = planChunks(note.sourceText, 1000)
    c.calls.forEach((r, i) => {
      expect(r.sourceText).toBe(plan[i]!.text)
      expect(r.sourceRange).toEqual([plan[i]!.start, plan[i]!.end])
      expect(r.chunkCount).toBe(plan.length)
    })
    expect(c.calls[0]!.previousSourceTail).toBeUndefined()
    expect(c.calls[1]!.previousSourceTail!.length).toBeGreaterThan(0)
    expect(c.calls[1]!.previousOutputTail).toContain('OUT0-')
  })

  it('truncated output is continued, not treated as complete', async () => {
    const note = await db.saveNote({ ...blankNote('memo'), sourceText: '짧은 원문' }, 0)
    const c = fakeClient((r, call) => (call === 1 ? ok(r, '앞부분 ', true) : ok(r, '뒷부분')))
    const res = await runCompose(note, { client: c, chunkBudget: 1000, maxAudioBytes: 1e6 })
    expect(res.job.status).toBe('completed')
    expect(c.calls[1]!.continueFrom).toBe('앞부분 ')
    expect(res.proposal!.content).toBe('앞부분 뒷부분')
  })

  it('TC-023: output that never finishes ends as incomplete (no endless retry, no false success)', async () => {
    const note = await db.saveNote({ ...blankNote('memo'), sourceText: '원문' }, 0)
    const c = fakeClient((r) => ok(r, '조각', true))
    const res = await runCompose(note, { client: c, chunkBudget: 1000, maxAudioBytes: 1e6 })
    expect(res.job.status).toBe('incomplete')
    expect(res.proposal).toBeNull()
    expect(c.calls.length).toBe(MAX_CONTINUATIONS)
  })

  it('TC-023: 429 / bad response / cancel leave the note untouched and are reported by state', async () => {
    const note = await db.saveNote({ ...blankNote('story'), sourceText: '원문' }, 0)
    for (const err of [new ApiError('rate_limited', '한도', true), new ApiError('bad_response', '형식', true), new ApiError('timeout', '시간', true)]) {
      const r = await runCompose(note, { client: fakeClient(() => err), chunkBudget: 1000, maxAudioBytes: 1e6 })
      expect(r.job.status).toBe('failed')
      expect(r.job.error).toBe(err.message)
    }
    const ac = new AbortController()
    ac.abort()
    const cancelled = await runCompose(note, { client: fakeClient((r) => ok(r, 'x')), chunkBudget: 1000, maxAudioBytes: 1e6, signal: ac.signal })
    expect(cancelled.job.status).toBe('cancelled')
    expect((await db.getNote(note.id))!.sourceText).toBe('원문')
  })

  it('a job is not resumable after the source text changed (hash mismatch → new job)', async () => {
    const note = await db.saveNote({ ...blankNote('memo'), sourceText: '원문 A' }, 0)
    await runCompose(note, { client: fakeClient(() => new ApiError('network', 'x', true)), chunkBudget: 1000, maxAudioBytes: 1e6 })
    expect(await findResumable(note)).not.toBeNull()
    expect(await findResumable({ ...note, sourceText: '원문 B' })).toBeNull()
  })
})

describe('transcribe job', () => {
  it('transcribes each stored segment and resumes without redoing finished ones', async () => {
    const note = await db.saveNote({ ...blankNote('memo') }, 0)
    const rec = {
      id: 'rec1',
      noteId: note.id,
      mimeType: 'audio/webm',
      durationMs: 1,
      status: 'saved' as const,
      segments: [0, 1].map((i) => ({ index: i, mimeType: 'audio/webm', durationMs: 1, chunkCount: 1, bytes: 3 })),
      createdAt: '',
      updatedAt: '',
    }
    await db.putRecording(rec)
    await db.addChunk('rec1', 0, 0, new Blob(['aaa']))
    await db.addChunk('rec1', 1, 0, new Blob(['bbb']))
    let calls = 0
    const client: AiClient = {
      ...fakeClient(() => new Error('unused')),
      transcribe: async (_a, m) => {
        calls++
        if (m.chunkIndex === 1 && calls === 2) throw new ApiError('rate_limited', '한도', true)
        return { text: `T${m.chunkIndex}`, jobId: m.jobId, chunkIndex: m.chunkIndex, complete: true }
      },
    }
    const a = await runTranscribe(rec, note, { client, chunkBudget: 1000, maxAudioBytes: 1e6 })
    expect(a.job.status).toBe('failed')
    expect(a.text).toBeNull()
    const b = await runTranscribe(rec, note, { client, chunkBudget: 1000, maxAudioBytes: 1e6 }, a.job)
    expect(b.job.status).toBe('completed')
    expect(b.text).toBe('T0\nT1')
    expect(calls).toBe(3)
  })
})
