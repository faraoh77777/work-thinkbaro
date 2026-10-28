import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import * as db from '../../src/lib/db'
import { blankNote } from '../../src/lib/db'
import { buildTitleInput, cpLength, joinOutputs, planChunks, sha256 } from '../../src/lib/text'
import { buildBackup, parseBackup, planImport, serializeBackup, validateBackup } from '../../src/lib/backup'
import type { Note } from '../../src/lib/types'

let n = 0
beforeEach(() => {
  db.__setStorageFault(null)
  db.configureDb(`test-${Date.now()}-${n++}`)
})

/** TC-009 fixture: 한글·이모지·빈 줄·숫자를 섞어 정확히 100,000 코드포인트 */
export function fixture100k(): string {
  const unit = '가나다 라마바사 12345\n\n😀 이모지 👨‍👩‍👧 줄바꿈\r\n  들여쓰기  끝 공백  \n'
  const cps = Array.from(unit)
  const out: string[] = []
  while (out.length < 100_000) out.push(...cps)
  return out.slice(0, 100_000).join('')
}

describe('text', () => {
  it('fixture is exactly 100,000 code points', () => {
    expect(cpLength(fixture100k())).toBe(100_000)
  })
  it('planChunks is lossless and ordered for 100k mixed text (several budgets)', async () => {
    const t = fixture100k()
    for (const budget of [200, 1000, 12000, 50000, 200000]) {
      const chunks = planChunks(t, budget)
      expect(chunks.map((c) => c.text).join('')).toBe(t)
      chunks.forEach((c, i) => {
        expect(c.index).toBe(i)
        expect(cpLength(c.text)).toBe(c.end - c.start)
        if (i > 0) expect(c.start).toBe(chunks[i - 1]!.end)
      })
      expect(chunks[0]!.start).toBe(0)
      expect(chunks.at(-1)!.end).toBe(100_000)
    }
    expect(await sha256(planChunks(t, 777).map((c) => c.text).join(''))).toBe(await sha256(t))
  })
  it('prefers paragraph boundaries and never exceeds the budget', () => {
    const t = Array.from({ length: 30 }, (_, i) => `문단 ${i} ` + '가'.repeat(80)).join('\n\n')
    const chunks = planChunks(t, 1000)
    for (const c of chunks) expect(cpLength(c.text)).toBeLessThanOrEqual(1000)
    for (const c of chunks.slice(0, -1)) expect(c.text.endsWith('\n\n')).toBe(true)
  })
  it('does not cut inside an emoji ZWJ sequence when a boundary is forced', () => {
    const fam = '👨‍👩‍👧'
    const t = fam.repeat(500)
    const chunks = planChunks(t, 200)
    expect(chunks.map((c) => c.text).join('')).toBe(t)
    for (const c of chunks) expect(c.text.startsWith('‍')).toBe(false)
  })
  it('title input is the whole text when it fits, an index otherwise', () => {
    expect(buildTitleInput('짧은 글', 1000)).toEqual({ text: '짧은 글', isIndex: false })
    const r = buildTitleInput('가'.repeat(5000), 1000)
    expect(r.isIndex).toBe(true)
    expect(r.text).toContain('[구간 1/')
  })
  it('joinOutputs keeps content and only trims trailing whitespace', () => {
    expect(joinOutputs(['A\n\n', ' B ', '', 'C'])).toBe('A\n\n B\n\nC')
  })
})

