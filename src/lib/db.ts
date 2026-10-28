import type { AIJob, Draft, Note, NoteVersion, Recording } from './types'
import { newId, nowIso } from './types'

// 모든 본문·음성·버전은 IndexedDB에 저장한다. 쓰기는 트랜잭션이 끝난 뒤에만 성공으로 돌려준다.
let DB_NAME = 'thinkbaro'
let dbp: Promise<IDBDatabase> | null = null
let fault: (() => Error | null) | null = null

/** 테스트 전용: 저장 실패(용량 부족·차단)를 주입한다. */
export function __setStorageFault(f: (() => Error | null) | null): void {
  fault = f
}
export function configureDb(name: string): void {
  DB_NAME = name
  dbp = null
}

export class StorageError extends Error {
  constructor(
    message: string,
    public quota = false,
  ) {
    super(message)
  }
}
export class ConflictError extends Error {
  constructor(public latest: Note) {
    super('다른 곳에서 이 노트가 먼저 바뀌었습니다.')
  }
}

function describe(e: unknown): StorageError {
  const name = (e as { name?: string })?.name
  if (name === 'QuotaExceededError') return new StorageError('저장 공간이 부족합니다.', true)
  if (name === 'SecurityError' || name === 'InvalidStateError') return new StorageError('이 브라우저에서 저장이 차단되어 있습니다(사생활 보호 모드이거나 사이트 데이터가 막혀 있을 수 있어요).')
  return new StorageError(`저장하지 못했습니다${(e as Error)?.message ? `: ${(e as Error).message}` : ''}`)
}

export function openDb(): Promise<IDBDatabase> {
  if (dbp) return dbp
  dbp = new Promise<IDBDatabase>((resolve, reject) => {
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(DB_NAME, 1)
    } catch (e) {
      reject(describe(e))
      return
    }
    req.onupgradeneeded = () => {
      const db = req.result
      db.createObjectStore('notes', { keyPath: 'id' })
      db.createObjectStore('versions', { keyPath: 'id' }).createIndex('noteId', 'noteId')
      db.createObjectStore('recordings', { keyPath: 'id' }).createIndex('noteId', 'noteId')
      db.createObjectStore('chunks', { keyPath: ['recordingId', 'segment', 'index'] })
      db.createObjectStore('jobs', { keyPath: 'id' }).createIndex('noteId', 'noteId')
      db.createObjectStore('drafts', { keyPath: 'noteId' })
    }
    req.onsuccess = () => {
      req.result.onversionchange = () => req.result.close()
      resolve(req.result)
    }
    req.onerror = () => reject(describe(req.error))
    req.onblocked = () => reject(new StorageError('다른 탭이 저장소를 사용 중입니다. 다른 탭을 닫고 다시 시도하세요.'))
  })
  dbp.catch(() => {
    dbp = null
  })
  return dbp
}

type StoreName = 'notes' | 'versions' | 'recordings' | 'chunks' | 'jobs' | 'drafts'

/** 트랜잭션 완료(oncomplete)를 기다린 뒤 결과를 돌려준다. */
async function run<T>(stores: StoreName[], mode: IDBTransactionMode, body: (s: Record<StoreName, IDBObjectStore>, tx: IDBTransaction) => Promise<T> | T): Promise<T> {
  const db = await openDb()
  if (mode === 'readwrite' && fault) {
    const err = fault()
    if (err) throw describe(err)
  }
  return new Promise<T>((resolve, reject) => {
    let tx: IDBTransaction
    try {
      tx = db.transaction(stores, mode)
    } catch (e) {
      reject(describe(e))
      return
    }
    let result: T
    let bodyDone = false
    tx.oncomplete = () => (bodyDone ? resolve(result) : reject(new StorageError('저장 트랜잭션이 비정상 종료되었습니다.')))
    tx.onerror = () => reject(describe(tx.error))
    tx.onabort = () => reject(describe(tx.error))
    const map = Object.fromEntries(stores.map((n) => [n, tx.objectStore(n)])) as Record<StoreName, IDBObjectStore>
    Promise.resolve()
      .then(() => body(map, tx))
      .then((r) => {
        result = r
        bodyDone = true
      })
      .catch((e) => {
        try {
          tx.abort()
        } catch {
          /* 이미 종료됨 */
        }
        reject(e)
      })
  })
}

