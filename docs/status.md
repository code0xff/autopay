# 구현 상태 (Status)

> 갱신: 2026-09-22. 무엇이 **실제로 만들어져 테스트·빌드로 검증**됐고, 무엇이
> 남았는지 정직하게 기록한다.

## 완료 (검증됨)

| 영역 | 상태 | 검증 |
|---|---|---|
| 모노레포·스택 (M0) | ✅ | pnpm workspace, TS strict, Vitest, Biome |
| `shared` Zod 스키마 | ✅ | strict 거부·origin 제약 + 브리지 프로토콜 스키마, 유닛 테스트 |
| 정책 엔진 | ✅ | 순수 함수, **100% 커버리지**, 26 케이스 |
| audit / notify / refstore / watch | ✅ | 주입식 유닛 테스트 |
| executor 코어(스냅샷·TOCTOU 재검증) + 어댑터(카카오/쿠팡/토스) | ✅ | fake driver/bridge 유닛 테스트 |
| broker 오케스트레이션(정책·confirm·origin·동시성·예외수렴) | ✅ | 유닛 테스트 |
| 브로커 익스텐션 (M1) | ✅ | WXT MV3, Side Panel+Options+background, `wxt build` 성공 |
| **MCP 브리지 (M2 코어)** | ✅ | `packages/mcp-server`(stdio MCP + WS 허브, 토큰 게이트) + 익스텐션
| | | `src/bridge`(WS 클라이언트 + 도구→broker 매핑) + `packages/agent-skill` |
| Codex 리뷰 | ✅×4 | M0·M1코어·M1익스텐션·최종, High/Medium 반영 |

**테스트 총계**: 132 (shared 17 + broker-extension 103 + mcp-server 12). typecheck·biome 클린.

### Codex 최종 리뷰 High 3건 — 반영 + 회귀 테스트로 검증
- confirm 후 실행 직전 정책·사용량 재평가(한도 소진 시 차단) — `broker-core.test.ts` #15
- 워커 재시작 대비 영속 idempotency(중복 결제 방지) — `broker-core.test.ts` #16
- 완료 판정 origin 일치 필수(허위 완료 차단) — `adapters.e2e.test.ts`

> Codex 자동 "clean-pass 재확인"은 이 환경에서 Codex 런타임 OOM(exit 137)으로
> 완주 실패. 대신 위 3건을 **직접 회귀 테스트**로 못박아 검증했다. 로컬에서
> `/code-review high` 또는 codex CLI로 재확인 권장.

**픽스처 E2E**: `src/executor/adapters.e2e.test.ts` — 모킹 결제창/완료 HTML(linkedom)에
실제 어댑터를 돌려 verify→클릭/입력→완료 파싱까지 "실제 실행 직전"을 검증
(쿠팡 정상·TOCTOU 취소·비번UI 실패·카카오 패턴 B). 라이브 셀렉터 확정 시 이
픽스처만 실캡처로 교체.

### M2 — MCP 브리지 (`docs/spec/mcp-integration.md`, ③ 스킬→MCP→브리지→익스텐션)

- `packages/shared`: `BridgeToolCall`(7개 도구 discriminated union) ·
  `BridgeToolResult` · `BridgeFrame`(auth/auth_result/call/result) · `SafeHttpUrl`.
  전부 `.strict()` — `request_payment`에 `checkoutTabId`를 실어 보내면 거절
  (에이전트에 탭 id 비노출).
- `packages/broker-extension/src/bridge`:
  - `page-bridge.ts` — 제네릭 DOM 접근("손"). `read_page`는 스크린샷이 아니라
    보이는 요소(a/button/input/…) 목록 + nth-of-type 셀렉터.
  - `bridge-tools.ts` — 7개 도구 → `BrokerCore`/`GenericPageBridge` 매핑.
    `open` 전 `click`/`read_page`/`fill`은 `no_open_tab`으로 fail-closed.
  - `ws-client.ts` — mcp-server WS 허브 접속(익스텐션=클라이언트, MV3 SW 제약).
    **인증 전 call 프레임은 절대 처리하지 않는다**(spec §10 불변식, 테스트로 고정).
  - background 합성(`compose.ts`)에 배선: 부팅 시 + 5분 알람 틱마다 재접속 시도,
    옵션 UI에 토큰 등록 카드 추가.
- `packages/mcp-server`: `hub.ts`(127.0.0.1 WS 서버, 토큰 게이트, **단일 연결
  강제** — 두 번째 인증 시도는 거부), `token.ts`(`~/.autopay/bridge-token`,
  0600), `tools.ts`(MCP `McpServer.tool()` 등록), `index.ts`(stdio 서버 + 허브
  기동). esbuild로 `@autopay/shared`(TS 소스)만 번들하고 `ws`·SDK·`zod`는
  external — `node dist/index.js`로 그대로 실행 가능함을 직접 확인.
- `packages/agent-skill/SKILL.md`(`.claude/skills/autopay-shopping/`에 심볼릭
  링크) — 신뢰 경계·절차·금지 사항 명시. `.mcp.json`에 `autopay` 서버 등록.
- `hub.test.ts`는 **실제 `ws` 서버·클라이언트**로 인증/단일연결/타임아웃/연결끊김을
  검증(모킹 아님). `ws-client.ts`/`bridge-tools.ts`는 기존 코드베이스 관례대로
  주입식 유닛 테스트.

## 남은 작업 (이 환경에서 런타임 검증 불가 — 라이브 연결 필요)

- **M2 잔여 — 실제 Claude Code 연결**: `.mcp.json` 등록 + 옵션 토큰 입력까지의
  배선은 코드·유닛테스트로 완성됐으나, 실제 Claude Code 프로세스가 stdio로
  붙어 도구를 호출하고 실제 Chrome 확장이 WS로 응답하는 end-to-end는 이
  환경(브라우저·LLM 런타임 없음)에서 미검증. `read_page`의 셀렉터 생성이
  실제 쇼핑몰 DOM에서 충분히 안정적인지도 라이브 검증 필요.
- **M3 — 실결제 어댑터 라이브 셀렉터**: 카카오/쿠팡/토스 어댑터의 DOM 셀렉터·
  완료신호는 placeholder. 실결제 네트워크 캡처로 확정 필요(payment-flows 검증
  항목). 로직(스냅샷·재검증·매핑)은 완성·테스트됨.
- **M4 — 빌링키(패턴 A)**: refstore에 빌링키 저장 계약만 존재. PG 가맹점 계약
  전제.

## 알려진 한계 (설계상 명시)

- **카테고리 스푸핑**: 정책 카테고리는 에이전트 제출 items에 의존. 실제 장바구니
  상품 대조는 사이트별 파싱이 필요해 미구현(AGENTS §1.1 범위). TOCTOU 재검증은
  승인 후 변경을 막지만, 최초 카테고리 위장은 실장바구니 파싱 전까지 잔여.
- **교차 워커 원자성**: in-flight 가드는 단일 서비스워커 내 중복만 방지. MV3
  워커 재기동 시 in-memory 가드·세션 키가 소실됨(재잠금 필요). MCP 브리지 WS
  연결도 같은 제약 — 재기동 시 5분 알람 틱까지는 재접속 지연 가능.
- **세션 쿠키 탈취**(별도 익스텐션 에이전트): 브로커 통제 밖(AGENTS §2.6).
  MCP 브리지 경로(③)는 이 리스크가 구조적으로 없음 — 스킬은 페이지에 직접
  접근하지 않는다(§2.6 표 참조).

## 실행 방법

`README.md` 참조 (빌드·로드·테스트·MCP 브리지 설정).
