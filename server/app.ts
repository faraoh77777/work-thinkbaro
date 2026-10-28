import express from 'express'
import type { Request, Response, NextFunction } from 'express'
import type { AiAdapter } from './providers.js'
import { AiError } from './providers.js'
import { composeSystem, composeUser, titleSystem, TRANSCRIBE_PROMPT } from './prompts.js'
import type { AiStatus, ComposeRequest, ComposeResponse, NoteType, TitleRequest, TitleResponse, TranscribeResponse, ApiErrorBody } from '../shared/api.js'

export interface AppOptions {
  adapter: AiAdapter | null
  reasons?: string[]
  chunkBudgetChars?: number
  maxAudioBytes?: number
  rateLimitPerMin?: number
  staticDir?: string
}

const TYPES: NoteType[] = ['memo', 'idea', 'story']
const isType = (v: unknown): v is NoteType => TYPES.includes(v as NoteType)

function fail(res: Response, e: AiError) {
  const body: ApiErrorBody = { code: e.code, message: e.message, retryable: e.retryable }
  res.status(e.status).json(body)
}

function handle(res: Response, e: unknown) {
  if (res.headersSent) return
  if (e instanceof AiError) return fail(res, e)
  fail(res, new AiError('provider_error', '서버 오류가 발생했습니다.', true, 500))
}

export function createApp(opts: AppOptions) {
  const app = express()
  const budget = opts.chunkBudgetChars ?? 12000
  const maxAudio = opts.maxAudioBytes ?? 24 * 1024 * 1024
  const adapter = opts.adapter

  // 요청 제한: 익명 유료 API 프록시가 되지 않도록 IP당 분당 호출 수를 제한한다(글자 수 제한이 아님).
  const hits = new Map<string, number[]>()
  const limit = opts.rateLimitPerMin ?? 120
  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now()
    const ip = req.socket.remoteAddress ?? 'unknown'
    const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000)
    recent.push(now)
    hits.set(ip, recent)
    if (recent.length > limit) return fail(res, new AiError('rate_limited', '요청이 너무 많습니다. 잠시 뒤 다시 시도하세요.', true, 429))
    next()
  })

  // 본문·원음은 로그에 남기지 않는다. 메서드·경로·상태·소요시간만 기록한다.
  app.use('/api', (req, res, next) => {
    const t = Date.now()
    res.on('finish', () => {
      if (process.env.VITEST !== 'true') console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - t}ms`)
    })
    next()
  })

  const json = express.json({ limit: '64mb' })
  const raw = express.raw({ type: () => true, limit: maxAudio })

  app.get('/api/status', (_req, res) => {
    const body: AiStatus = {
      configured: !!adapter,
      provider: adapter?.name ?? null,
      textReady: !!adapter?.textReady,
      transcribeReady: !!adapter?.transcribeReady,
      chunkBudgetChars: budget,
      maxAudioBytes: maxAudio,
      reasons: opts.reasons ?? [],
    }
    res.json(body)
  })

  const abortOnClose = (req: Request, res: Response) => {
    const ac = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded) ac.abort()
    })
    req.on('aborted', () => ac.abort())
    return ac.signal
  }
  const need = (kind: 'text' | 'transcribe'): AiAdapter => {
    if (!adapter || (kind === 'text' ? !adapter.textReady : !adapter.transcribeReady)) {
      throw new AiError('not_configured', kind === 'text' ? 'AI(글 작성)가 연결되지 않았습니다.' : 'AI(음성 전사)가 연결되지 않았습니다.', false, 503)
    }
    return adapter
  }
  const bad = (m: string) => new AiError('bad_request', m, false, 400)

  app.post('/api/title', json, async (req, res) => {
    try {
      const b = (req.body ?? {}) as Partial<TitleRequest>
      if (!isType(b.noteType) || typeof b.sourceText !== 'string' || !b.sourceText.trim()) throw bad('제목을 만들 본문이 없습니다.')
      const a = need('text')
      const r = await a.complete(titleSystem(b.noteType, !!b.isIndex), `<source>\n${b.sourceText}\n</source>\n\n제목 한 줄만 출력하라.`, abortOnClose(req, res))
      const title = r.text
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find(Boolean)
        ?.replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g, '')
        .trim()
      if (!title) throw new AiError('bad_response', 'AI가 제목을 만들지 못했습니다. 다시 시도하세요.', true)
      const out: TitleResponse = { title, inputRevision: Number(b.inputRevision) || 0 }
      res.json(out)
    } catch (e) {
      handle(res, e)
    }
  })

  app.post('/api/compose', json, async (req, res) => {
    try {
      const b = (req.body ?? {}) as Partial<ComposeRequest>
      if (!isType(b.noteType) || typeof b.sourceText !== 'string' || !b.sourceText.trim()) throw bad('작성할 본문이 없습니다.')
      if (!Array.isArray(b.sourceRange) || b.sourceRange.length !== 2) throw bad('sourceRange가 필요합니다.')
      const a = need('text')
      const idx = Number(b.chunkIndex) || 0
      const cnt = Math.max(1, Number(b.chunkCount) || 1)
      const r = await a.complete(
        composeSystem(b.noteType, idx, cnt),
        composeUser({ sourceText: b.sourceText, previousSourceTail: b.previousSourceTail, previousOutputTail: b.previousOutputTail, continueFrom: b.continueFrom }),
        abortOnClose(req, res),
      )
      if (!r.text.trim() && !r.truncated) throw new AiError('bad_response', 'AI가 빈 응답을 보냈습니다. 다시 시도하세요.', true)
      const out: ComposeResponse = { text: r.text, truncated: r.truncated, coveredRange: [b.sourceRange[0], b.sourceRange[1]], inputRevision: Number(b.inputRevision) || 0 }
      res.json(out)
    } catch (e) {
      handle(res, e)
    }
  })

  app.post('/api/transcribe', raw, async (req, res) => {
    try {
      const a = need('transcribe')
      const buf = req.body as unknown
      if (!Buffer.isBuffer(buf) || buf.length === 0) throw bad('오디오 데이터가 없습니다.')
      const mime = String(req.headers['content-type'] ?? '').split(';')[0] || 'audio/webm'
      if (!mime.startsWith('audio/') && !mime.startsWith('video/')) throw bad('오디오 형식이 아닙니다.')
      const jobId = String(req.headers['x-job-id'] ?? '')
      const chunkIndex = Number(req.headers['x-chunk-index'] ?? 0)
      const locale = String(req.headers['x-locale'] ?? 'ko-KR')
      const text = await a.transcribe(buf, mime, locale, TRANSCRIBE_PROMPT, abortOnClose(req, res))
      const out: TranscribeResponse = { text, jobId, chunkIndex, complete: true }
      res.json(out)
    } catch (e) {
      handle(res, e)
    }
  })

  if (opts.staticDir) app.use(express.static(opts.staticDir))

  // 오류 핸들러(본문 크기 초과, JSON 파싱 오류 등)
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const e = err as { type?: string }
    if (e.type === 'entity.too.large') return fail(res, new AiError('payload_too_large', '요청이 한 번에 보낼 수 있는 크기를 넘었습니다. 구간을 나누어 보내세요.', false, 413))
    if (e.type === 'entity.parse.failed') return fail(res, bad('요청 형식이 올바르지 않습니다.'))
    fail(res, new AiError('provider_error', '서버 오류가 발생했습니다.', true, 500))
  })
  return app
}
