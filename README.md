# AutoPay

**자율 지출 거버넌스 계층** — AI 에이전트가 사용자를 대신해 웹에서 상품을
검색·결제하되, 정책·감사·격리·통지로 사용자가 통제권과 가시성을 잃지 않게 한다.
주 타깃은 국내 결제 환경(카카오페이·토스페이·쿠팡).

핵심 설계·근거는 **[AGENTS.md](AGENTS.md)** (프로젝트 단일 기준), 현재 구현
상태는 **[docs/status.md](docs/status.md)**.

## 무엇을 하나

- **정책 통제**: 금액 한도(건당/일/월)·횟수·머천트·카테고리·결제수단을 정책으로.
  모든 결제는 정책 검증을 통과해야 실행된다.
- **비밀 격리**: 브로커는 원시 결제 비밀을 보관·입력하지 않는다. 최종 승인은
  폰(패턴 B) 또는 사전 승인 원터치(패턴 C, 쿠팡). "훔칠 게 없는" 설계.
- **감사·통지**: 모든 결제 시도를 감사 로그로, 완료/거절을 즉시 알림.
- **지정가 자동 구매**: Claude Code(MCP 스킬)가 상품·상한가 조건을 직접
  모니터링하다가 조건 충족 시 결제 요청(정책 게이트 경유).

## 구조

```
packages/shared              공용 Zod 스키마·타입(경계의 단일 진실, 브리지 프로토콜 포함)
packages/broker-extension    Chrome MV3 익스텐션(신뢰 영역)
  src/policy                 정책 엔진(순수 함수, 100% 커버리지)
  src/{audit,notify,refstore,executor,broker}  신뢰 코어(주입식·유닛테스트)
  src/platform                chrome 어댑터(kv/notify/page-bridge)
  src/bridge                  MCP 브리지 WS 클라이언트 + 도구 매핑(M2)
  src/background              합성 루트 + UI RPC
  entrypoints                 background · sidepanel · options (WXT/React)
packages/mcp-server           로컬 stdio MCP 서버 + WS 허브(M2, Claude Code용)
packages/agent-skill          Claude Code 쇼핑 스킬(SKILL.md)
docs/                         설계·스펙·규범 (spec/ 12종)
```

## 빠른 시작

> 사용자용 가이드 페이지: [`docs/site/index.html`](docs/site/index.html) (브라우저로 열기, 정적 단일 파일)

요구: Node 20+, pnpm 9, Chrome, Claude Code.

```bash
pnpm bootstrap   # 설치 → MCP 서버·익스텐션 빌드 → 브리지 토큰 준비(클립보드 복사)
```

이어서 수동 1회:

1. `chrome://extensions` → 개발자 모드 → "압축해제된 확장 프로그램 로드" →
   `packages/broker-extension/.output/chrome-mv3` (재빌드 후엔 새로고침 ⟳만)
2. AutoPay 옵션 → **MCP 브리지**에 토큰 붙여넣기(클립보드에 있음) → **결제 한도**
   저장(기본 0원 = 전부 거절)
3. 쿠팡에 직접 로그인 + 쿠팡 앱에서 원터치 결제 켜기
4. 이 폴더에서 Claude Code 실행(`.mcp.json`에 `autopay` 서버 등록돼 있음) →
   "이 노트북 스탠드 3만원 밑으로 사줘"

옵션 상단 **시작하기** 카드가 남은 단계를 보여준다. 패스프레이즈 잠금 해제는
카카오·토스(패턴 B)용 본인 식별 정보에만 필요하다 — 쿠팡만 쓰면 생략.
결제 중 쿠팡이 비밀번호를 재요구하면 알림이 오고, **본인이 결제 탭에서 직접**
입력하면 된다(AutoPay·에이전트는 비밀번호를 다루지 않는다).

에이전트 도구는 `open/read_page/click/fill/request_payment/get_payment_result/
get_policy_summary` 7개뿐이며, 결제는 항상 정책·확인·감사를 거친다
(`docs/spec/mcp-integration.md`).

## 개발

```bash
pnpm test               # 전체 유닛 테스트
pnpm typecheck          # 타입 체크
pnpm lint               # Biome
pnpm --filter @autopay/broker-extension dev     # WXT 개발 모드
pnpm --filter @autopay/broker-extension build   # 익스텐션 빌드(.output/chrome-mv3)
pnpm --filter @autopay/mcp-server build         # MCP 서버 번들(dist/index.js)
```

## 워크플로

기본 브랜치 `dev`. 기능 완결 단위 커밋 + Codex 리뷰(자세히는
[docs/methodology.md](docs/methodology.md)). 개발/테스트에 실제 카드·계정 금지.

## 상태

M0(스켈레톤)·M1(익스텐션)·M2(MCP 브리지 코어) 완료·검증. M3(실결제 라이브
셀렉터)·M4(빌링키)는 라이브 연결 잔여 — [docs/status.md](docs/status.md) 참조.
