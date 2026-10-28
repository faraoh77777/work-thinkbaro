import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { createApp } from '../../server/app'
import { AiError } from '../../server/providers'
import type { AiAdapter } from '../../server/providers'

process.env.VITEST = 'true' // 서버 로그 끄기

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * UI 흐름 검증 전용 모의 AI. 실제 AI가 아니며, 이 서버로 통과한 시험은 실서비스 TC의 통과 근거가 아니다.
 * 본문 안의 표식으로 지연·실패·잘림을 재현한다.
 */
export function makeFakeAdapter(log: string[] = []): AiAdapter {
  const failedOnce = new Set<string>()
  let composeCount = 0
  return {
    name: 'e2e-fake',
    textReady: true,
    transcribeReady: true,
    async complete(system, user) {
      const src = /<source>\n([\s\S]*?)\n<\/source>/.exec(user)?.[1] ?? ''
      if (system.includes('제목을 짓는')) {
        log.push('title')
        if (src.includes('##SLOWTITLE##')) await sleep(2500)
        return { text: '모의 자동 제목', truncated: false }
      }
      log.push(`compose:${src.slice(0, 12).replace(/\s/g, '_')}`)
      if (src.includes('##SLOW##')) await sleep(2500)
      if (src.includes('##FAIL##') && !failedOnce.has(src)) {
        failedOnce.add(src)
        throw new AiError('rate_limited', '요청이 너무 많거나 사용 한도에 도달했습니다. 잠시 뒤 다시 시도하세요.', true, 429)
      }
      if (src.includes('##TRUNC##')) {
        if (!user.includes('[이 구간에서 지금까지 쓴 글')) return { text: `[모의 앞부분] ${src.slice(0, Math.floor(src.length / 2))}`, truncated: true }
        return { text: ` [모의 이어쓴 뒷부분] ${src.slice(Math.floor(src.length / 2))}`, truncated: false }
      }
      composeCount++
      return { text: `[모의 상세 작성 ${composeCount}]\n\n${src}`, truncated: false }
    },
    async transcribe(buf) {
      log.push(`transcribe:${buf.length}`)
      return '금요일 오후 세 시에 도면 두 장을 확인해. 비용은 아직 몰라. 회의는 취소하지 마.'
    },
  }
}

export interface Harness {
  url: string
  log: string[]
  close: () => void
}
export function serve(opts: { fake: boolean; chunkBudgetChars?: number; reasons?: string[] }): Promise<Harness> {
  const log: string[] = []
  const adapter: AiAdapter | null = opts.fake ? makeFakeAdapter(log) : null
  const app = createApp({ adapter, reasons: opts.reasons ?? [], chunkBudgetChars: opts.chunkBudgetChars, staticDir: path.resolve('dist') })
  return new Promise((resolve) => {
    const s: Server = app.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, log, close: () => s.close() }))
  })
}
