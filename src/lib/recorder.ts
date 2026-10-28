import * as db from './db'
import type { Recording, RecordingSegment } from './types'
import { nowIso } from './types'

export type RecState = 'idle' | 'requesting' | 'recording' | 'paused' | 'stopping' | 'saved' | 'failed' | 'interrupted'

/** 한 세그먼트의 길이(녹음 시간 기준). 녹음 길이 제한이 아니라, 전사 요청을 독립 파일로 나누기 위한 단위다. */
export const SEGMENT_MS = 10 * 60 * 1000
const TIMESLICE_MS = 2000
const CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/aac']

export interface RecSupport {
  ok: boolean
  mimeType: string | null
  reason?: string
}
export function checkSupport(): RecSupport {
  if (typeof window !== 'undefined' && !window.isSecureContext) return { ok: false, mimeType: null, reason: '보안 연결(HTTPS 또는 localhost)에서만 마이크를 쓸 수 있습니다.' }
  if (!navigator.mediaDevices?.getUserMedia) return { ok: false, mimeType: null, reason: '이 브라우저는 마이크 녹음을 지원하지 않습니다.' }
  if (typeof MediaRecorder === 'undefined') return { ok: false, mimeType: null, reason: '이 브라우저는 MediaRecorder를 지원하지 않습니다.' }
  const mime = CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m))
  // 지원 형식을 찾지 못해도 브라우저 기본 형식으로 시도할 수 있다(실제 형식은 녹음기가 알려 준다).
  return { ok: true, mimeType: mime ?? '' }
}

export function explainMicError(e: unknown): string {
  const name = (e as { name?: string })?.name
  if (name === 'NotAllowedError' || name === 'SecurityError') return '마이크 권한이 거부되었습니다. 브라우저 주소창의 사이트 설정에서 마이크를 허용한 뒤 다시 시도하세요. 글로 직접 입력해 저장할 수도 있어요.'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return '사용할 수 있는 마이크를 찾지 못했습니다. 마이크 연결을 확인하거나 글로 직접 입력하세요.'
  if (name === 'NotReadableError') return '마이크를 다른 앱이 사용 중이거나 읽을 수 없습니다. 다른 앱을 닫고 다시 시도하세요.'
  return '녹음을 시작하지 못했습니다. 글로 직접 입력해 저장할 수 있어요.'
}

export interface SessionEvents {
  onState: (s: RecState, detail?: string) => void
  onTick: (elapsedMs: number) => void
}

/** 녹음 세션. 청크가 올 때마다 IndexedDB에 저장해, 중단돼도 저장된 구간까지 재생·복구할 수 있다. */
export class RecordingSession {
  state: RecState = 'idle'
  elapsedMs = 0
  private stream: MediaStream | null = null
  private mr: MediaRecorder | null = null
  private rec: Recording
  private segIndex = 0
  private chunkIndex = 0
  private segStartMs = 0
  private lastTick = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private writes: Promise<void> = Promise.resolve()
  private writeError: Error | null = null
  private stopping = false
  private rotating = false
  private segBytes = 0
  private segChunks = 0

  constructor(
    noteId: string,
    recId: string,
    private ev: SessionEvents,
    private mimeHint: string,
  ) {
    const t = nowIso()
    this.rec = { id: recId, noteId, mimeType: mimeHint, durationMs: 0, status: 'recording', segments: [], createdAt: t, updatedAt: t }
  }

  get recording(): Recording {
    return this.rec
  }

  private set(s: RecState, detail?: string) {
    this.state = s
    this.ev.onState(s, detail)
  }

