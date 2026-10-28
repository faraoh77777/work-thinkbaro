import type { AiStatus } from '../../shared/api'
import type { AiClient } from './aiClient'
import * as db from './db'
import { runTranscribe } from './jobs'
import type { AIJob, Note, NoteVersion, Recording } from './types'
import { newId, nowIso } from './types'

export interface TranscribeOutcome {
  job: AIJob
  note: Note | null
  /** 원문이 이미 있어 바로 넣지 않고 제안으로 남긴 경우 */
  proposal: NoteVersion | null
}

/**
 * 녹음 전사 → 노트 반영. 전사 원본(transcriptOriginal)은 처음 한 번만 정해진다.
 * 원문이 비어 있으면 바로 넣고(확인 필요 표시), 이미 글이 있으면 덮어쓰지 않고 제안으로 남긴다.
 */
export async function transcribeAndApply(args: { client: AiClient; ai: AiStatus; noteId: string; rec: Recording; signal?: AbortSignal; onProgress?: (j: AIJob) => void; resume?: AIJob | null }): Promise<TranscribeOutcome> {
  const note = await db.getNote(args.noteId)
  if (!note) throw new Error('노트를 찾지 못했습니다.')
  const { job, text } = await runTranscribe(args.rec, note, { client: args.client, chunkBudget: args.ai.chunkBudgetChars, maxAudioBytes: args.ai.maxAudioBytes, signal: args.signal, onProgress: args.onProgress }, args.resume)
  if (text === null) return { job, note: null, proposal: null }
  const fresh = (await db.getNote(args.noteId)) ?? note
  if (!fresh.sourceText.trim()) {
    const saved = await db.saveNote({ ...fresh, transcriptOriginal: fresh.transcriptOriginal || text, sourceText: text, recordingId: args.rec.id, transcriptNeedsReview: true }, fresh.revision)
    return { job, note: saved, proposal: null }
  }
  const proposal: NoteVersion = { id: newId(), noteId: fresh.id, kind: 'proposal', target: 'source', status: 'pending', content: text, createdAt: nowIso(), label: '음성 전사 결과(원문 끝에 추가할 수 있어요)' }
  await db.putVersion(proposal)
  const saved = await db.saveNote({ ...fresh, transcriptOriginal: fresh.transcriptOriginal || text, recordingId: args.rec.id, transcriptNeedsReview: true }, fresh.revision)
  return { job, note: saved, proposal }
}