const reqP = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((res, rej) => {
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })

// ── 노트 ───────────────────────────────────────────────
export const listNotes = (): Promise<Note[]> => run(['notes'], 'readonly', (s) => reqP(s.notes.getAll() as IDBRequest<Note[]>))
export const getNote = (id: string): Promise<Note | undefined> => run(['notes'], 'readonly', (s) => reqP(s.notes.get(id) as IDBRequest<Note | undefined>))

export function blankNote(type: Note['type'], id = newId()): Note {
  const t = nowIso()
  return {
    id,
    type,
    title: '',
    titleSource: 'manual',
    originalText: '',
    transcriptOriginal: '',
    sourceText: '',
    generatedContent: '',
    editedContent: '',
    favorite: false,
    createdAt: t,
    updatedAt: t,
    revision: 0,
    recordingId: null,
    transcriptNeedsReview: false,
  }
}

/**
 * 노트 저장. baseRevision이 저장소의 revision과 다르면 ConflictError(다른 탭 변경을 조용히 덮어쓰지 않음).
 * 이전 값은 버전으로 보관하고, originalText는 처음 정해진 뒤 바꾸지 않는다.
 */
export function saveNote(next: Note, baseRevision: number): Promise<Note> {
  return run(['notes', 'versions'], 'readwrite', async (s) => {
    const prev = (await reqP(s.notes.get(next.id) as IDBRequest<Note | undefined>)) ?? null
    const curRev = prev ? prev.revision : 0
    if (prev && curRev !== baseRevision) throw new ConflictError(prev)
    const t = nowIso()
    const saved: Note = { ...next, revision: curRev + 1, updatedAt: t, createdAt: prev?.createdAt ?? next.createdAt }
    // 한 번 정해진 원문·전사 원본은 바뀌지 않는다(처음 비어 있던 경우에만 새 값을 받는다).
    if (prev?.originalText) saved.originalText = prev.originalText
    if (prev?.transcriptOriginal) saved.transcriptOriginal = prev.transcriptOriginal
    if (!saved.originalText && !saved.transcriptOriginal && saved.sourceText) saved.originalText = saved.sourceText
    s.notes.put(saved)
    if (prev) {
      const snap = (kind: 'source' | 'generated' | 'edited', before: string, after: string, label: string) => {
        if (before && before !== after) s.versions.put({ id: newId(), noteId: next.id, kind, content: before, createdAt: t, label } satisfies NoteVersion)
      }
      snap('source', prev.sourceText, saved.sourceText, '원문(보정 전)')
      snap('generated', prev.generatedContent, saved.generatedContent, '상세 작성본(바뀌기 전)')
      snap('edited', prev.editedContent, saved.editedContent, '내 수정본(바뀌기 전)')
    }
    return saved
  })
}

