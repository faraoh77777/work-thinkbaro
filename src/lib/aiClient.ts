import type { AiStatus, ApiErrorBody, ApiErrorCode, ComposeRequest, ComposeResponse, TitleRequest, TitleResponse, TranscribeResponse } from '../../shared/api'

export class ApiError extends Error {
  constructor(
    public code: ApiErrorCode,
    message: string,
    public retryable: boolean,
  ) {
    super(message)
  }
}

export interface AiClient {
  status(): Promise<AiStatus>
  title(req: TitleRequest, signal?: AbortSignal): Promise<TitleResponse>
  compose(req: ComposeRequest, signal?: AbortSignal): Promise<ComposeResponse>
  transcribe(audio: Blob, meta: { jobId: string; chunkIndex: number; locale: string }, signal?: AbortSignal): Promise<TranscribeResponse>
}

async function request<T>(url: string, init: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, init)
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw new ApiError('cancelled', '요청을 취소했습니다.', false)
    throw new ApiError('network', '서버에 연결하지 못했습니다. 연결 상태를 확인하고 다시 시도하세요.', true)
  }
  if (!res.ok) {
    let body: Partial<ApiErrorBody> = {}
    try {
      body = (await res.json()) as Partial<ApiErrorBody>
    } catch {
      /* 본문이 JSON이 아님 */
    }
    throw new ApiError(body.code ?? 'provider_error', body.message ?? `서버가 오류를 돌려주었습니다(${res.status}).`, body.retryable ?? res.status >= 500)
  }
  try {
    return (await res.json()) as T
  } catch {
    throw new ApiError('bad_response', '서버 응답 형식이 올바르지 않습니다. 다시 시도하세요.', true)
  }
}

const post = (body: unknown, signal?: AbortSignal): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal })

export const httpAiClient: AiClient = {
  status: () => request<AiStatus>('/api/status', {}),
  title: (req, signal) => request<TitleResponse>('/api/title', post(req, signal)),
  compose: (req, signal) => request<ComposeResponse>('/api/compose', post(req, signal)),
  transcribe: (audio, meta, signal) =>
    request<TranscribeResponse>('/api/transcribe', {
      method: 'POST',
      headers: { 'content-type': audio.type || 'audio/webm', 'x-job-id': meta.jobId, 'x-chunk-index': String(meta.chunkIndex), 'x-locale': meta.locale },
      body: audio,
      signal,
    }),
}
