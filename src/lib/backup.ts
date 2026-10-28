import type { Backup, Note, NoteVersion } from './types'
import { NOTE_TYPES, newId, nowIso } from './types'

export function buildBackup(notes: Note[], versions: NoteVersion[]): Backup {
  return { schemaVersion: 1, app: 'thinkbaro', exportedAt: nowIso(), recordingsIncluded: false, notes, versions }
}
/** 줄바꿈·공백을 포함한 본문을 그대로 직렬화한다(정규화·잘라내기 없음). */
export const serializeBackup = (b: Backup): string => JSON.stringify(b, null, 2)

export type Validation = { ok: true; backup: Backup } | { ok: false; errors: string[] }

const isStr = (v: unknown): v is string => typeof v === 'string'
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function parseBackup(text: string): Validation {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, errors: ['JSON 형식이 올바르지 않습니다. 생각바로에서 내보낸 파일인지 확인하세요.'] }
  }
  return validateBackup(raw)
}

/** 쓰기 전에 구조·타입을 모두 검사한다. 하나라도 어긋나면 아무것도 가져오지 않는다. */
export function validateBackup(raw: unknown): Validation {
  const errors: string[] = []
  if (!isObj(raw)) return { ok: false, errors: ['백업 파일의 최상위가 객체가 아닙니다.'] }
  if (raw.app !== 'thinkbaro') errors.push('생각바로 백업 파일이 아닙니다(app 값이 다릅니다).')
  if (raw.schemaVersion !== 1) errors.push(`지원하지 않는 백업 버전입니다(schemaVersion: ${String(raw.schemaVersion)}). 이 앱은 1만 읽을 수 있어요.`)
  if (!Array.isArray(raw.notes)) errors.push('notes 목록이 없습니다.')
  if (!Array.isArray(raw.versions)) errors.push('versions 목록이 없습니다.')
  if (errors.length) return { ok: false, errors }

  const notes: Note[] = []
  ;(raw.notes as unknown[]).forEach((n, i) => {
    const where = `notes[${i}]`
    if (!isObj(n)) return void errors.push(`${where}가 객체가 아닙니다.`)
    if (!isStr(n.id) || !n.id) errors.push(`${where}.id가 없습니다.`)
    if (!NOTE_TYPES.includes(n.type as never)) errors.push(`${where}.type이 올바르지 않습니다.`)
    for (const k of ['title', 'sourceText', 'generatedContent', 'editedContent', 'originalText', 'transcriptOriginal'] as const) {
      if (n[k] !== undefined && !isStr(n[k])) errors.push(`${where}.${k}가 문자열이 아닙니다.`)
    }
    if (n.favorite !== undefined && typeof n.favorite !== 'boolean') errors.push(`${where}.favorite가 올바르지 않습니다.`)
    if (!isStr(n.createdAt) || Number.isNaN(Date.parse(n.createdAt))) errors.push(`${where}.createdAt이 올바르지 않습니다.`)
    if (!isStr(n.updatedAt) || Number.isNaN(Date.parse(n.updatedAt))) errors.push(`${where}.updatedAt이 올바르지 않습니다.`)
    if (typeof n.revision !== 'number') errors.push(`${where}.revision이 숫자가 아닙니다.`)
    if (errors.length === 0) {
      notes.push({
        id: n.id as string,
        type: n.type as Note['type'],
        title: (n.title as string) ?? '',
        titleSource: n.titleSource === 'ai' ? 'ai' : 'manual',
        originalText: (n.originalText as string) ?? '',
        transcriptOriginal: (n.transcriptOriginal as string) ?? '',
        sourceText: (n.sourceText as string) ?? '',
        generatedContent: (n.generatedContent as string) ?? '',
        editedContent: (n.editedContent as string) ?? '',
        favorite: !!n.favorite,
        createdAt: n.createdAt as string,
        updatedAt: n.updatedAt as string,
        revision: n.revision as number,
        recordingId: null,
        transcriptNeedsReview: false,
      })
    }
  })
  const versions: NoteVersion[] = []
  ;(raw.versions as unknown[]).forEach((v, i) => {
    const where = `versions[${i}]`
    if (!isObj(v)) return void errors.push(`${where}가 객체가 아닙니다.`)
    if (!isStr(v.id) || !isStr(v.noteId) || !isStr(v.content) || !isStr(v.createdAt)) return void errors.push(`${where}의 필드(id/noteId/content/createdAt)가 올바르지 않습니다.`)
    if (!['source', 'generated', 'edited', 'proposal'].includes(v.kind as string)) return void errors.push(`${where}.kind가 올바르지 않습니다.`)
    versions.push(v as unknown as NoteVersion)
  })
  if (errors.length) return { ok: false, errors: errors.slice(0, 10) }
  return { ok: true, backup: { schemaVersion: 1, app: 'thinkbaro', exportedAt: isStr(raw.exportedAt) ? raw.exportedAt : nowIso(), recordingsIncluded: false, notes, versions } }
}

export interface ImportPlan {
  notes: Note[]
  versions: NoteVersion[]
  copied: number
  added: number
}
/** id가 겹치는 노트는 기존 것을 유지하고 새 id의 복사본으로 넣는다. */
export function planImport(b: Backup, existingNoteIds: Set<string>, existingVersionIds: Set<string>): ImportPlan {
  const idMap = new Map<string, string>()
  let copied = 0
  const notes = b.notes.map((n) => {
    if (existingNoteIds.has(n.id)) {
      const id = newId()
      idMap.set(n.id, id)
      copied++
      return { ...n, id }
    }
    return { ...n }
  })
  const versions = b.versions.map((v) => ({ ...v, id: existingVersionIds.has(v.id) ? newId() : v.id, noteId: idMap.get(v.noteId) ?? v.noteId }))
  return { notes, versions, copied, added: notes.length - copied }
}
