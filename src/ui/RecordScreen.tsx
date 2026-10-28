import { useEffect, useMemo, useRef, useState } from 'react'
import { transcribeAndApply } from '../lib/actions'
import * as db from '../lib/db'
import { blankNote } from '../lib/db'
import { fmtDuration } from '../lib/format'
import type { RecState } from '../lib/recorder'
import { checkSupport, RecordingSession } from '../lib/recorder'
import { go, href } from '../lib/router'
import { useApp } from '../lib/store'
import type { Note, NoteType, Recording } from '../lib/types'
import { newId, NOTE_TYPES, TYPE_META } from '../lib/types'
import { AudioPlayer } from './AudioPlayer'
import { Icon } from './Icon'

const LABEL: Record<RecState, string> = {
  idle: '녹음 준비됨',
  requesting: '마이크 권한을 요청하는 중…',
  recording: '녹음 중',
  paused: '일시정지됨',
  stopping: '저장하는 중…',
  saved: '녹음이 저장되었습니다',
  failed: '녹음에 실패했습니다',
  interrupted: '녹음이 중단되었습니다',
}

export function RecordScreen({ type: initialType, noteId }: { type: NoteType; noteId?: string }) {
  const app = useApp()
  const support = useMemo(checkSupport, [])
  const [type, setType] = useState<NoteType>(initialType)
  const [state, setState] = useState<RecState>('idle')
  const [detail, setDetail] = useState<string | undefined>()
  const [elapsed, setElapsed] = useState(0)
  const [rec, setRec] = useState<Recording | null>(null)
  const [targetId, setTargetId] = useState<string | null>(noteId ?? null)
  const [busy, setBusy] = useState<string | null>(null)
  const session = useRef<RecordingSession | null>(null)
  const abort = useRef<AbortController | null>(null)
  const typeRef = useRef(type)
  typeRef.current = type

  const active = state === 'recording' || state === 'paused' || state === 'requesting' || state === 'stopping'

  // 화면을 떠나면 마이크를 놓는다(저장된 청크는 남는다). 새로고침·탭 닫기는 경고한다.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (session.current && (session.current.state === 'recording' || session.current.state === 'paused')) e.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => {
      window.removeEventListener('beforeunload', warn)
      abort.current?.abort()
      void session.current?.abandon()
    }
  }, [])

  async function start() {
    setDetail(undefined)
    setRec(null)
    setElapsed(0)
    try {
      // 녹음과 연결된 노트를 먼저 만든다 → 중간에 앱이 끊겨도 원음이 노트에 남는다.
      const recId = newId()
      let note: Note
      if (noteId) {
        const existing = await db.getNote(noteId)
        if (!existing) throw new Error('노트를 찾지 못했습니다.')
        note = await db.saveNote({ ...existing, recordingId: recId }, existing.revision)
      } else if (targetId) {
        const existing = await db.getNote(targetId)
        note = existing ? await db.saveNote({ ...existing, type: typeRef.current, recordingId: recId }, existing.revision) : await db.saveNote({ ...blankNote(typeRef.current, targetId), recordingId: recId }, 0)
      } else {
        note = await db.saveNote({ ...blankNote(typeRef.current), recordingId: recId }, 0)
      }
      setTargetId(note.id)
      app.announce(note.id, note.revision)
      void app.reload()
      const s = new RecordingSession(
        note.id,
        recId,
        {
          onState: (st, d) => {
            setState(st)
            setDetail(d)
            if (st === 'saved' || st === 'interrupted' || st === 'failed') setRec({ ...s.recording, segments: [...s.recording.segments] })
          },
          onTick: setElapsed,
        },
        support.mimeType ?? '',
      )
      session.current = s
      await s.start()
    } catch (e) {
      setState('failed')
      setDetail((e as Error).message)
    }
  }

  async function transcribe() {
    if (!rec || !targetId || !app.ai) return
    abort.current = new AbortController()
    setBusy('전사하는 중… 시간이 걸릴 수 있어요.')
    try {
      const out = await transcribeAndApply({ client: app.client, ai: app.ai, noteId: targetId, rec, signal: abort.current.signal })
      if (out.note) {
        app.announce(out.note.id, out.note.revision)
        await app.reload()
        app.toast('글로 변환했어요. 원음과 대조해 확인해 주세요.')
        go(href.note(targetId))
      } else {
        app.toast(out.job.error ?? '전사를 끝내지 못했습니다.', 'error')
      }
    } catch (e) {
      app.toast((e as Error).message, 'error')
    } finally {
      setBusy(null)
    }
  }

  const hasAudio = !!rec && rec.segments.length > 0
  const canTranscribe = !!app.ai?.transcribeReady

  return (
    <div className="screen record">
      <header className="screen-head">
        <a className="icon-btn" href={targetId ? href.note(targetId) : href.home()} aria-label="돌아가기">
          <Icon name="back" />
        </a>
        <h1 tabIndex={-1}>음성으로 담기</h1>
      </header>

      {!support.ok ? (
        <div className="notice error" role="alert">
          <strong>녹음을 쓸 수 없는 환경입니다.</strong>
          <p>{support.reason}</p>
          <a className="btn primary" href={href.new(type)}>
            글로 직접 입력하기
          </a>
        </div>
      ) : (
        <>
          <fieldset className="seg" aria-label="글의 종류" disabled={state === 'recording' || state === 'paused' || state === 'stopping'}>
            {NOTE_TYPES.map((t) => (
              <label key={t} className={type === t ? 'on' : ''}>
                <input type="radio" name="type" checked={type === t} onChange={() => setType(t)} />
                {TYPE_META[t].name}
              </label>
            ))}
          </fieldset>

          <div className={`rec-panel state-${state}`}>
            <div className="rec-time" aria-hidden="true">
              {fmtDuration(elapsed)}
            </div>
            <p className="rec-state" role="status" aria-live="polite">
              <span className="rec-badge" aria-hidden="true">{state === 'recording' ? '●' : state === 'paused' ? '❚❚' : state === 'saved' ? '✓' : state === 'idle' ? '○' : '!'}</span>
              {LABEL[state]}
              {(state === 'recording' || state === 'paused') && <span className="sr-only"> 경과 시간 {fmtDuration(elapsed)}</span>}
            </p>
            {detail && (
              <p className={state === 'failed' ? 'notice error' : 'notice'} role="alert">
                {detail}
              </p>
            )}
            <div className="rec-actions">
              {(state === 'idle' || state === 'failed' || state === 'interrupted' || state === 'saved') && (
                <button type="button" className="btn primary big round" onClick={() => void start()}>
                  <Icon name="mic" />
                  {state === 'idle' ? '녹음 시작' : '다시 녹음'}
                </button>
              )}
              {state === 'recording' && (
                <button type="button" className="btn ghost big" onClick={() => session.current?.pause()}>
                  <Icon name="pause" />
                  일시정지
                </button>
              )}
              {state === 'paused' && (
                <button type="button" className="btn primary big" onClick={() => session.current?.resume()}>
                  <Icon name="play" />
                  계속 녹음
                </button>
              )}
              {(state === 'recording' || state === 'paused') && (
                <button type="button" className="btn danger big" onClick={() => void session.current?.stop()}>
                  <Icon name="stop" />
                  종료하고 저장
                </button>
              )}
            </div>
            {active && <p className="muted small">화면을 벗어나거나 다른 앱으로 전환하면 브라우저가 녹음을 멈출 수 있어요. 지금까지 받은 소리는 2초 단위로 저장됩니다.</p>}
          </div>

          {rec && hasAudio && (
            <section aria-labelledby="after-h" className="card-box">
              <h2 id="after-h">녹음한 원음</h2>
              <AudioPlayer rec={rec} title="" />
              <div className="actions-row">
                <button type="button" className="btn primary" disabled={!canTranscribe || !!busy} onClick={() => void transcribe()} aria-describedby="tr-note">
                  <Icon name="pen" />
                  {busy ? '변환 중…' : '글로 변환'}
                </button>
                {busy && (
                  <button type="button" className="btn ghost" onClick={() => abort.current?.abort()}>
                    취소
                  </button>
                )}
                {targetId && (
                  <a className="btn ghost" href={href.note(targetId)}>
                    노트로 이동
                  </a>
                )}
              </div>
              <p id="tr-note" className="muted small" role="status">
                {busy ??
                  (canTranscribe
                    ? '"글로 변환"을 누르면 이 원음이 설정된 AI 서버로 전송됩니다.'
                    : 'AI 음성 전사가 연결되지 않았습니다. 원음은 저장되어 있고, 노트에서 직접 글을 적을 수 있어요. (설정 > AI 연결 상태 참고)')}
              </p>
            </section>
          )}
        </>
      )}
    </div>
  )
}
