import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { transcribeAndApply } from '../lib/actions'
import { buildBackup, serializeBackup } from '../lib/backup'
import * as db from '../lib/db'
import { blankNote, ConflictError } from '../lib/db'
import { focusHeading, hasNavigated } from '../lib/focus'
import { downloadBlob, fmtDateTime, fmtTime, safeName } from '../lib/format'
import { findResumable, jobSummary, runCompose } from '../lib/jobs'
import { go, href, replace } from '../lib/router'
import { useApp } from '../lib/store'
import { buildTitleInput, cpLength, sha256 } from '../lib/text'
import type { AIJob, Draft, Note, NoteType, NoteVersion, Recording } from '../lib/types'
import { NOTE_TYPES, nowIso, TYPE_META } from '../lib/types'
import { AudioPlayer } from './AudioPlayer'
import { Icon } from './Icon'

type Fields = Pick<Note, 'type' | 'title' | 'titleSource' | 'sourceText' | 'generatedContent' | 'editedContent'>
const KEYS: (keyof Fields)[] = ['type', 'title', 'titleSource', 'sourceText', 'generatedContent', 'editedContent']
const pick = (n: Note): Fields => ({ type: n.type, title: n.title, titleSource: n.titleSource, sourceText: n.sourceText, generatedContent: n.generatedContent, editedContent: n.editedContent })
const same = (a: Fields, b: Fields) => KEYS.every((k) => a[k] === b[k])
const KEY_LABEL: Record<keyof Fields, string> = { type: '종류', title: '제목', titleSource: '제목', sourceText: '원문', generatedContent: '상세 작성본', editedContent: '내 수정본' }

type Tab = 'source' | 'generated' | 'edited' | 'versions'
type SaveState = { kind: 'clean' | 'dirty' | 'drafting' | 'drafted' | 'saving' | 'saved' | 'error'; at?: string; msg?: string }