// ── 버전 ───────────────────────────────────────────────
export const listVersions = (noteId: string): Promise<NoteVersion[]> =>
  run(['versions'], 'readonly', (s) => reqP(s.versions.index('noteId').getAll(noteId) as IDBRequest<NoteVersion[]>)).then((v) => v.sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
export const listAllVersions = (): Promise<NoteVersion[]> => run(['versions'], 'readonly', (s) => reqP(s.versions.getAll() as IDBRequest<NoteVersion[]>))
export const putVersion = (v: NoteVersion): Promise<void> => run(['versions'], 'readwrite', (s) => void s.versions.put(v))

// ── 녹음 ───────────────────────────────────────────────
export const putRecording = (r: Recording): Promise<void> => run(['recordings'], 'readwrite', (s) => void s.recordings.put(r))
export const getRecording = (id: string): Promise<Recording | undefined> => run(['recordings'], 'readonly', (s) => reqP(s.recordings.get(id) as IDBRequest<Recording | undefined>))
export const listRecordings = (): Promise<Recording[]> => run(['recordings'], 'readonly', (s) => reqP(s.recordings.getAll() as IDBRequest<Recording[]>))
export const addChunk = (recordingId: string, segment: number, index: number, blob: Blob): Promise<void> =>
  run(['chunks'], 'readwrite', (s) => void s.chunks.put({ recordingId, segment, index, blob }))

/** 세그먼트별 오디오(해당 세그먼트의 청크를 순서대로 이은 것). */
export async function segmentBlob(rec: Recording, segment: number): Promise<Blob> {
  const seg = rec.segments.find((x) => x.index === segment)
  const type = seg?.mimeType || rec.mimeType
  const rows = await run(['chunks'], 'readonly', (s) => reqP(s.chunks.getAll(IDBKeyRange.bound([rec.id, segment, 0], [rec.id, segment, Number.MAX_SAFE_INTEGER])) as IDBRequest<{ index: number; blob: Blob }[]>))
  rows.sort((a, b) => a.index - b.index)
  return new Blob(rows.map((r) => r.blob), { type })
}

/** 저장된 청크로 세그먼트별 개수·바이트를 다시 계산한다(강제 종료 복구용). */
export async function chunkStats(recordingId: string): Promise<{ segment: number; count: number; bytes: number }[]> {
  const rows = await run(['chunks'], 'readonly', (s) => reqP(s.chunks.getAll(IDBKeyRange.bound([recordingId, 0, 0], [recordingId, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER])) as IDBRequest<{ segment: number; blob: Blob }[]>))
  const m = new Map<number, { count: number; bytes: number }>()
  for (const r of rows) {
    const cur = m.get(r.segment) ?? { count: 0, bytes: 0 }
    cur.count++
    cur.bytes += r.blob.size
    m.set(r.segment, cur)
  }
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([segment, v]) => ({ segment, ...v }))
}

// ── 작업 ───────────────────────────────────────────────
export const putJob = (j: AIJob): Promise<void> => run(['jobs'], 'readwrite', (s) => void s.jobs.put({ ...j, updatedAt: nowIso() }))
export const getJob = (id: string): Promise<AIJob | undefined> => run(['jobs'], 'readonly', (s) => reqP(s.jobs.get(id) as IDBRequest<AIJob | undefined>))
export const listJobs = (noteId: string): Promise<AIJob[]> =>
  run(['jobs'], 'readonly', (s) => reqP(s.jobs.index('noteId').getAll(noteId) as IDBRequest<AIJob[]>)).then((v) => v.sort((a, b) => b.createdAt.localeCompare(a.createdAt)))

// ── 임시 저장 ──────────────────────────────────────────
export const putDraft = (d: Draft): Promise<void> => run(['drafts'], 'readwrite', (s) => void s.drafts.put(d))
export const getDraft = (noteId: string): Promise<Draft | undefined> => run(['drafts'], 'readonly', (s) => reqP(s.drafts.get(noteId) as IDBRequest<Draft | undefined>))
export const listDrafts = (): Promise<Draft[]> => run(['drafts'], 'readonly', (s) => reqP(s.drafts.getAll() as IDBRequest<Draft[]>))
export const deleteDraft =(noteId: string): Promise<void> => run(['drafts'], 'readwrite', (s) => void s.drafts.delete(noteId))

// ── 백업 가져오기(검증이 끝난 데이터만 한 트랜잭션으로) ─────
export function importBundle(notes: Note[], versions: NoteVersion[]): Promise<void> {
  return run(['notes', 'versions'], 'readwrite', (s) => {
    for (const n of notes) s.notes.put(n)
    for (const v of versions) s.versions.put(v)
  })
}
export function importRecording(rec: Recording, blobs: Blob[]): Promise<void> {
  return run(['recordings', 'chunks'], 'readwrite', (s) => {
    s.recordings.put(rec)
    blobs.forEach((b, i) => s.chunks.put({ recordingId: rec.id, segment: i, index: 0, blob: b }))
  })
}
