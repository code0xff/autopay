# 개발 스택 (Tech Stack)

> 확정일: 2026-09-02. 변경 시 이 문서를 먼저 고치고 AGENTS.md와 동기화한다.
> 각 선택은 "왜"를 함께 기록해 문서만으로 재현 가능하게 한다.

## 요약 표

| 영역 | 선택 | 버전(핀) | 이유 |
|---|---|---|---|
| 언어 | TypeScript (strict) | 5.x | 타입 안전 + 익스텐션/노드 공용. `strict: true` 필수 |
| 패키지 매니저 | pnpm workspaces | 9.x | 모노레포 표준, 빠르고 엄격한 의존성 |
| 런타임 | Node.js LTS | 20.x (`.nvmrc`) | 빌드·테스트·MCP 서버 실행 |
| 익스텐션 프레임워크 | **WXT** | 0.x 최신 | MV3 전용, HMR·manifest 자동생성·entrypoint 규약. 익스텐션 DX 최고 |
| UI | React | 18.x | 옵션 페이지·승인 팝업. WXT React 모듈로 연동 |
| UI 컴포넌트 | shadcn/ui + Tailwind | 최신 | 기본 테마 **neutral**. **light/dark 토글 기본 탑재**(system 기본). Radix 기반 접근성 |
| UI 서체 | Geist / Geist Mono | — | shadcn 기본. 금액·시각·주문번호는 mono(`tabular-nums`) |
| UI 배치 | Side Panel + Options 탭 | — | **Side Panel(우측 도킹)=주 콘솔**, Options=전체 탭, `chrome.notifications`=알림. **Action popup 미사용**(포커스 상실 시 닫힘). 상세 `docs/spec/ui.md` |
| 스키마/검증 | Zod | 3.x | 신뢰 경계 메시지·정책 스키마의 런타임 검증 + 타입 추론 |
| 단위 테스트 | Vitest | 2.x | 정책 엔진 TDD. 빠르고 TS 네이티브 |
| E2E 테스트 | Playwright | 1.x | 익스텐션 로드(persistent context)로 결제 플로우 검증 |
| 린트/포맷 | Biome | 2.x | 린트+포맷 단일 도구, 빠름. (ESLint+Prettier 대안) |
| CI | GitHub Actions | — | typecheck + lint + test |

## 패키지 구성 (pnpm workspace)

`packages/` 아래. MVP는 **shared + broker-extension** 두 개에 집중하고,
나머지는 후속.

| 패키지 | 역할 | MVP 포함 |
|---|---|---|
| `shared` | Zod 스키마(브로커 API 메시지, 정책, 감사 레코드), 공용 타입 | ✅ |
| `broker-extension` | 신뢰 영역 MV3 익스텐션 (정책 엔진·executor·notify·audit·UI) | ✅ |
| `mcp-server` | 로컬 에이전트(Claude Code/Codex)용 MCP 서버 (Native Host) | 후속 |
| `agent-skill` | 에이전트 쇼핑 스킬(프롬프트+도구 정의) | 후속 |

## 에이전트 "뇌"의 위치 (M0 이후 결정, 지금 확정 아님)

플래그십 시나리오(지정가 감시 → 구매)는 프로그램적으로 트리거되는 에이전트
루프가 필요하다. M0(스키마+정책 엔진)은 여기에 의존하지 않으므로 결정을
미룰 수 있다. 두 후보:

1. **자체 에이전트 루프** — `@anthropic-ai/sdk`(TypeScript)로 Claude API 직접
   호출. 기본 모델 `claude-opus-5`, `thinking: {type: "adaptive"}`. 검색·
   네비게이션은 content script. 텔레그램 없이 익스텐션 자기완결.
2. **Claude for Chrome 등 외부 에이전트** — 사용자가 사이드바에서 구동. 단
   프로그램적 트리거가 안 돼 지정가 자동 감시 시나리오와는 안 맞음.

→ 플래그십(자동 감시)을 살리려면 **1번(자체 루프)** 가 유력. §2.6 격리
원칙상 자체 루프는 MCP/스킬 경계로 감싸 페이지 직접 접근을 최소화한다.
(API 상세는 필요 시점에 `claude-api` 스킬로 재확인.)

## 선택 근거 메모

- **WXT vs Vite+CRXJS vs 수동**: WXT가 MV3 규약·HMR·크로스브라우저를
  프레임워크 레벨로 제공해 보일러플레이트가 가장 적다. CRXJS는 유지보수
  속도가 느린 편, 수동은 통제력은 크나 HMR/manifest를 직접 만들어야 함.
- **Zod**: 신뢰 경계(§2.6)를 넘는 모든 메시지를 파싱 실패 시 즉시 거절해야
  하는데, Zod는 런타임 검증과 정적 타입을 한 소스에서 준다. `shared`가
  단일 진실.
- **Vitest**: 정책 엔진이 순수 함수라 유닛 테스트가 핵심 자산. Vitest는
  TS·ESM 네이티브라 설정 비용이 낮다.
- **Playwright**: 익스텐션을 실제 크로미움에 로드해 결제창 인수·완료 파싱을
  검증할 수 있는 사실상 유일한 현실적 E2E 도구.
- **Biome**: 린트+포맷을 한 바이너리로. 팀 규모가 작을수록 도구 수를 줄이는
  게 유리. ESLint 생태계 플러그인이 꼭 필요해지면 그때 교체.

## 개발/테스트 안전 규칙 (스택 차원)

- **실제 카드·계정으로 테스트 금지.** 테스트 쇼핑몰·더미 프로필만 사용.
- 시크릿(있다면 빌링키 참조, 자체 루프 시 API 키)은 코드/로그/커밋에 금지.
  `.env`는 커밋 제외, 예시는 `.env.example`에 더미로.
- CI는 시크릿 없이 통과 가능해야 한다(정책 엔진·스키마 테스트는 순수).
