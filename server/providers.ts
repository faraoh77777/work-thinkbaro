import type { ApiErrorCode } from '../shared/api.js'

export class AiError extends Error {
  constructor(
    public code: ApiErrorCode,
    message: string,
    public retryable: boolean,
    public status = 502,
  ) {
    super(message)
  }
}

export interface Completion {
  text: string
  truncated: boolean
}
export interface AiAdapter {
  name: string
  textReady: boolean
  transcribeReady: boolean
  complete(system: string, user: string, signal: AbortSignal): Promise<Completion>
  transcribe(audio: Buffer, mime: string, locale: string, prompt: string, signal: AbortSignal): Promise<string>
}

const TIMEOUT_MS = 180_000

function mapHttp(status: number): AiError {
  if (status === 429) return new AiError('rate_limited', '요청이 너무 많거나 사용 한도에 도달했습니다. 잠시 뒤 다시 시도하세요.', true, 429)
  if (status === 408 || status === 504) return new AiError('timeout', 'AI 응답이 늦어 시간이 초과되었습니다. 다시 시도하세요.', true, 504)
  if (status === 401 || status === 403) return new AiError('provider_error', 'AI 제공자가 인증·권한을 거부했습니다. 서버의 키와 계정 상태를 확인하세요.', false)
  if (status >= 500) return new AiError('provider_error', 'AI 제공자 서버에 오류가 있습니다. 잠시 뒤 다시 시도하세요.', true)
  return new AiError('provider_error', 'AI 제공자가 요청을 처리하지 못했습니다(모델 이름·요청 형식·결제 한도를 확인하세요).', false)
}

async function call(url: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.any([signal, timeout]) })
  } catch {
    if (signal.aborted) throw new AiError('cancelled', '요청이 취소되었습니다.', false, 499)
    if (timeout.aborted) throw new AiError('timeout', 'AI 응답이 늦어 시간이 초과되었습니다. 다시 시도하세요.', true, 504)
    throw new AiError('network', 'AI 제공자에 연결하지 못했습니다.', true)
  }
  if (!res.ok) throw mapHttp(res.status)
  try {
    return await res.json()
  } catch {
    throw new AiError('bad_response', 'AI 응답 형식이 올바르지 않습니다. 다시 시도하세요.', true)
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

export class OpenAiAdapter implements AiAdapter {
  name = 'openai'
  textReady: boolean
  transcribeReady: boolean
  constructor(
    private key: string,
    private textModel: string,
    private transcribeModel: string,
  ) {
    this.textReady = !!textModel
    this.transcribeReady = !!transcribeModel
  }
  async complete(system: string, user: string, signal: AbortSignal): Promise<Completion> {
    const j = (await call(
      'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.key}` },
        body: JSON.stringify({
          model: this.textModel,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      },
      signal,
    )) as { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[] }
    const c = j.choices?.[0]
    const text = str(c?.message?.content)
    if (text === null) throw new AiError('bad_response', 'AI 응답에 본문이 없습니다. 다시 시도하세요.', true)
    return { text, truncated: c?.finish_reason === 'length' }
  }
  async transcribe(audio: Buffer, mime: string, locale: string, prompt: string, signal: AbortSignal): Promise<string> {
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(audio)], { type: mime }), `audio.${extFor(mime)}`)
    form.append('model', this.transcribeModel)
    form.append('language', locale.split('-')[0] ?? 'ko')
    form.append('prompt', prompt)
    form.append('response_format', 'json')
    const j = (await call(
      'https://api.openai.com/v1/audio/transcriptions',
      { method: 'POST', headers: { authorization: `Bearer ${this.key}` }, body: form },
      signal,
    )) as { text?: unknown }
    const text = str(j.text)
    if (text === null) throw new AiError('bad_response', '전사 응답에 본문이 없습니다. 다시 시도하세요.', true)
    return text
  }
}

export class AnthropicAdapter implements AiAdapter {
  name = 'anthropic'
  textReady: boolean
  transcribeReady = false
  constructor(
    private key: string,
    private textModel: string,
  ) {
    this.textReady = !!textModel
  }
  async complete(system: string, user: string, signal: AbortSignal): Promise<Completion> {
    const j = (await call(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': this.key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: this.textModel, max_tokens: 16000, system, messages: [{ role: 'user', content: user }] }),
      },
      signal,
    )) as { content?: { type?: unknown; text?: unknown }[]; stop_reason?: unknown }
    const text = (j.content ?? []).map((b) => (b.type === 'text' ? (str(b.text) ?? '') : '')).join('')
    if (!j.content || (!text && j.stop_reason !== 'max_tokens')) throw new AiError('bad_response', 'AI 응답에 본문이 없습니다. 다시 시도하세요.', true)
    return { text, truncated: j.stop_reason === 'max_tokens' }
  }
  async transcribe(): Promise<string> {
    throw new AiError('unsupported', '이 제공자는 음성 전사를 지원하지 않습니다.', false, 501)
  }
}

function extFor(mime: string): string {
  const m = mime.toLowerCase()
  if (m.includes('webm')) return 'webm'
  if (m.includes('ogg')) return 'ogg'
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a'
  if (m.includes('wav')) return 'wav'
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3'
  return 'webm'
}

export function adapterFromEnv(env: NodeJS.ProcessEnv): { adapter: AiAdapter | null; reasons: string[] } {
  const reasons: string[] = []
  const provider = (env.AI_PROVIDER ?? '').trim().toLowerCase()
  const key = (env.AI_API_KEY ?? '').trim()
  if (!provider) reasons.push('AI_PROVIDER가 설정되지 않았습니다.')
  if (!key) reasons.push('AI_API_KEY가 설정되지 않았습니다.')
  if (provider && provider !== 'openai' && provider !== 'anthropic') reasons.push(`지원하지 않는 제공자입니다: ${provider}`)
  if (reasons.length) return { adapter: null, reasons }
  const text = (env.AI_TEXT_MODEL ?? '').trim()
  const tr = (env.AI_TRANSCRIBE_MODEL ?? '').trim()
  if (!text) reasons.push('AI_TEXT_MODEL이 설정되지 않아 제목·상세 작성을 쓸 수 없습니다.')
  if (provider === 'openai' && !tr) reasons.push('AI_TRANSCRIBE_MODEL이 설정되지 않아 음성 전사를 쓸 수 없습니다.')
  if (provider === 'anthropic') reasons.push('anthropic 제공자는 음성 전사를 지원하지 않습니다(글 작성만 사용 가능).')
  return { adapter: provider === 'openai' ? new OpenAiAdapter(key, text, tr) : new AnthropicAdapter(key, text), reasons }
}
