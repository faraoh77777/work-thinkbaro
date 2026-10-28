# 생각바로 — 떠오른 생각, 바로 글로.

음성이나 글로 떠오른 생각을 붙잡아 **단순메모 / 아이디어 / 대본·스토리**로 따로 정리하는 앱입니다.
요약하지 않고 자세히 쓰며, 원음·원문·AI 생성본·내 수정본을 따로 보관합니다.

- 프런트: React + TypeScript + Vite (모바일 우선 반응형)
- 저장: 이 브라우저의 IndexedDB (글·버전·원음 청크·작업 상태·임시 저장)
- 서버: Node.js + Express + TypeScript — AI 호출(전사·제목·상세 작성)만 담당, 비밀키는 서버 환경변수에만 둡니다
- 설계 문서: `docs/package/01_앱설계.md`, `02_개발지시.md`, `03_검증.md` · 검증 결과: `docs/검증결과.md`

## 실행

```bash
npm install
cp .env.example .env     # AI를 쓰려면 값을 채웁니다(없어도 직접 쓰기·저장·검색·백업은 모두 동작)
npm run dev              # 프런트 http://127.0.0.1:5173 + API 127.0.0.1:8787 (Vite가 /api를 프록시)
```

배포용 빌드와 실행:

```bash
npm run build            # 타입 검사 + 프런트(dist) + 서버(dist-server)
npm start                # http://127.0.0.1:8787 — dist 정적 파일과 /api를 함께 서빙
```

마이크는 보안 컨텍스트(`localhost` 또는 HTTPS)에서만 쓸 수 있습니다.

## AI 연결 (선택)

`.env` (서버 전용, 프런트로 전달되지 않음):

| 변수 | 설명 |
|---|---|
| `AI_PROVIDER` | `openai` 또는 `anthropic` (anthropic은 글 작성만 지원, 음성 전사는 openai) |
| `AI_API_KEY` | 제공자 API 키 |
| `AI_TEXT_MODEL` | 제목·상세 작성 모델 이름 (제공자 공식 문서에서 확인해 채움) |
| `AI_TRANSCRIBE_MODEL` | 음성 전사 모델 이름 (openai) |
| `AI_CHUNK_CHARS` / `AI_MAX_AUDIO_BYTES` | 선택: 긴 글 구간 크기 / 전사 오디오 최대 바이트 |

설정이 비어 있으면 설정 화면과 버튼에 "연결 안 됨"으로 표시되고, AI 결과를 흉내 내지 않습니다.
**"글로 변환", "자세히 작성", "제목 자동 생성"을 누른 순간에만** 해당 원음/본문이 설정된 AI 서버로 전송됩니다.
익명 공개 호스트에 그대로 올리면 누구나 유료 API를 쓰게 되므로, 공개 전에 인증·요청 제한·지출 한도를 먼저 설계해야 합니다(기본 바인딩은 `127.0.0.1`).

## 폴더

```
src/lib      저장소(db.ts)·텍스트 분할(text.ts)·AI 작업 실행기(jobs.ts)·녹음(recorder.ts)·백업(backup.ts)·이전 디자인 이관(legacy.ts)
src/ui       화면: Home / NoteScreen / RecordScreen / Settings
server       Express API + 제공자 어댑터(providers.ts) + 종류별 프롬프트(prompts.ts)
shared       클라이언트·서버 공용 API 계약
tests/unit   vitest 단위 테스트   ·   tests/e2e  Playwright(Chrome) 브라우저 검증 + 모의 AI 서버
```

## 테스트

```bash
npm run typecheck
npm test                 # 단위 테스트(저장·분할·백업·작업 재개·서버 계약·프롬프트)
npm run build && npm run test:e2e   # 실제 Chrome으로 03_검증.md의 TC 실행 → tests/e2e/out/results.json
npm run test:report      # results.json → docs/검증결과.md
```

e2e는 설치된 Chrome/Edge를 씁니다. AI는 결정적인 **모의 서버**라서 UI 흐름만 확인하며, 실제 AI가 필요한 TC는 "차단"으로 남깁니다.

## 데이터와 백업

- 글·원음은 이 브라우저에만 저장됩니다(클라우드·다기기 동기화 없음). 사이트 데이터를 지우면 사라지므로 설정 > 백업을 주기적으로 쓰세요.
- JSON 백업에는 **글과 버전만** 들어가고 녹음 원음은 포함되지 않습니다. 원음은 각 글에서 따로 다운로드합니다.
- 같은 주소(origin)에서 쓰던 이전 디자인 기록(`mindbook-notes-v1`, `mindbook-audio`)은 설정에서 읽기 전용으로 가져옵니다. 이전 저장소는 지우지 않습니다.
- 이번 범위에는 영구 삭제·계정·동기화·결제가 없습니다.
