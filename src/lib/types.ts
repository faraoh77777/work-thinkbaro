import type { NoteType } from '../../shared/api'
export type { NoteType }

export const TYPE_META: Record<NoteType, { name: string; short: string; hint: string; placeholder: string }> = {
  memo: {
    name: '단순메모',
    short: '잊기 전에, 가볍게 남기기',
    hint: '말한 내용과 의도를 그대로 담아요. 임의로 내용을 더하지 않고 문장만 정돈합니다.',
    placeholder: '떠오른 생각을 그대로 적거나 말해 보세요.',
  },
  idea: {
    name: '아이디어',
    short: '작은 발상을 구체적인 계획으로',
    hint: '목적, 구상, 주요 기능, 실행 방법을 풀어 줍니다. 원문에 없는 발상은 "확장 제안"으로 따로 분리해요.',
    placeholder: '아이디어의 목적과 구상을 편하게 적어 보세요.',
  },
  story: {
    name: '대본·스토리',
    short: '상상을 장면과 이야기로 펼치기',
    hint: '배경·인물·장면·행동·대사를 자세히 씁니다. 장면이 바뀌면 문단을, 인물이 바뀌면 줄을 나눠요.',
    placeholder: '이야기의 씨앗이나 장면을 적어 보세요.',
  },
}
export const NOTE_TYPES: NoteType[] = ['memo', 'idea', 'story']

export interface Note {
  id: string
  type: NoteType
  title: string
  /** manual: 사용자가 쓰거나 고친 제목, ai: AI가 제안한 제목을 그대로 적용한 것 */
  titleSource: 'manual' | 'ai'
  /** 최초 직접 입력 원본(한 번 정해지면 바뀌지 않음) */
  originalText: string
  /** 최초 음성 전사 전문(한 번 정해지면 바뀌지 않음) */
  transcriptOriginal: string
  /** 사용자가 보정한 AI 입력 기준 전문 */
  sourceText: string
  generatedContent: string
  editedContent: string
  favorite: boolean
  createdAt: string
  updatedAt: string
  revision: number
  recordingId: string | null
  /** 전사 결과를 사용자가 원음과 대조해 확인했는지 */
  transcriptNeedsReview: boolean
  /** 이전 디자인에서 가져온 경우 원래 id */
  legacyId?: string
}

export type VersionKind = 'source' | 'generated' | 'edited' | 'proposal'
export interface NoteVersion {
  id: string
  noteId: string
  kind: VersionKind
  content: string
  createdAt: string
  /** proposal 전용: 적용 대상 */
  target?: 'generated' | 'source'
  status?: 'pending' | 'applied' | 'dismissed'
  /** proposal 전용: 입력 당시 원문 해시·revision */
  inputHash?: string
  inputRevision?: number
  /** 사람이 읽는 출처 설명 */
  label?: string
  /** 일부 구간만 완료된 결과 */
  incomplete?: boolean
}

export interface RecordingSegment {
  index: number
  mimeType: string
  durationMs: number
  chunkCount: number
  bytes: number
}
export type RecordingStatus = 'recording' | 'saved' | 'interrupted' | 'failed'
export interface Recording {
  id: string
  noteId: string
  mimeType: string
  durationMs: number
  status: RecordingStatus
  segments: RecordingSegment[]
  createdAt: string
  updatedAt: string
  error?: string
}

export type JobStatus = 'queued' | 'running' | 'completed' | 'incomplete' | 'failed' | 'cancelled'
export type ChunkStatus = 'pending' | 'running' | 'done' | 'failed' | 'incomplete'
export interface AIChunk {
  index: number
  /** 코드포인트 위치 [start, end) (전사 작업에서는 [세그먼트, 세그먼트]) */
  sourceRange: [number, number]
  status: ChunkStatus
  output: string
  retryCount: number
  error?: string
}
export interface AIJob {
  id: string
  noteId: string
  operation: 'transcribe' | 'compose'
  noteType: NoteType
  inputRevision: number
  inputHash: string
  status: JobStatus
  chunks: AIChunk[]
  error?: string
  createdAt: string
  updatedAt: string
}

export interface Draft {
  noteId: string
  /** 임시 저장 당시 노트의 편집 필드 */
  fields: Pick<Note, 'type' | 'title' | 'titleSource' | 'sourceText' | 'generatedContent' | 'editedContent'>
  baseRevision: number
  savedAt: string
}

export interface Backup {
  schemaVersion: 1
  app: 'thinkbaro'
  exportedAt: string
  /** 녹음 오디오(Blob)는 이 파일에 포함되지 않는다. */
  recordingsIncluded: false
  notes: Note[]
  versions: NoteVersion[]
}

export const newId = (): string => crypto.randomUUID()
export const nowIso = (): string => new Date().toISOString()
