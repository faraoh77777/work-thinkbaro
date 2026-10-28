import { useEffect, useState } from 'react'
import * as db from '../lib/db'
import { audioExt, downloadBlob, fmtBytes, fmtDuration, safeName } from '../lib/format'
import type { Recording } from '../lib/types'
import { Icon } from './Icon'

/** 저장된 원음을 구간별로 불러와 재생·다운로드한다. */
export function AudioPlayer({ rec, title }: { rec: Recording; title: string }) {
  const [urls, setUrls] = useState<{ index: number; url: string; blob: Blob }[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const made: string[] = []
    void (async () => {
      try {
        const out: { index: number; url: string; blob: Blob }[] = []
        for (const s of rec.segments) {
          const blob = await db.segmentBlob(rec, s.index)
          if (blob.size === 0) continue
          const url = URL.createObjectURL(blob)
          made.push(url)
          out.push({ index: s.index, url, blob })
        }
        if (alive) setUrls(out)
      } catch (e) {
        if (alive) setErr((e as Error).message)
      }
    })()
    return () => {
      alive = false
      made.forEach((u) => URL.revokeObjectURL(u))
    }
  }, [rec])

  if (err) return <p className="notice error" role="alert">원음을 불러오지 못했습니다: {err}</p>
  if (!urls) return <p className="muted">원음을 불러오는 중…</p>
  if (urls.length === 0) return <p className="notice">저장된 소리가 없습니다.</p>
  return (
    <div className="audio-list">
      {urls.map((u) => (
        <div key={u.index} className="audio-item">
          <div className="audio-meta">
            <strong>{urls.length > 1 ? `구간 ${u.index + 1}/${urls.length}` : '원음'}</strong>
            <span>{u.blob.type || rec.mimeType} · {fmtBytes(u.blob.size)}</span>
          </div>
          <audio controls preload="metadata" src={u.url} aria-label={`${title || '제목 없음'} 원음 ${urls.length > 1 ? `구간 ${u.index + 1}` : ''}`} />
          <button type="button" className="btn ghost" onClick={() => downloadBlob(u.blob, `생각바로_${safeName(title)}_원음${urls.length > 1 ? `_구간${u.index + 1}` : ''}.${audioExt(u.blob.type || rec.mimeType)}`)}>
            <Icon name="download" size={18} />원음 다운로드
          </button>
        </div>
      ))}
      <p className="muted small">길이 {fmtDuration(rec.durationMs)} · 원음은 JSON 백업에 포함되지 않으니 필요하면 여기서 따로 받아 두세요.</p>
    </div>
  )
}