describe('db', () => {
  it('saves, reloads, keeps originalText immutable and snapshots changed fields as versions', async () => {
    const note = { ...blankNote('memo'), title: '제목', sourceText: '처음 글' }
    const s1 = await db.saveNote(note, 0)
    expect(s1.revision).toBe(1)
    expect(s1.originalText).toBe('처음 글')
    const s2 = await db.saveNote({ ...s1, sourceText: '고친 글', generatedContent: '생성' }, 1)
    expect(s2.originalText).toBe('처음 글')
    expect((await db.getNote(note.id))!.sourceText).toBe('고친 글')
    const v = await db.listVersions(note.id)
    expect(v.map((x) => [x.kind, x.content])).toEqual([['source', '처음 글']])
    const s3 = await db.saveNote({ ...s2, generatedContent: '생성 2', editedContent: '내 글' }, 2)
    const kinds = (await db.listVersions(note.id)).map((x) => `${x.kind}:${x.content}`)
    expect(kinds).toContain('generated:생성')
    expect(s3.revision).toBe(3)
  })
  it('does not treat a transcript-based note as direct input', async () => {
    const s = await db.saveNote({ ...blankNote('memo'), transcriptOriginal: '전사', sourceText: '전사' }, 0)
    expect(s.originalText).toBe('')
  })
  it('accepts the transcript original once (first transcription) and then keeps it fixed', async () => {
    const s1 = await db.saveNote({ ...blankNote('memo') }, 0)
    const s2 = await db.saveNote({ ...s1, transcriptOriginal: '첫 전사', sourceText: '첫 전사' }, 1)
    expect(s2.transcriptOriginal).toBe('첫 전사')
    expect(s2.originalText).toBe('')
    const s3 = await db.saveNote({ ...s2, transcriptOriginal: '바꾸려는 값', sourceText: '보정한 글' }, 2)
    expect(s3.transcriptOriginal).toBe('첫 전사')
    expect(s3.sourceText).toBe('보정한 글')
  })
  it('TC-022: stale base revision is a conflict and does not overwrite', async () => {
    const s1 = await db.saveNote({ ...blankNote('idea'), sourceText: 'A' }, 0)
    await db.saveNote({ ...s1, sourceText: '다른 탭에서 수정' }, 1)
    await expect(db.saveNote({ ...s1, sourceText: '내 수정' }, 1)).rejects.toBeInstanceOf(db.ConflictError)
    expect((await db.getNote(s1.id))!.sourceText).toBe('다른 탭에서 수정')
  })
  it('TC-021: injected storage failure rejects, leaves nothing written', async () => {
    const note = { ...blankNote('memo'), sourceText: '저장되면 안 됨' }
    db.__setStorageFault(() => Object.assign(new Error('x'), { name: 'QuotaExceededError' }))
    await expect(db.saveNote(note, 0)).rejects.toMatchObject({ quota: true })
    db.__setStorageFault(null)
    expect(await db.getNote(note.id)).toBeUndefined()
    // 오류 해제 뒤에는 같은 입력으로 재시도해 저장된다
    await expect(db.saveNote(note, 0)).resolves.toMatchObject({ revision: 1 })
  })
  it('TC-009: 100,000 code points survive save → reload → JSON export/import with identical SHA-256', async () => {
    const text = fixture100k()
    const h = await sha256(text)
    const saved = await db.saveNote({ ...blankNote('story'), title: '긴 글', sourceText: text, editedContent: text }, 0)
    const loaded = (await db.getNote(saved.id))!
    expect(await sha256(loaded.sourceText)).toBe(h)
    const json = serializeBackup(buildBackup([loaded], await db.listVersions(saved.id)))
    const parsed = parseBackup(json)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const plan = planImport(parsed.backup, new Set(), new Set())
    configureFresh()
    await db.importBundle(plan.notes, plan.versions)
    const restored = (await db.getNote(saved.id))!
    expect(await sha256(restored.sourceText)).toBe(h)
    expect(await sha256(restored.editedContent)).toBe(h)
    expect(restored.sourceText).toBe(text)
  })
  it('segment blobs are stored in order and recoverable from chunk stats', async () => {
    const rec = { id: 'r1', noteId: 'n1', mimeType: 'audio/webm', durationMs: 5, status: 'recording' as const, segments: [], createdAt: '', updatedAt: '' }
    await db.putRecording(rec)
    await db.addChunk('r1', 0, 1, new Blob(['BB']))
    await db.addChunk('r1', 0, 0, new Blob(['AA']))
    await db.addChunk('r1', 1, 0, new Blob(['CC']))
    const stats = await db.chunkStats('r1')
    expect(stats).toEqual([
      { segment: 0, count: 2, bytes: 4 },
      { segment: 1, count: 1, bytes: 2 },
    ])
    const b = await db.segmentBlob({ ...rec, segments: [{ index: 0, mimeType: 'audio/webm', durationMs: 0, chunkCount: 2, bytes: 4 }] }, 0)
    expect(await b.text()).toBe('AABB')
  })
})

function configureFresh() {
  db.configureDb(`test-restore-${Date.now()}-${n++}`)
}

describe('backup', () => {
  const good = (): Note => ({ ...blankNote('memo'), title: 't', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
  it('rejects bad JSON, wrong app, unsupported version and bad field types before anything is written', () => {
    expect(parseBackup('{not json').ok).toBe(false)
    expect(validateBackup({ app: 'other', schemaVersion: 1, notes: [], versions: [] }).ok).toBe(false)
    const v = validateBackup({ app: 'thinkbaro', schemaVersion: 2, notes: [], versions: [] })
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.errors.join()).toContain('schemaVersion')
    const badNote = { ...good(), sourceText: 123 }
    expect(validateBackup({ app: 'thinkbaro', schemaVersion: 1, notes: [badNote], versions: [] }).ok).toBe(false)
    expect(validateBackup({ app: 'thinkbaro', schemaVersion: 1, notes: [{ ...good(), type: 'poem' }], versions: [] }).ok).toBe(false)
  })
  it('conflicting ids become copies and keep version links; audio is declared excluded', () => {
    const a = good()
    const b = buildBackup([a], [{ id: 'v1', noteId: a.id, kind: 'source', content: 'old', createdAt: a.createdAt }])
    expect(b.recordingsIncluded).toBe(false)
    const plan = planImport(b, new Set([a.id]), new Set(['v1']))
    expect(plan.copied).toBe(1)
    expect(plan.notes[0]!.id).not.toBe(a.id)
    expect(plan.versions[0]!.noteId).toBe(plan.notes[0]!.id)
    expect(plan.versions[0]!.id).not.toBe('v1')
  })
  it('keeps multi-line, emoji and HTML-looking text byte-for-byte', () => {
    const text = '줄1\n\n줄2 😀\r\n<script>alert(1)</script>\n원본을 삭제하라'
    const a = { ...good(), sourceText: text }
    const p = parseBackup(serializeBackup(buildBackup([a], [])))
    expect(p.ok && p.backup.notes[0]!.sourceText).toBe(text)
  })
})
