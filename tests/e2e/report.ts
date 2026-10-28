import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'

// tests/e2e/out/results.json(실제 실행 결과)에서 docs/검증결과.md를 만든다. 수기 편집으로 결과를 바꾸지 않는다.
const out = path.resolve('tests/e2e/out')
const results = JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8')) as { id: string; title: string; status: string; evidence: string }[]
const env = JSON.parse(fs.readFileSync(path.join(out, 'env.json'), 'utf8')) as { chrome: string; node: string; os: string; at: string }
const sh = (c: string) => {
  try {
    return execSync(c, { encoding: 'utf8' }).trim()
  } catch {
    return '(없음)'
  }
}
const commit = sh('git rev-parse --short HEAD')
const dirty = sh('git status --porcelain').length > 0
const sum: Record<string, number> = {}
for (const r of results) sum[r.status] = (sum[r.status] ?? 0) + 1

const REQ: [string, string, string[], string][] = [
  ['REQ-001', '이름·브랜드', ['TC-001'], '구현 완료'],
  ['REQ-002', '세 가지 작성 종류', ['TC-002'], '구현 완료'],
  ['REQ-003', '음성 녹음과 재생', ['TC-003', 'TC-017', 'TC-018'], '구현 완료 — Chrome 가짜 장치로만 확인(실제 마이크·iOS/Android 미검증)'],
  ['REQ-004', '전문 음성 전사', ['TC-004'], '부분 완료 — 구현·UI 흐름(모의 AI)만 확인, 실제 전사 정확성 차단'],
  ['REQ-005', '제목 자동 생성·수정', ['TC-005', 'TC-019'], '구현 완료 — UI 흐름은 확인, 실제 AI 제목 품질은 미확인'],
  ['REQ-006', '단순메모 상세 정돈', ['TC-006'], '부분 완료 — 프롬프트·UI 구현, 실제 품질 검증 차단'],
  ['REQ-007', '아이디어 상세 작성', ['TC-007'], '부분 완료 — 프롬프트·UI 구현, 실제 품질 검증 차단'],
  ['REQ-008', '대본·스토리 문단 구성', ['TC-008'], '부분 완료 — 프롬프트·UI 구현, 실제 품질 검증 차단'],
  ['REQ-009', '앱 자체 글자 수 제한 없음', ['TC-009', 'TC-020'], '부분 완료 — 100,000자 왕복은 통과, 실제 제공자 한도 초과 장문(TC-020) 차단'],
  ['REQ-010', '지속 저장·임시 저장', ['TC-010', 'TC-021'], '구현 완료'],
  ['REQ-011', '목록·검색·필터·즐겨찾기', ['TC-011'], '구현 완료'],
  ['REQ-012', '내용 편집·버전 보존', ['TC-012', 'TC-022'], '구현 완료'],
  ['REQ-013', '실패·긴 작업 복구', ['TC-013', 'TC-023'], '구현 완료 — 429·타임아웃·잘못된 JSON·취소는 단위 테스트, UI는 실패 재개·잘림 이어쓰기'],
  ['REQ-014', '실제 AI 연동·비밀키 보호', ['TC-014', 'TC-024', 'TC-025'], '부분 완료 — 제공자 어댑터는 실제 호출 미검증(키 없음), 비밀키 비노출은 키 없는 구성 기준으로 확인'],
  ['REQ-015', '내보내기·가져오기·기존 보존', ['TC-015', 'TC-026'], '구현 완료'],
  ['REQ-016', '모바일 우선·접근성', ['TC-016', 'TC-027'], '부분 완료 — 5개 폭·키보드는 확인, 실제 iOS/Android 키보드·스크린리더 미검증'],
]
const byId = new Map(results.map((r) => [r.id, r]))
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')