  async start(): Promise<void> {
    this.set('requesting')
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    } catch (e) {
      this.set('failed', explainMicError(e))
      return
    }
    const track = this.stream.getAudioTracks()[0]
    track?.addEventListener('ended', () => {
      if (this.state === 'recording' || this.state === 'paused') void this.finalize('interrupted', '마이크 연결이 끊겨 녹음이 중단되었습니다. 저장된 부분까지는 재생할 수 있어요.')
    })
    try {
      await db.putRecording(this.rec)
      this.startSegment()
    } catch (e) {
      this.cleanupStream()
      this.set('failed', (e as Error).message)
      return
    }
    this.lastTick = performance.now()
    this.timer = setInterval(() => this.tick(), 250)
    this.set('recording')
  }

  private startSegment() {
    const opts: MediaRecorderOptions = { audioBitsPerSecond: 64000 }
    if (this.mimeHint) opts.mimeType = this.mimeHint
    const mr = new MediaRecorder(this.stream!, opts)
    this.mr = mr
    this.chunkIndex = 0
    this.segBytes = 0
    this.segChunks = 0
    this.segStartMs = this.elapsedMs
    const seg = this.segIndex
    mr.ondataavailable = (ev) => {
      if (!ev.data || ev.data.size === 0) return
      const idx = this.chunkIndex++
      this.segBytes += ev.data.size
      this.segChunks++
      this.writes = this.writes.then(() => db.addChunk(this.rec.id, seg, idx, ev.data)).catch((e) => {
        this.writeError = e as Error
        void this.finalize('failed', `${(e as Error).message} 저장된 부분까지만 남습니다.`)
      })
    }
    mr.onstop = () => {
      if (!this.stopping && !this.rotating && (this.state === 'recording' || this.state === 'paused')) {
        void this.finalize('interrupted', '녹음이 예기치 않게 멈췄습니다(백그라운드 전환 등). 저장된 부분까지는 재생할 수 있어요.')
      }
    }
    mr.start(TIMESLICE_MS)
    if (!this.rec.mimeType || this.rec.mimeType !== mr.mimeType) this.rec.mimeType = mr.mimeType || this.mimeHint || 'audio/webm'
  }

  private async closeSegment(): Promise<void> {
    const mr = this.mr
    if (!mr) return
    await new Promise<void>((res) => {
      if (mr.state === 'inactive') return res()
      const prev = mr.onstop
      mr.onstop = (e) => {
        prev?.call(mr, e)
        res()
      }
      try {
        mr.stop()
      } catch {
        res()
      }
    })
    await this.writes
    if (this.segChunks > 0) {
      const seg: RecordingSegment = { index: this.segIndex, mimeType: mr.mimeType || this.rec.mimeType, durationMs: Math.round(this.elapsedMs - this.segStartMs), chunkCount: this.segChunks, bytes: this.segBytes }
      this.rec.segments = [...this.rec.segments.filter((s) => s.index !== seg.index), seg]
    }
    this.mr = null
  }

  private tick() {
    const now = performance.now()
    if (this.state === 'recording') {
      this.elapsedMs += now - this.lastTick
      this.ev.onTick(this.elapsedMs)
      if (this.elapsedMs - this.segStartMs >= SEGMENT_MS && !this.rotating && !this.stopping) void this.rotate()
    }
    this.lastTick = now
  }

  private async rotate() {
    this.rotating = true
    try {
      await this.closeSegment()
      this.segIndex++
      this.rec.durationMs = Math.round(this.elapsedMs)
      this.rec.updatedAt = nowIso()
      await db.putRecording(this.rec)
      this.startSegment()
    } catch (e) {
      void this.finalize('failed', (e as Error).message)
    } finally {
      this.rotating = false
    }
  }

  pause() {
    if (this.state !== 'recording' || !this.mr) return
    this.tick()
    this.mr.pause()
    this.set('paused')
  }
  resume() {
    if (this.state !== 'paused' || !this.mr) return
    this.lastTick = performance.now()
    this.mr.resume()
    this.set('recording')
  }

  async stop(): Promise<Recording> {
    if (this.state === 'recording' || this.state === 'paused') {
      this.tick()
      await this.finalize('saved')
    }
    return this.rec
  }

  private async finalize(end: 'saved' | 'interrupted' | 'failed', detail?: string): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    if (end === 'saved') this.set('stopping')
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    try {
      await this.closeSegment()
    } catch {
      /* 이미 닫힘 */
    }
    this.cleanupStream()
    this.rec.durationMs = Math.round(this.elapsedMs)
    this.rec.status = end
    this.rec.updatedAt = nowIso()
    if (detail) this.rec.error = detail
    try {
      await db.putRecording(this.rec)
      if (end === 'saved' && this.rec.segments.length === 0) {
        this.rec.status = 'failed'
        this.rec.error = '녹음된 소리가 저장되지 않았습니다.'
        await db.putRecording(this.rec)
        this.set('failed', this.rec.error)
        return
      }
      this.set(end, detail)
    } catch (e) {
      this.set('failed', (e as Error).message)
    }
    if (this.writeError && end === 'saved') this.set('failed', this.writeError.message)
  }

  /** 화면을 벗어날 때: 마이크를 해제한다(저장된 청크는 그대로 남는다). */
  async abandon(): Promise<void> {
    if (this.state === 'recording' || this.state === 'paused') await this.finalize('interrupted', '녹음 화면을 벗어나 중단되었습니다. 저장된 부분까지는 재생할 수 있어요.')
    this.cleanupStream()
  }

  private cleanupStream() {
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
  }
}

/** 앱 시작 시: 'recording' 상태로 남은 녹음(강제 종료 등)을 저장된 청크 기준으로 복구한다. 저장되지 않은 구간은 복구되지 않는다. */
export async function recoverInterrupted(): Promise<number> {
  const all = await db.listRecordings()
  let n = 0
  for (const r of all) {
    if (r.status !== 'recording') continue
    const stats = await db.chunkStats(r.id)
    const segments: RecordingSegment[] = stats.map((s) => ({ index: s.segment, mimeType: r.mimeType, durationMs: 0, chunkCount: s.count, bytes: s.bytes }))
    await db.putRecording({ ...r, segments, status: segments.length ? 'interrupted' : 'failed', error: '앱이 예기치 않게 종료되어 저장된 부분까지만 복구했습니다.', updatedAt: nowIso() })
    n++
  }
  return n
}
