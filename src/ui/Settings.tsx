import { useEffect, useState } from 'react'
import { buildBackup, parseBackup, planImport, serializeBackup } from '../lib/backup'
import type { ImportPlan } from '../lib/backup'
import * as db from '../lib/db'
import { downloadBlob, fmtBytes } from '../lib/format'
import { migrateLegacy, scanLegacy } from '../lib/legacy'
import type { LegacyScan, MigrateResult } from '../lib/legacy'
import { useApp } from '../lib/store'
import { Icon } from './Icon'

export function Settings() {
  const app = useApp()
  const { ai, aiError, notes } = app
  const [usage, setUsage] = useState<string>('')
  const [persisted, setPersisted] = useState<boolean | null>(null)
  const [review, setReview] = useState<{ plan: ImportPlan; file: string } | null>(null)
  const [importErrors, setImportErrors] = useState<string[]>([])
  const [legacy, setLegacy] = useState<LegacyScan>(() => scanLegacy())
  const [migrated, setMigrated] = useState<MigrateResult | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void navigator.storage?.estimate?.().then((e) => setUsage(e.usage !== undefined ? `${fmtBytes(e.usage)} 사용${e.quota ? ` / 약 ${fmtBytes(e.quota)} 중` : ''}` : '')).catch(() => undefined)
    void navigator.storage?.persisted?.().then(setPersisted).catch(() => undefined)
  }, [notes.length])

  const exportAll = async () => {
    try {
      const [n, v] = await Promise.all([db.listNotes(), db.listAllVersions()])
      const d = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }).replaceAll('-', '')
      downloadBlob(new Blob([serializeBackup(buildBackup(n, v))], { type: 'application/json' }), `생각바로_백업_${d}.json`)
      app.toast(`글 ${n.length}개와 버전 ${v.length}개를 내보냈어요. 원음은 포함되지 않았습니다.`)
    } catch (e) {
      app.toast((e as Error).message, 'error')
    }
  }

  const pickFile = async (file: File | undefined) => {
    setReview(null)
    setImportErrors([])
    if (!file) return
    const text = await file.text()
    const v = parseBackup(text)
    if (!v.ok) return setImportErrors(v.errors)
    const [n, vs] = await Promise.all([db.listNotes(), db.listAllVersions()])
    setReview({ plan: planImport(v.backup, new Set(n.map((x) => x.id)), new Set(vs.map((x) => x.id))), file: file.name })
  }
  const confirmImport = async () => {
    if (!review) return
    setBusy(true)
    try {
      await db.importBundle(review.plan.notes, review.plan.versions)
      await app.reload()
      app.toast(`글 ${review.plan.notes.length}개를 가져왔어요(복사본 ${review.plan.copied}개).`)
      setReview(null)
    } catch (e) {
      app.toast(`가져오지 못했습니다. ${(e as Error).message} 기존 기록은 그대로예요.`, 'error')
    } finally {
      setBusy(false)
    }
  }
  const runMigrate = async () => {
    setBusy(true)
    try {
      const r = await migrateLegacy(legacy, await db.listNotes())
      setMigrated(r)
      await app.reload()
      app.toast(`이전 디자인의 글 ${r.imported}개를 가져왔어요. 이전 저장소는 그대로 두었습니다.`)
    } catch (e) {
      app.toast(`이관하지 못했습니다. ${(e as Error).message} 이전 저장소는 건드리지 않았어요.`, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="screen settings">
      <h1 tabIndex={-1}>설정·백업</h1>

      <section className="card-box" aria-labelledby="s-store">
        <h2 id="s-store" className="h3">이 브라우저에 저장돼요</h2>
        <p>글·버전·원음은 이 기기의 이 브라우저(IndexedDB)에만 저장됩니다. 클라우드에 올라가지 않고, 다른 기기와 동기화되지 않아요.</p>
        <p className="notice">브라우저 사이트 데이터를 지우거나 사생활 보호 모드를 쓰면 기록이 사라질 수 있어요. 중요한 글은 아래에서 주기적으로 백업하고, 원음은 따로 다운로드하세요.</p>
        <p className="muted small">
          저장된 글 {notes.length}개 {usage && `· ${usage}`} {persisted !== null && `· 자동 삭제 보호 ${persisted ? '켜짐' : '꺼짐'}`}
        </p>
        {persisted === false && navigator.storage?.persist && (
          <button type="button" className="btn ghost" onClick={() => void navigator.storage.persist().then(setPersisted)}>
            브라우저가 저장소를 자동으로 지우지 않도록 요청
          </button>
        )}
      </section>

      <section className="card-box" aria-labelledby="s-ai">
        <h2 id="s-ai" className="h3">AI 연결 상태</h2>
        {aiError && <p className="notice error" role="alert">{aiError}</p>}
        {ai && (
          <>
            <ul className="status-list">
              <li>
                <span aria-hidden="true">{ai.configured ? '✓' : '✕'}</span> 제공자: {ai.provider ?? '설정 안 됨'}
              </li>
              <li>
                <span aria-hidden="true">{ai.textReady ? '✓' : '✕'}</span> 제목·상세 작성: {ai.textReady ? '연결됨' : '연결 안 됨'}
              </li>
              <li>
                <span aria-hidden="true">{ai.transcribeReady ? '✓' : '✕'}</span> 음성 전문 전사: {ai.transcribeReady ? '연결됨' : '연결 안 됨'}
              </li>
            </ul>
            {ai.reasons.length > 0 && (
              <ul className="reasons">
                {ai.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
          </>
        )}
        <p className="muted small">AI 키·모델은 서버의 환경변수(AI_PROVIDER, AI_API_KEY, AI_TEXT_MODEL, AI_TRANSCRIBE_MODEL)로만 설정하며, 이 화면에는 비밀키를 입력하거나 표시하는 곳이 없어요. 연결되지 않아도 직접 쓰기·저장·검색·백업은 모두 쓸 수 있습니다.</p>
        <p className="muted small">"글로 변환", "자세히 작성", "제목 자동 생성"을 누른 순간에만 해당 원음/본문이 설정된 AI 서버로 전송됩니다.</p>
        <button type="button" className="btn ghost" onClick={() => void app.refreshAi()}>
          다시 확인
        </button>
      </section>

      <section className="card-box" aria-labelledby="s-backup">
        <h2 id="s-backup" className="h3">백업·복원</h2>
        <p className="notice">JSON 백업에는 <strong>글과 버전만</strong> 들어가고 <strong>녹음 원음은 포함되지 않아요</strong>. 원음은 각 글의 "원음" 영역에서 따로 다운로드하세요.</p>
        <div className="actions-row">
          <button type="button" className="btn primary" onClick={() => void exportAll()}>
            <Icon name="download" size={18} />전체 JSON 내보내기
          </button>
          <label className="btn ghost file-btn">
            <Icon name="upload" size={18} />JSON 가져오기
            <input type="file" accept="application/json,.json" onChange={(e) => { void pickFile(e.target.files?.[0]); e.target.value = '' }} />
          </label>
        </div>
        {importErrors.length > 0 && (
          <div className="notice error" role="alert">
            <strong>이 파일은 가져올 수 없어요. 아무것도 바뀌지 않았습니다.</strong>
            <ul>
              {importErrors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </div>
        )}
        {review && (
          <div className="notice" role="status">
            <strong>{review.file}</strong> — 글 {review.plan.notes.length}개, 버전 {review.plan.versions.length}개. 새로 추가 {review.plan.added}개
            {review.plan.copied > 0 && `, 같은 id가 이미 있어 복사본으로 추가 ${review.plan.copied}개 (기존 글은 그대로 유지)`}.
            <div className="actions-row">
              <button type="button" className="btn primary" disabled={busy} onClick={() => void confirmImport()}>
                가져오기 확정
              </button>
              <button type="button" className="btn ghost" onClick={() => setReview(null)}>
                취소
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="card-box" aria-labelledby="s-legacy">
        <h2 id="s-legacy" className="h3">이전 디자인에서 가져오기</h2>
        {legacy.found ? (
          <>
            <p>
              이 주소에서 이전 디자인의 기록 {legacy.total}건을 찾았어요{legacy.samples ? `(예시 글 ${legacy.samples}건 제외, 가져올 글 ${legacy.importable.length}건)` : ''}. 읽기만 하고 이전 저장소는 지우거나 바꾸지 않아요.
            </p>
            <button type="button" className="btn primary" disabled={busy || legacy.importable.length === 0} onClick={() => void runMigrate()}>
              가져오기
            </button>
            {migrated && (
              <p role="status" className="notice">
                가져옴 {migrated.imported}건 · 이미 가져온 글 {migrated.skippedExisting}건 건너뜀 · 원음 {migrated.audios}건{migrated.audioMissing ? ` (찾지 못한 원음 ${migrated.audioMissing}건)` : ''}
              </p>
            )}
          </>
        ) : (
          <>
            <p className="muted">이 주소에서는 이전 디자인의 기록이 발견되지 않았어요.</p>
            <p className="muted small">이전 디자인을 다른 주소에서 쓰셨다면 브라우저 저장소는 주소(origin)마다 따로라서 여기서 읽을 수 없어요. 그 화면에서 JSON으로 내보낸 뒤 위에서 가져오고, 음성은 별도 파일로 옮겨야 합니다.</p>
          </>
        )}
        <button type="button" className="btn ghost" onClick={() => setLegacy(scanLegacy())}>
          다시 찾기
        </button>
      </section>
    </div>
  )
}
