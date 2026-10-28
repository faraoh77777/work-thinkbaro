const KST = 'Asia/Seoul'
const dtf = new Intl.DateTimeFormat('ko-KR', { timeZone: KST, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
const tf = new Intl.DateTimeFormat('ko-KR', { timeZone: KST, hour: '2-digit', minute: '2-digit', hour12: false })

export const fmtDateTime = (iso: string): string => (Number.isNaN(Date.parse(iso)) ? '' : dtf.format(new Date(iso)))
export const fmtTime = (iso: string): string => tf.format(new Date(iso))

export function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = String(m).padStart(h ? 2 : 1, '0')
  return `${h ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}

export function audioExt(mime: string): string {
  const m = mime.toLowerCase()
  if (m.includes('webm')) return 'webm'
  if (m.includes('ogg')) return 'ogg'
  if (m.includes('mp4') || m.includes('aac') || m.includes('m4a')) return 'm4a'
  if (m.includes('wav')) return 'wav'
  return 'bin'
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export const safeName = (s: string): string => (s.trim() || '제목 없음').replace(/[\\/:*?"<>|\r\n]+/g, ' ').slice(0, 60)