export function NoteScreen({ noteId, newType }: { noteId: string; newType?: NoteType }) {
  const app = useApp()
  const { client, ai } = app
  const id = noteId

  const [base, setBase] = useState<Note | null>(null)
  const [exists, setExists] = useState(false)
  const [notFound, setNotFound] = useState(false)
  const [f, setF] = useState<Fields | null>(null)
  const [editing, setEditing] = useState(!!newType)
  const [tab, setTab] = useState<Tab>('source')
  const [save, setSave] = useState<SaveState>({ kind: 'clean' })
  const [versions, setVersions] = useState<NoteVersion[]>([])
  const [recs, setRecs] = useState<Recording[]>([])
  const [resumable, setResumable] = useState<AIJob | null>(null)
  const [conflict, setConflict] = useState<{ latest: Note; fields: (keyof Fields)[] } | null>(null)
  const [draftOffer, setDraftOffer] = useState<Draft | null>(null)
  const [draftLoaded, setDraftLoaded] = useState(false)
  const [titleBusy, setTitleBusy] = useState(false)
  const [titleSuggestion, setTitleSuggestion] = useState<string | null>(null)
  const [compose, setCompose] = useState<{ busy: boolean; done: number; total: number; error?: string }>({ busy: false, done: 0, total: 0 })
  const [trBusy, setTrBusy] = useState<string | null>(null)
  const [curHash, setCurHash] = useState('')
  const [compareId, setCompareId] = useState<string | null>(null)
  const [openVer, setOpenVer] = useState<string | null>(null)

  const fRef = useRef<Fields | null>(null)
  const baseRef = useRef<Note | null>(null)
  const titleEdits = useRef(0)
  const abort = useRef<AbortController | null>(null)
  fRef.current = f
  baseRef.current = base

  const dirty = !!f && !!base && (!exists || !same(f, pick(base)))

  // ── 불러오기 ──────────────────────────────────────────
  const refreshSide = useCallback(async () => {
    const [v, r, j] = await Promise.all([db.listVersions(id), db.listRecordings(), baseRef.current ? findResumable(baseRef.current) : Promise.resolve(null)])
    setVersions(v)
    setRecs(r.filter((x) => x.noteId === id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)))
    setResumable(j)
  }, [id])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const n = await db.getNote(id)
        const d = await db.getDraft(id)
        if (!alive) return
        if (n) {
          setBase(n)
          setExists(true)
          let fields = pick(n)
          if (d && !same(d.fields, fields)) {
            if (d.baseRevision === n.revision) {
              fields = d.fields
              setDraftOffer(d)
              setEditing(true)
            } else setDraftOffer(d)
          }
          setF(fields)
          setTab(n.editedContent ? 'edited' : n.generatedContent ? 'generated' : 'source')
          if (!n.sourceText && !n.generatedContent && !n.editedContent) setEditing(true)
        } else if (newType) {
          const b = blankNote(newType, id)
          setBase(b)
          setF(pick(b))
        } else if (d) {
          const b = { ...blankNote(d.fields.type, id), ...d.fields }
          setBase({ ...b, revision: 0 })
          setF(d.fields)
          setEditing(true)
          setDraftOffer(d)
        } else {
          setNotFound(true)
        }
        setDraftLoaded(true)
      } catch (e) {
        if (alive) {
          setNotFound(true)
          app.toast((e as Error).message, 'error')
        }
      }
    })()
    return () => {
      alive = false
      abort.current?.abort()
    }
  }, [id, newType]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (base) void refreshSide()
  }, [base?.id, base?.revision]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!f) return
    let alive = true
    void sha256(f.sourceText).then((h) => alive && setCurHash(h))
    return () => {
      alive = false
    }
  }, [f?.sourceText]) // eslint-disable-line react-hooks/exhaustive-deps

  // 불러오기가 끝나 제목 요소가 바뀌면(앱 안에서 이동한 경우에만) 초점을 새 제목으로 보낸다.
  const ready = !!f && !!base
  useEffect(() => {
    if (ready && hasNavigated()) focusHeading()
  }, [ready])

  // ── 편집·임시 저장 ────────────────────────────────────
  const edit = useCallback((patch: Partial<Fields>) => {
    if (patch.title !== undefined && patch.titleSource === undefined) {
      patch.titleSource = 'manual'
      titleEdits.current++
    }
    setF((cur) => (cur ? { ...cur, ...patch } : cur))
  }, [])

  useEffect(() => {
    if (!f || !base || !draftLoaded) return
    if (!dirty) {
      setSave((s) => (s.kind === 'drafting' || s.kind === 'dirty' || s.kind === 'drafted' ? { kind: 'clean' } : s))
      return
    }
    setSave((s) => (s.kind === 'saving' || s.kind === 'error' ? s : { kind: 'drafting' }))
    const t = setTimeout(() => {
      const snapshot = f
      db.putDraft({ noteId: id, fields: snapshot, baseRevision: base.revision, savedAt: nowIso() })
        .then(() => setSave((s) => (s.kind === 'saving' ? s : { kind: 'drafted', at: nowIso() })))
        .catch((e: Error) => setSave({ kind: 'error', msg: `임시 저장 실패: ${e.message}` }))
    }, 800)
    return () => clearTimeout(t)
  }, [f, base, dirty, id, draftLoaded])

  // 저장되지 않은 변경이 있으면 이탈 경고
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty && save.kind !== 'drafted') e.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty, save.kind])

  // ── 저장 ──────────────────────────────────────────────
  /** 저장소의 최신 노트와 비교해 내가 건드리지 않은 필드는 최신 값을 받는다. 둘 다 바꾼 필드는 반환한다. */
  const mergeFrom = useCallback((oldBase: Note, latest: Note): (keyof Fields)[] => {
    const cur = fRef.current
    if (!cur) return []
    const ob = pick(oldBase)
    const lb = pick(latest)
    const next = { ...cur } as Record<string, unknown>
    const both: (keyof Fields)[] = []
    for (const k of KEYS) {
      if (cur[k] === ob[k]) next[k] = lb[k]
      else if (lb[k] !== ob[k] && cur[k] !== lb[k]) both.push(k)
    }
    setF(next as unknown as Fields)
    return both
  }, [])

  const persist = useCallback(
    async (fields: Fields, extra: Partial<Note> = {}): Promise<Note | null> => {
      const b = baseRef.current
      if (!b) return null
      setSave({ kind: 'saving' })
      try {
        const saved = await db.saveNote({ ...b, ...fields, ...extra }, exists ? b.revision : 0)
        await db.deleteDraft(id).catch(() => undefined)
        setBase(saved)
        baseRef.current = saved
        setF(fields)
        setExists(true)
        setDraftOffer(null)
        setConflict(null)
        setSave({ kind: 'saved', at: saved.updatedAt })
        app.announce(saved.id, saved.revision)
        void app.reload()
        if (!exists) replace(href.note(saved.id))
        return saved
      } catch (e) {
        if (e instanceof ConflictError) {
          const both = mergeFrom(b, e.latest)
          const cf = KEYS.filter((k) => fields[k] !== pick(e.latest)[k] && pick(b)[k] !== pick(e.latest)[k])
          setConflict({ latest: e.latest, fields: both.length ? both : cf })
          setSave({ kind: 'error', msg: '다른 곳에서 이 노트가 먼저 바뀌어 저장하지 않았습니다. 아래에서 처리 방법을 고르세요.' })
        } else {
          const msg = (e as Error).message
          setSave({ kind: 'error', msg })
          app.toast(`저장하지 못했습니다. ${msg} 입력한 내용은 화면에 그대로 있어요.`, 'error')
        }
        return null
      }
    },
    [app, exists, id, mergeFrom],
  )

  const doSave = async () => {
    if (!f) return
    const s = await persist(f)
    if (s) app.toast('저장했어요.')
  }

  /** 편집 필드와 별개인 노트 속성(즐겨찾기·전사 확인)을 최신 저장본 기준으로 바꾼다. */
  const patchNote = async (patch: Partial<Note>) => {
    try {
      const latest = await db.getNote(id)
      const b = baseRef.current
      if (!latest || !b) {
        if (patch.favorite !== undefined || patch.transcriptNeedsReview !== undefined) app.toast('먼저 한 번 저장해 주세요.', 'error')
        return
      }
      const saved = await db.saveNote({ ...latest, ...patch }, latest.revision)
      mergeFrom(b, saved)
      setBase(saved)
      baseRef.current = saved
      app.announce(saved.id, saved.revision)
      void app.reload()
    } catch (e) {
      app.toast((e as Error).message, 'error')
    }
  }

  // 다른 탭의 변경
  useEffect(
    () =>
      app.onRemoteChange((nid) => {
        if (nid !== id) return
        void (async () => {
          const latest = await db.getNote(id)
          const b = baseRef.current
          if (!latest || !b || latest.revision <= b.revision) return
          const both = mergeFrom(b, latest)
          setBase(latest)
          baseRef.current = latest
          if (both.length) {
            setConflict({ latest, fields: both })
            app.toast('다른 탭에서 이 노트가 바뀌었습니다. 겹치는 항목을 확인하세요.', 'error')
          } else app.toast('다른 탭의 변경을 반영했어요.')
        })()
      }),
    [app, id, mergeFrom],
  )

  const saveAsCopy = async () => {
    if (!f || !conflict) return
    try {
      const copy = { ...blankNote(f.type), ...f, title: `${f.title || '제목 없음'} (충돌 복사본)` }
      const saved = await db.saveNote(copy, 0)
      const l = conflict.latest
      await db.deleteDraft(id).catch(() => undefined)
      setBase(l)
      baseRef.current = l
      setF(pick(l))
      setConflict(null)
      setSave({ kind: 'clean' })
      void app.reload()
      app.announce(saved.id, saved.revision)
      app.toast('내 내용을 복사본 노트로 저장하고, 이 화면에는 최신 내용을 불러왔어요.')
    } catch (e) {
      app.toast((e as Error).message, 'error')
    }
  }
  const loadLatest = async () => {
    if (!f || !conflict) return
    await db.putDraft({ noteId: id, fields: f, baseRevision: baseRef.current?.revision ?? 0, savedAt: nowIso() }).catch(() => undefined)
    const l = conflict.latest
    setDraftOffer({ noteId: id, fields: f, baseRevision: l.revision - 1, savedAt: nowIso() })
    setBase(l)
    baseRef.current = l
    setF(pick(l))
    setConflict(null)
    setSave({ kind: 'clean' })
  }

  // ── AI: 제목 ──────────────────────────────────────────
  const aiText = (cur: Fields) => cur.sourceText.trim() || cur.editedContent.trim() || cur.generatedContent.trim()
  async function genTitle(): Promise<void> {
    const cur = fRef.current
    if (!cur || !ai?.textReady) return
    const text = aiText(cur)
    if (!text) return app.toast('먼저 본문을 입력해 주세요.', 'error')
    const mark = titleEdits.current
    setTitleBusy(true)
    try {
      const input = buildTitleInput(text, ai.chunkBudgetChars)
      const r = await client.title({ noteType: cur.type, sourceText: input.text, isIndex: input.isIndex, inputRevision: baseRef.current?.revision ?? 0 })
      const now = fRef.current!
      // 그 사이 사용자가 제목을 건드렸거나 이미 적은 제목이 있으면 덮어쓰지 않고 제안으로만 둔다.
      if (titleEdits.current === mark && (!now.title.trim() || now.titleSource === 'ai')) {
        setF({ ...now, title: r.title, titleSource: 'ai' })
        setTitleSuggestion(null)
      } else setTitleSuggestion(r.title)
    } catch (e) {
      app.toast(`제목을 만들지 못했습니다. ${(e as Error).message} 직접 입력할 수 있어요.`, 'error')
    } finally {
      setTitleBusy(false)
    }
  }

  // ── AI: 상세 작성 ─────────────────────────────────────
  async function runDetail(resume: AIJob | null) {
    const cur = fRef.current
    if (!cur || !ai?.textReady) return
    if (!cur.sourceText.trim()) return app.toast('작성할 원문을 먼저 입력해 주세요.', 'error')
    let note = baseRef.current!
    if (dirty || !exists) {
      const s = await persist(cur)
      if (!s) return
      note = s
    }
    abort.current = new AbortController()
    setCompose({ busy: true, done: 0, total: 0 })
    if (!cur.title.trim()) void genTitle()
    try {
      const { job, proposal } = await runCompose(note, { client, chunkBudget: ai.chunkBudgetChars, maxAudioBytes: ai.maxAudioBytes, signal: abort.current.signal, onProgress: (j) => setCompose({ busy: true, ...jobSummary(j) }) }, resume)
      const sum = jobSummary(job)
      setCompose({ busy: false, ...sum, error: job.status === 'completed' ? undefined : job.error })
      await refreshSide()
      if (proposal) {
        setTab('versions')
        setCompareId(proposal.id)
        app.toast('AI 작성 결과가 제안으로 도착했어요. 검토 후 적용하세요.')
      } else if (job.status !== 'completed') app.toast(job.error ?? '작성을 끝내지 못했습니다.', 'error')
    } catch (e) {
      setCompose({ busy: false, done: 0, total: 0, error: (e as Error).message })
      app.toast((e as Error).message, 'error')
    }
  }

  const applyProposal = async (p: NoteVersion) => {
    const cur = fRef.current
    if (!cur) return
    const patch: Partial<Fields> = p.target === 'source' ? { sourceText: cur.sourceText ? `${cur.sourceText}\n\n${p.content}` : p.content } : { generatedContent: p.content }
    const s = await persist({ ...cur, ...patch })
    if (s) {
      await db.putVersion({ ...p, status: 'applied' })
      setTab(p.target === 'source' ? 'source' : 'generated')
      await refreshSide()
      app.toast(p.target === 'source' ? '원문 끝에 추가했어요.' : '상세 작성본으로 적용했어요. 이전 글은 버전에 남아 있어요.')
    }
  }
  const dismissProposal = async (p: NoteVersion) => {
    await db.putVersion({ ...p, status: 'dismissed' })
    await refreshSide()
  }
  const restoreVersion = async (v: NoteVersion) => {
    const cur = fRef.current
    if (!cur) return
    const key = v.kind === 'source' ? 'sourceText' : v.kind === 'generated' ? 'generatedContent' : 'editedContent'
    const s = await persist({ ...cur, [key]: v.content })
    if (s) {
      setTab(v.kind === 'source' ? 'source' : v.kind === 'generated' ? 'generated' : 'edited')
      app.toast('이전 버전을 불러왔어요. 바뀌기 전 글은 버전에 남아 있어요.')
    }
  }

  // ── 전사 ──────────────────────────────────────────────
  const transcribe = async (rec: Recording) => {
    if (!ai?.transcribeReady) return
    abort.current = new AbortController()
    setTrBusy('전사하는 중…')
    try {
      const b = baseRef.current!
      if (dirty || !exists) {
        const s = await persist(fRef.current!)
        if (!s) return
      }
      const out = await transcribeAndApply({ client, ai, noteId: id, rec, signal: abort.current.signal })
      if (out.note) {
        const b2 = baseRef.current ?? b
        mergeFrom(b2, out.note)
        setBase(out.note)
        baseRef.current = out.note
        app.announce(out.note.id, out.note.revision)
        void app.reload()
        app.toast(out.proposal ? '전사 결과를 제안으로 남겼어요(기존 원문은 그대로).' : '글로 변환했어요. 원음과 대조해 확인해 주세요.')
        setTab(out.proposal ? 'versions' : 'source')
      } else app.toast(out.job.error ?? '전사를 끝내지 못했습니다.', 'error')
    } catch (e) {
      app.toast((e as Error).message, 'error')
    } finally {
      setTrBusy(null)
    }
  }

  // ── 내보내기 ──────────────────────────────────────────
  const best = f ? f.editedContent || f.generatedContent || f.sourceText : ''
  const exportTxt = () => {
    if (!f) return
    downloadBlob(new Blob([`${f.title || '제목 없음'}\n\n${best}`], { type: 'text/plain;charset=utf-8' }), `생각바로_${safeName(f.title)}.txt`)
  }
  const exportJson = async () => {
    const n = await db.getNote(id)
    if (!n) return app.toast('먼저 저장해 주세요.', 'error')
    downloadBlob(new Blob([serializeBackup(buildBackup([n], await db.listVersions(id)))], { type: 'application/json' }), `생각바로_${safeName(n.title)}.json`)
  }
  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      app.toast('복사했어요.')
    } catch {
      app.toast('복사하지 못했습니다. 글을 직접 선택해 복사하세요.', 'error')
    }
  }

  // ── 화면 ──────────────────────────────────────────────
  const cpCounts = useMemo(() => (f ? { source: cpLength(f.sourceText), generated: cpLength(f.generatedContent), edited: cpLength(f.editedContent) } : null), [f?.sourceText, f?.generatedContent, f?.editedContent]) // eslint-disable-line react-hooks/exhaustive-deps

  if (notFound)
    return (
      <div className="screen">
        <h1 tabIndex={-1}>글을 찾을 수 없어요</h1>
        <p>삭제되었거나 이 브라우저에 저장되지 않은 글입니다.</p>
        <a className="btn primary" href={href.home()}>
          홈으로
        </a>
      </div>
    )
  if (!f || !base || !cpCounts) return <div className="screen"><h1 tabIndex={-1}>불러오는 중…</h1></div>

  const pending = versions.filter((v) => v.kind === 'proposal' && v.status === 'pending')
  const history = versions.filter((v) => v.kind !== 'proposal' || v.status !== 'pending')
  const textReady = !!ai?.textReady
  const aiHint = !ai ? 'AI 서버에 연결되지 않았습니다.' : !ai.configured ? 'AI가 설정되지 않았습니다(설정 > AI 연결 상태).' : !ai.textReady ? 'AI 글 작성 모델이 설정되지 않았습니다.' : ''
  const saveLabel =
    save.kind === 'saving'
      ? '저장하는 중…'
      : save.kind === 'saved'
        ? `저장됨 ${save.at ? fmtTime(save.at) : ''}`
        : save.kind === 'drafting'
          ? '임시 저장 중…'
          : save.kind === 'drafted'
            ? `임시 저장됨 ${save.at ? fmtTime(save.at) : ''} · 아직 직접 저장 전`
            : save.kind === 'error'
              ? '저장 실패'
              : dirty
                ? '저장하지 않은 변경 있음'
                : exists
                  ? '저장된 글'
                  : '새 글'
  const readText = tab === 'source' ? f.sourceText : tab === 'generated' ? f.generatedContent : f.editedContent

  return (
    <div className="screen note-screen">
      <header className="screen-head sticky">
        <a className="icon-btn" href={href.home()} aria-label="목록으로 돌아가기">
          <Icon name="back" />
        </a>
        <h1 tabIndex={-1} className="head-title">
          {f.title || (exists ? '제목 없음' : '새로운 생각')}
        </h1>
        <button type="button" className={`icon-btn star ${base.favorite ? 'on' : ''}`} aria-pressed={base.favorite} aria-label="즐겨찾기" onClick={() => void patchNote({ favorite: !base.favorite })} disabled={!exists}>
          <Icon name="star" />
        </button>
        {editing ? (
          <button type="button" className="btn primary" onClick={() => void doSave()} disabled={save.kind === 'saving'}>
            <Icon name="check" size={18} />저장
          </button>
        ) : (
          <button type="button" className="btn primary" onClick={() => setEditing(true)}>
            <Icon name="pen" size={18} />편집
          </button>
        )}
      </header>

      <p className={`save-line ${save.kind}`} role="status" aria-live="polite">
        <span aria-hidden="true">{save.kind === 'error' ? '⚠' : save.kind === 'saved' ? '✓' : dirty ? '●' : '○'}</span> {saveLabel}
        {save.msg ? ` — ${save.msg}` : ''}
      </p>

      {save.kind === 'error' && !conflict && (
        <div className="notice error" role="alert">
          <strong>저장하지 못했습니다.</strong> 입력한 내용은 화면에 남아 있어요. 다시 저장해 보거나, 아래 방법으로 내용을 따로 보관하세요.
          <div className="actions-row">
            <button type="button" className="btn primary" onClick={() => void doSave()}>
              다시 저장
            </button>
            <button type="button" className="btn ghost" onClick={exportJson}>
              JSON으로 내보내기
            </button>
            <button type="button" className="btn ghost" onClick={exportTxt}>
              .txt로 내보내기
            </button>
            <button type="button" className="btn ghost" onClick={() => void copyText(`${f.title}\n\n${best}`)}>
              <Icon name="copy" size={18} />복사
            </button>
          </div>
        </div>
      )}

      {conflict && (
        <div className="notice error" role="alert">
          <strong>다른 탭/창에서 같은 노트를 먼저 바꿨어요.</strong>
          {conflict.fields.length > 0 && <> 겹친 항목: {[...new Set(conflict.fields.map((k) => KEY_LABEL[k]))].join(', ')}.</>} 아무것도 덮어쓰지 않았습니다.
          <div className="actions-row">
            <button type="button" className="btn primary" onClick={() => void saveAsCopy()}>
              내 내용을 복사본 노트로 저장
            </button>
            <button type="button" className="btn ghost" onClick={() => void loadLatest()}>
              최신 내용 불러오기 (내 변경은 임시 저장본에 남김)
            </button>
          </div>
        </div>
      )}

      {draftOffer && (
        <div className="notice" role="status">
          {draftOffer.baseRevision === base.revision ? '임시 저장본을 불러왔어요. 아직 직접 저장하지 않은 내용입니다.' : '이 노트에 이전에 임시 저장해 둔 변경 내용이 있어요.'}
          <div className="actions-row">
            {draftOffer.baseRevision !== base.revision && (
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  setF(draftOffer.fields)
                  setEditing(true)
                  setDraftOffer(null)
                }}
              >
                임시 저장본 복원
              </button>
            )}
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                void db.deleteDraft(id)
                setF(pick(base))
                setDraftOffer(null)
              }}
            >
              임시 저장본 버리기
            </button>
          </div>
        </div>
      )}

      {base.transcriptNeedsReview && (
        <div className="notice" role="status">
          음성을 글로 변환한 결과입니다. 인식이 불확실한 부분은 원음과 대조해 고쳐 주세요.
          <div className="actions-row">
            <button type="button" className="btn ghost" onClick={() => void patchNote({ transcriptNeedsReview: false })}>
              확인했어요
            </button>
          </div>
        </div>
      )}

      <section className="field" aria-label="종류와 제목">
        {editing ? (
          <>
            <fieldset className="seg" aria-label="글의 종류">
              {NOTE_TYPES.map((t) => (
                <label key={t} className={f.type === t ? 'on' : ''}>
                  <input type="radio" name="ntype" checked={f.type === t} onChange={() => edit({ type: t })} />
                  {TYPE_META[t].name}
                </label>
              ))}
            </fieldset>
            <p className="muted small">{TYPE_META[f.type].hint}</p>
            {base.type !== f.type && (f.generatedContent || pending.length > 0) && <p className="muted small">종류를 바꿔도 기존 글과 녹음은 그대로예요. 다시 "자세히 작성"하면 이 종류의 지침으로 새 제안이 만들어집니다.</p>}
            <label className="lbl" htmlFor="title-in">
              제목
            </label>
            <div className="title-row">
              <input id="title-in" className="text-in" value={f.title} placeholder="제목을 직접 쓰거나 자동 생성하세요" onChange={(e) => edit({ title: e.target.value })} />
              <button type="button" className="btn ghost" onClick={() => void genTitle()} disabled={!textReady || titleBusy} aria-describedby="ai-hint">
                <Icon name="spark" size={18} />
                {titleBusy ? '만드는 중…' : '제목 자동 생성'}
              </button>
            </div>
            {f.titleSource === 'ai' && f.title && <p className="muted small">AI가 제안한 제목이에요. 직접 고치면 내 제목으로 보관됩니다.</p>}
          </>
        ) : (
          <>
            <span className={`chip ${f.type}`}>{TYPE_META[f.type].name}</span>
            <p className="muted small">
              {fmtDateTime(base.updatedAt)} 수정 · 글자 수(코드포인트) 원문 {cpCounts.source.toLocaleString()} / 상세 {cpCounts.generated.toLocaleString()} / 수정본 {cpCounts.edited.toLocaleString()}
            </p>
          </>
        )}
        {titleSuggestion && (
          <div className="suggest" role="status">
            <span>
              AI 제안 제목: <strong>{titleSuggestion}</strong>
            </span>
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                edit({ title: titleSuggestion, titleSource: 'ai' })
                setTitleSuggestion(null)
              }}
            >
              적용
            </button>
            <button type="button" className="btn ghost" onClick={() => setTitleSuggestion(null)}>
              닫기
            </button>
          </div>
        )}
        {!textReady && (
          <p id="ai-hint" className="muted small">
            {aiHint} 직접 쓰고 저장하는 기능은 그대로 쓸 수 있어요.
          </p>
        )}
      </section>

      <div className="tabs-bar" role="tablist" aria-label="글 영역">
        {(
          [
            ['source', '원문'],
            ['generated', '상세 작성본'],
            ['edited', '내 수정본'],
            ['versions', `제안·버전${pending.length ? ` (${pending.length})` : ''}`],
          ] as [Tab, string][]
        ).map(([k, label]) => (
          <button key={k} type="button" role="tab" id={`tab-${k}`} aria-selected={tab === k} aria-controls="tabpanel" className={tab === k ? 'selected' : ''} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>

      <section id="tabpanel" role="tabpanel" aria-labelledby={`tab-${tab}`} className="panel">
        {tab === 'source' && (
          <>
            <p className="muted small">AI가 읽는 기준 글입니다. 직접 쓰거나, 음성 전사 결과를 보정하세요. ({cpCounts.source.toLocaleString()}자)</p>
            {editing ? <BigText id="src" label="원문" value={f.sourceText} placeholder={TYPE_META[f.type].placeholder} onChange={(v) => edit({ sourceText: v })} /> : <Reading text={readText} empty="원문이 비어 있어요. 편집을 눌러 적거나 녹음하세요." />}
            {base.transcriptOriginal && base.transcriptOriginal !== f.sourceText && (
              <details>
                <summary>음성 전사 원본 보기 (바뀌지 않는 원본)</summary>
                <Reading text={base.transcriptOriginal} />
              </details>
            )}
            {base.originalText && base.originalText !== f.sourceText && (
              <details>
                <summary>처음 직접 입력한 원본 보기</summary>
                <Reading text={base.originalText} />
              </details>
            )}
          </>
        )}
        {tab === 'generated' && (
          <>
            <p className="muted small">AI 제안을 적용한 글입니다. 직접 고치려면 "내 수정본"으로 복사해 시작하세요. ({cpCounts.generated.toLocaleString()}자)</p>
            <Reading text={f.generatedContent} empty="아직 상세 작성본이 없어요. 아래 '자세히 작성'을 눌러 보세요." />
            {f.generatedContent && (
              <div className="actions-row">
                <button type="button" className="btn ghost" onClick={() => (f.editedContent ? setTab('edited') : (edit({ editedContent: f.generatedContent }), setEditing(true), setTab('edited')))}>
                  내 수정본으로 시작
                </button>
                <button type="button" className="btn ghost" onClick={() => void copyText(f.generatedContent)}>
                  <Icon name="copy" size={18} />복사
                </button>
              </div>
            )}
          </>
        )}
        {tab === 'edited' && (
          <>
            <p className="muted small">내가 직접 다듬은 최종 글입니다. AI 결과가 이 글을 덮어쓰지 않습니다. ({cpCounts.edited.toLocaleString()}자)</p>
            {editing ? <BigText id="edt" label="내 수정본" value={f.editedContent} placeholder="상세 작성본을 바탕으로 직접 고쳐 쓰세요." onChange={(v) => edit({ editedContent: v })} /> : <Reading text={f.editedContent} empty="아직 내 수정본이 없어요." />}
          </>
        )}
        {tab === 'versions' && (
          <>
            {pending.length === 0 && <p className="muted">검토할 AI 제안이 없습니다.</p>}
            {pending.map((p) => (
              <ProposalCard key={p.id} p={p} stale={!!p.inputHash && p.inputHash !== curHash} current={f.generatedContent} source={f.sourceText} compare={compareId === p.id} onCompare={() => setCompareId(compareId === p.id ? null : p.id)} onApply={() => void applyProposal(p)} onDismiss={() => void dismissProposal(p)} />
            ))}
            <h2 className="h3">지난 버전</h2>
            {history.length === 0 && <p className="muted">아직 바뀐 기록이 없어요. 글이 바뀔 때마다 이전 글이 여기에 보관됩니다.</p>}
            <ul className="ver-list">
              {history.map((v) => (
                <li key={v.id}>
                  <div className="ver-head">
                    <strong>{v.kind === 'proposal' ? `${v.label ?? 'AI 제안'} (${v.status === 'applied' ? '적용됨' : '보류'})` : (v.label ?? v.kind)}</strong>
                    <span>{fmtDateTime(v.createdAt)}</span>
                    <button type="button" className="btn ghost" aria-expanded={openVer === v.id} onClick={() => setOpenVer(openVer === v.id ? null : v.id)}>
                      {openVer === v.id ? '접기' : '전체 보기'}
                    </button>
                    {v.kind !== 'proposal' && (
                      <button type="button" className="btn ghost" onClick={() => void restoreVersion(v)}>
                        이 버전으로 되돌리기
                      </button>
                    )}
                    {v.kind === 'proposal' && v.status === 'dismissed' && (
                      <button type="button" className="btn ghost" onClick={() => void putPending(v).then(refreshSide)}>
                        다시 검토
                      </button>
                    )}
                  </div>
                  {openVer === v.id && <Reading text={v.content} />}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="card-box" aria-labelledby="ai-h">
        <h2 id="ai-h" className="h3">
          AI로 정리
        </h2>
        <div className="actions-row">
          <button type="button" className="btn primary" onClick={() => void runDetail(null)} disabled={!textReady || compose.busy || !f.sourceText.trim()} aria-describedby="ai-hint2">
            <Icon name="spark" size={18} />
            {compose.busy ? '작성하는 중…' : '자세히 작성'}
          </button>
          {compose.busy && (
            <button type="button" className="btn ghost" onClick={() => abort.current?.abort()}>
              취소
            </button>
          )}
          {!compose.busy && resumable && resumable.status !== 'completed' && (
            <button type="button" className="btn ghost" onClick={() => void runDetail(resumable)}>
              {resumable.status === 'incomplete' ? '이어서 쓰기' : '실패한 구간부터 다시'} ({jobSummary(resumable).done}/{jobSummary(resumable).total}구간 완료)
            </button>
          )}
        </div>
        {compose.busy && (
          <p role="status">
            <progress max={Math.max(compose.total, 1)} value={compose.done} aria-label="작성 진행" /> {compose.total ? `${compose.done}/${compose.total}개 구간 완료` : '준비 중…'}
          </p>
        )}
        {!compose.busy && compose.error && (
          <p className="notice error" role="alert">
            {compose.error} (완료된 {compose.done}/{compose.total}개 구간은 보관되어 있고, 원문은 그대로예요.)
          </p>
        )}
        <p id="ai-hint2" className="muted small">
          {textReady ? '"자세히 작성"을 누르면 원문이 설정된 AI 서버로 전송됩니다. 요약하지 않고, 이 종류의 지침에 맞춰 자세히 씁니다. 결과는 "제안"으로 먼저 도착해요.' : `${aiHint}`}
        </p>
      </section>

      <section className="card-box" aria-labelledby="rec-h">
        <h2 id="rec-h" className="h3">
          원음 {recs.length > 0 && `(${recs.length}개)`}
        </h2>
        {recs.length === 0 && <p className="muted">이 글에 연결된 녹음이 없어요.</p>}
        {recs.map((r, i) => (
          <div key={r.id} className="rec-item">
            <p>
              <strong>녹음 {i + 1}</strong> · {fmtDateTime(r.createdAt)} {r.status !== 'saved' && <span className="chip plain">{r.status === 'interrupted' ? '중단됨(저장된 부분만)' : r.status === 'failed' ? '실패' : '녹음 중'}</span>}
            </p>
            {r.error && <p className="muted small">{r.error}</p>}
            {r.segments.length > 0 ? <AudioPlayer rec={r} title={f.title} /> : <p className="muted">저장된 소리가 없어요.</p>}
            {r.segments.length > 0 && (
              <button type="button" className="btn ghost" onClick={() => void transcribe(r)} disabled={!ai?.transcribeReady || !!trBusy}>
                <Icon name="pen" size={18} />
                {trBusy ?? '글로 변환'}
              </button>
            )}
            {r.segments.length > 0 && !ai?.transcribeReady && <p className="muted small">AI 음성 전사가 연결되지 않아 글로 변환할 수 없어요.</p>}
          </div>
        ))}
        <a className="btn ghost" href={href.record(f.type, exists ? id : undefined)} onClick={(e) => { if (!exists) { e.preventDefault(); void persist(f).then((s) => s && go(href.record(f.type, s.id))) } }}>
          <Icon name="mic" size={18} />
          녹음 추가
        </a>
      </section>

      <section className="card-box" aria-labelledby="exp-h">
        <h2 id="exp-h" className="h3">
          내보내기
        </h2>
        <div className="actions-row">
          <button type="button" className="btn ghost" onClick={exportTxt}>
            <Icon name="download" size={18} />글(.txt)
          </button>
          <button type="button" className="btn ghost" onClick={() => void exportJson()}>
            <Icon name="download" size={18} />이 노트 JSON
          </button>
        </div>
        <p className="muted small">JSON에는 원음이 포함되지 않아요. 원음은 위 "원음" 영역에서 따로 다운로드하세요.</p>
      </section>

      {editing && (
        <div className="bottom-bar">
          <button type="button" className="btn primary big" onClick={() => void doSave()} disabled={save.kind === 'saving'}>
            <Icon name="check" size={18} />저장
          </button>
          {exists && !dirty && (
            <button type="button" className="btn ghost big" onClick={() => setEditing(false)}>
              읽기 화면
            </button>
          )}
        </div>
      )}
    </div>
  )
}

async function putPending(v: NoteVersion): Promise<void> {
  await db.putVersion({ ...v, status: 'pending' })
}

function Reading({ text, empty }: { text: string; empty?: string }) {
  if (!text) return <p className="muted">{empty ?? '내용 없음'}</p>
  return (
    <div className="reading" tabIndex={0} role="region" aria-label="본문">
      {text}
    </div>
  )
}

/** 글자 수 제한(maxlength) 없는 긴 글 입력창 */
function BigText({ id, label, value, placeholder, onChange }: { id: string; label: string; value: string; placeholder: string; onChange: (v: string) => void }): ReactNode {
  return (
    <>
      <label className="sr-only" htmlFor={id}>
        {label}
      </label>
      <textarea id={id} className="big-text" lang="ko" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </>
  )
}

function ProposalCard({ p, stale, current, source, compare, onCompare, onApply, onDismiss }: { p: NoteVersion; stale: boolean; current: string; source: string; compare: boolean; onCompare: () => void; onApply: () => void; onDismiss: () => void }) {
  const toSource = p.target === 'source'
  return (
    <article className="proposal" aria-label="AI 제안">
      <header>
        <strong>{p.label ?? 'AI 제안'}</strong>
        <span className="muted small">{fmtDateTime(p.createdAt)}</span>
      </header>
      {stale && <p className="notice">이 제안을 만든 뒤 원문이 바뀌었어요. 지금 원문과 맞지 않을 수 있으니 내용을 확인하고 적용하세요.</p>}
      {compare ? (
        <div className="compare">
          <div>
            <h3 className="h4">{toSource ? '현재 원문' : '현재 상세 작성본'}</h3>
            <Reading text={toSource ? source : current} empty="(비어 있음)" />
          </div>
          <div>
            <h3 className="h4">제안</h3>
            <Reading text={p.content} />
          </div>
        </div>
      ) : (
        <Reading text={p.content} />
      )}
      <div className="actions-row">
        <button type="button" className="btn primary" onClick={onApply}>
          {toSource ? '원문 끝에 추가' : '상세 작성본으로 적용'}
        </button>
        <button type="button" className="btn ghost" onClick={onCompare} aria-pressed={compare}>
          {compare ? '비교 닫기' : '현재 글과 나란히 비교'}
        </button>
        <button type="button" className="btn ghost" onClick={onDismiss}>
          보류
        </button>
      </div>
    </article>
  )
}
