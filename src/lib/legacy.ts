import * as db from './db'
import type { Note, Recording } from './types'
import { newId } from './types'

// 이전 디자인(같은 origin)의 저장 형식: localStorage 'mindbook-notes-v1', IndexedDB 'mindbook-audio'(recordings 스토어, 키=노트 id).
// 이관은 읽기 전용이다. 이전 저장소는 수정·삭제하지 않는다.
const LS_KEY = 'mindbook-notes-v1'
const AUDIO_DB = 'mindbook-audio'

interface LegacyNote {
  id: string
  type?: string
  title?: string
  content?: string
  updated?: string
  star?: boolean
  sample?: boolean
  hasAudio?: boolean
}

export interface LegacyScan {
  found: boolean
  total: number
  importable: LegacyNote[]
  samples: number
}

export function scanLegacy(): LegacyScan {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return { found: false, total: 0, importable: [], samples: 0 }
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return { found: false, total: 0, importable: [], samples: 0 }
    const list = arr.filter((n): n is LegacyNote => typeof n === 'object' && n !== null && typeof (n as LegacyNote).id === 'string')
    const importable = list.filter((n) => !n.sample)
    return { found: list.length > 0, total: list.length, importable, samples: list.length - importable.length }
  } catch {
    return { found: false, total: 0, importable: [], samples: 0 }
  }
}

/** 이전 오디오 DB에서 Blob을 읽는다(없는 DB를 새로 만들지 않도록 최초 생성이면 중단). */
function readLegacyAudio(id: string): Promise<Blob | null> {
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(AUDIO_DB)
    } catch {
      return resolve(null)
    }
    req.onupgradeneeded = (e) => {
      if (e.oldVersion === 0) req.transaction?.abort()
    }
    req.onerror = () => resolve(null)
    req.onsuccess = () => {
      const d = req.result
      if (!d.objectStoreNames.contains('recordings')) {
        d.close()
        return resolve(null)
      }
      const g = d.transaction('recordings', 'readonly').objectStore('recordings').get(id)
      g.onsuccess = () => {
        d.close()
        resolve(g.result instanceof Blob ? g.result : null)
      }
      g.onerror = () => {
        d.close()
        resolve(null)
      }
    }
  })
}

const asType = (t?: string): Note['type'] => (t === 'idea' || t === 'story' ? t : 'memo')
const iso = (s?: string): string => (s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : new Date().toISOString())

export interface MigrateResult {
  imported: number
  skippedExisting: number
  audios: number
  audioMissing: number
}
export async function migrateLegacy(scan: LegacyScan, existing: Note[]): Promise<MigrateResult> {
  const have = new Set(existing.map((n) => n.legacyId).filter(Boolean))
  const res: MigrateResult = { imported: 0, skippedExisting: 0, audios: 0, audioMissing: 0 }
  for (const l of scan.importable) {
    if (have.has(l.id)) {
      res.skippedExisting++
      continue
    }
    const text = typeof l.content === 'string' ? l.content : ''
    const t = iso(l.updated)
    const id = newId()
    let recordingId: string | null = null
    if (l.hasAudio) {
      const blob = await readLegacyAudio(l.id)
      if (blob) {
        recordingId = newId()
        const rec: Recording = {
          id: recordingId,
          noteId: id,
          mimeType: blob.type || 'audio/webm',
          durationMs: 0,
          status: 'saved',
          segments: [{ index: 0, mimeType: blob.type || 'audio/webm', durationMs: 0, chunkCount: 1, bytes: blob.size }],
          createdAt: t,
          updatedAt: t,
        }
        await db.importRecording(rec, [blob])
        res.audios++
      } else res.audioMissing++
    }
    const note: Note = {
      id,
      type: asType(l.type),
      title: typeof l.title === 'string' ? l.title : '',
      titleSource: 'manual',
      originalText: text,
      transcriptOriginal: '',
      sourceText: text,
      generatedContent: '',
      editedContent: '',
      favorite: !!l.star,
      createdAt: t,
      updatedAt: t,
      revision: 1,
      recordingId,
      transcriptNeedsReview: false,
      legacyId: l.id,
    }
    await db.importBundle([note], [])
    res.imported++
  }
  return res
}