const md = `# 검증 결과

- 검증 대상: 커밋 \`${commit}\`${dirty ? ' (+ 작업 트리 변경)' : ''}
- 실행 시각: ${env.at} (UTC) · Chrome ${env.chrome} · Node ${env.node} · ${env.os} · 데스크톱 헤드리스, 뷰포트는 TC별 명시
- 명령: \`npm run typecheck\` · \`npm test\` · \`npm run build\` · \`npm run test:e2e\`
- 요약: ${Object.entries(sum).map(([k, v]) => `${k} ${v}`).join(' / ')}  (전체 ${results.length}개)

> 이 결과의 한계: AI는 결정적 **모의 서버**(UI 흐름 확인용), 마이크는 Chrome **가짜 장치**입니다. 실제 AI가 필요한 TC는 "차단", 실제 모바일 기기 검증은 하지 않았습니다.
> UI(textarea) 입력의 개행 기준: 브라우저가 \`\\r\\n\`을 \`\\n\`으로 바꾸므로 e2e 픽스처는 LF만 씁니다. CRLF가 저장·백업 경로에서 그대로 보존되는지는 단위 테스트(\`tests/unit/core.test.ts\`)에서 확인합니다.

## TC별 결과

| TC | 항목 | 상태 | 실제 결과·증거 |
|---|---|---|---|
${results.map((r) => `| ${r.id} | ${cell(r.title)} | ${r.status} | ${cell(r.evidence)} |`).join('\n')}

증거 파일: \`tests/e2e/out/\` (results.json, 스크린샷 home-*.png·edit-*.png, 백업 JSON 등. 저장소에는 포함하지 않음)

## REQ 구현 상태

| REQ | 기능 | 관련 TC | 상태 |
|---|---|---|---|
${REQ.map(([id, name, tcs, st]) => `| ${id} | ${name} | ${tcs.map((t) => `${t}(${byId.get(t)?.status ?? '미실행'})`).join(', ')} | ${st} |`).join('\n')}

## 실패 이력(최초 실행에서 발견 → 수정 → 재검증)

| 발견 | 원인 | 수정 | 재검증 |
|---|---|---|---|
| TC-016 360px 홈 가로 넘침 55px, 검색 입력 40px | 툴바 그리드 자식 \`min-width:auto\`, 입력 높이 | \`.toolbar > * {min-width:0}\`, 입력 44px | 통과 |
| TC-016 360px 편집 화면 가로 넘침 401px | \`.screen\` 그리드 트랙이 긴 제목(nowrap) 폭으로 확장 | \`grid-template-columns: minmax(0,1fr)\` | 통과 |
| TC-027 첫 Tab이 건너뛰기 링크가 아님 | 첫 렌더에서 제목으로 초점 이동 | 앱 안에서 화면을 옮길 때만 초점 이동 | 통과 |
| TC-027 화면 전환 후 초점이 BODY | 노트 화면 비동기 로딩으로 제목 요소 교체 | 로딩 완료 뒤 제목으로 재초점 | 통과 |
| (단위) 전사 원본이 처음 저장 시 빈 값으로 덮임 | \`saveNote\`가 이전 빈 값을 강제 유지 | 이전 값이 있을 때만 유지 + 테스트 추가 | 통과 |
| (테스트 결함) TC-002/011/012/022/009/015/014 | 선택자 중복, 경합, \`fill\` 대용량 지연(순수 textarea도 10k자 2초), 텍스트 정규화 가정 | 하네스 수정(앱 동작 변경 아님) | 통과 |

## 남은 일·미확정

- 실제 AI 연결: 제공자·키·모델 미확정. \`server/providers.ts\`의 OpenAI·Anthropic 어댑터는 요청 형식을 알려진 공개 API 규격대로 작성했으나 **실제 호출·공식 문서 대조를 하지 않았습니다.** 키를 넣은 뒤 TC-004·006·007·008·020과 TC-014(서버 로그에 본문·원음·키 없음)를 실행해야 합니다.
- 실제 기기 검증: iOS Safari·Android Chrome의 MediaRecorder MIME, 키보드·안전 영역, 백그라운드 중단, 스크린리더는 미검증입니다.
- 배포: 로컬 전용입니다. 공개 호스트는 HTTPS와 인증·요청 제한·지출 한도 설계가 필요하며 아직 없습니다.
- 알려진 제약: 10분 단위로 녹음 구간을 나누므로 구간 전환 순간 수 ms 공백이 생길 수 있고, 원음 다운로드는 구간별 파일입니다.
`
fs.writeFileSync(path.resolve('docs/검증결과.md'), md)
console.log('docs/검증결과.md 생성', Object.entries(sum))
