// 클라이언트·서버가 공유하는 내부 API 계약 (02 개발지시 / 01 §7).
export type NoteType = 'memo' | 'idea' | 'story'

export interface AiStatus {
  configured: boolean
  provider: string | null
  textReady: boolean
  transcribeReady: boolean
  /** 청크 구성 기준(제공자 한도 때문에 나누는 단위이며 제품 글자 수 제한이 아님). 코드포인트 */
  chunkBudgetChars: number
  /** 전사 요청 1건에 보낼 수 있는 오디오 바이트 기준 */
  maxAudioBytes: number
  reasons: string[]
}

export interface TitleRequest {
  noteType: NoteType
  /** 본문 전체 또는 긴 글의 구간별 인덱스(구간 머리글 모음) */
  sourceText: string
  isIndex: boolean
  inputRevision: number
}
export interface TitleResponse {
  title: string
  inputRevision: number
}

export interface ComposeRequest {
  noteType: NoteType
  jobId: string
  chunkIndex: number
  chunkCount: number
  sourceText: string
  /** 원문 코드포인트 위치 [start, end) */
  sourceRange: [number, number]
  /** 이어쓰기 시 직전까지 이 구간에서 쓴 출력(끝 부분) */
  continueFrom?: string
  /** 앞 구간 원문의 끝 일부(문맥 참고용 — 출력에 다시 쓰지 않음) */
  previousSourceTail?: string
  /** 앞 구간 출력의 끝 일부(문체 연속용 — 출력에 다시 쓰지 않음) */
  previousOutputTail?: string
  inputRevision: number
}
export interface ComposeResponse {
  text: string
  /** 응답이 출력 한도로 잘렸으면 true → 이어쓰기 필요 */
  truncated: boolean
  coveredRange: [number, number]
  inputRevision: number
}

export interface TranscribeResponse {
  text: string
  jobId: string
  chunkIndex: number
  complete: boolean
}

export type ApiErrorCode =
  | 'not_configured'
  | 'unsupported'
  | 'rate_limited'
  | 'timeout'
  | 'bad_response'
  | 'provider_error'
  | 'bad_request'
  | 'payload_too_large'
  | 'cancelled'
  | 'network'
export interface ApiErrorBody {
  code: ApiErrorCode
  message: string
  retryable: boolean
}
