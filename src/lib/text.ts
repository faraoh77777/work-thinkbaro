// 글자 수는 Unicode 코드포인트 기준 "안내 수치"일 뿐 저장·입력 한도가 아니다.
export function cpLength(s: string): number {
  let n = 0
  for (const _ of s) {
    void _
    n++
  }
  return n
}

export async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export interface Chunk {
  index: number
  /** 코드포인트 위치 [start, end) */
  start: number
  end: number
  text: string
}

const isJoiner = (c: string | undefined): boolean => {
  if (!c) return false
  const cp = c.codePointAt(0)!
  return cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x1f3fb && cp <= 0x1f3ff)
}
const SENT_END = new Set(['.', '!', '?', '。', '！', '？', '…'])

/**
 * 원문을 손실 없이 순서대로 나눈다(모든 청크를 이으면 정확히 원문). 문단 → 줄 → 문장 → 공백 → 코드포인트 순으로 끊을 곳을 찾는다.
 * budget은 제공자 한도 때문에 정하는 "요청 단위"이며 제품 글자 수 제한이 아니다.
 */
export function planChunks(text: string, budget: number): Chunk[] {
  const cps = Array.from(text)
  const n = cps.length
  const out: Chunk[] = []
  if (n === 0) return out
  const b = Math.max(200, Math.floor(budget))
  let pos = 0
  while (pos < n) {
    let end = Math.min(n, pos + b)
    if (end < n) {
      const lo = pos + Math.floor(b * 0.5)
      let cut = -1
      for (let i = end; i > lo && cut < 0; i--) if (cps[i - 1] === '\n' && cps[i - 2] === '\n') cut = i
      for (let i = end; i > lo && cut < 0; i--) if (cps[i - 1] === '\n') cut = i
      for (let i = end; i > lo && cut < 0; i--) if (SENT_END.has(cps[i - 1]!) && (cps[i] === ' ' || cps[i] === '\n' || i === end)) cut = i
      for (let i = end; i > lo && cut < 0; i--) if (cps[i - 1] === ' ') cut = i
      if (cut > 0) end = cut
      else while (end > pos + 1 && (isJoiner(cps[end]) || isJoiner(cps[end - 1]))) end--
    }
    out.push({ index: out.length, start: pos, end, text: cps.slice(pos, end).join('') })
    pos = end
  }
  return out
}

export function tail(s: string, n: number): string {
  const a = Array.from(s)
  return a.length <= n ? s : a.slice(a.length - n).join('')
}
export function head(s: string, n: number): string {
  const a = Array.from(s)
  return a.length <= n ? s : a.slice(0, n).join('')
}

/** 긴 글의 제목 생성용 인덱스: 구간마다 앞부분을 발췌한다(제목 입력 전용이며 저장·생성에는 쓰지 않는다). */
export function buildTitleInput(text: string, budget: number): { text: string; isIndex: boolean } {
  if (cpLength(text) <= budget) return { text, isIndex: false }
  const chunks = planChunks(text, budget)
  const per = Math.max(200, Math.floor(budget / chunks.length) - 20)
  return { text: chunks.map((c) => `[구간 ${c.index + 1}/${chunks.length}]\n${head(c.text, per)}`).join('\n\n'), isIndex: true }
}

/** 이어붙이기: 구간 결과를 문단 단위로 결합한다(내용은 바꾸지 않고 끝 공백만 정리). */
export function joinOutputs(parts: string[]): string {
  return parts
    .map((p) => p.replace(/\s+$/u, ''))
    .filter((p) => p.length > 0)
    .join('\n\n')
}

/** 검색 정규화(한글 NFC, 대소문자 무시) */
export const norm = (s: string): string => s.normalize('NFC').toLowerCase()
