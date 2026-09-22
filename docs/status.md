# 구현 상태 (Status)

> 갱신: 2026-09-22. 무엇이 **실제로 만들어져 테스트·빌드로 검증**됐고, 무엇이
> 남았는지 정직하게 기록한다.

## 완료 (검증됨)

| 영역 | 상태 | 검증 |
|---|---|---|
| 모노레포·스택 (M0) | ✅ | pnpm workspace, TS strict, Vitest, Biome |
| `shared` Zod 스키마 | ✅ | strict 거부·origin 제약 + 브리지 프로토콜 스키마, 유닛 테스트 |
| 정책 엔진 | ✅ | 순수 함수, **100% 커버리지**, 26 케이스 |
| audit / notify / refstore | ✅ | 주입식 유닛 테스트 |
| executor 코어(스냅샷·TOCTOU 재검증) + 어댑터(카카오/쿠팡/토스) | ✅ | fake driver/bridge 유닛 테스트 |
| broker 오케스트레이션(정책·confirm·origin·동시성·예외수렴) | ✅ | 유닛 테스트 |
| 브로커 익스텐션 (M1) | ✅ | WXT MV3, Side Panel+Options+background, `wxt build` 성공 |
| **MCP 브리지 (M2 코어)** | ✅ | `packages/mcp-server`(stdio+WS 허브) + `src/bridge` + `packages/agent-skill`, 실물 프로토콜 E2E |
| **교차 워커 원자성 복구** | ✅ | `recoverStaleExecutions()` — 중단된 실행을 재시도 없이 안전 실패 처리, 유닛 테스트 2건 |
| Codex 리뷰 | ✅×4 | M0·M1코어·M1익스텐션·최종, High/Medium 반영 |

**테스트 총계**: 146 (shared 17 + broker-extension 111 + mcp-server 18). typecheck·biome 클린.

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
- **`e2e.test.ts` — 프로토콜 전 구간 실물 왕복 검증**: 실제 `@modelcontextprotocol/sdk`
  `Client`(InMemoryTransport) → 실제 `McpServer`(`registerTools`) → 실제 `Hub`
  (127.0.0.1 WS) → 실제 `ws` 클라이언트(익스텐션 흉내, 응답 로직만 페이크)까지
  전부 실물로 왕복시켜 6케이스 검증: tools/list가 스펙 §3의 7개와 정확히 일치,
  `get_policy_summary`/`request_payment` 왕복(후자는 `checkoutTabId` 없이
  그대로 허브까지 전달됨을 확인), 익스텐션 미접속 시 `bridge_not_connected`가
  isError로 노출, `open`에 자격증명 URL을 주면 **MCP 입력 스키마 단계에서
  허브까지 가지도 않고** 거절, 표면 밖 도구(`get_secret`)는 MCP 표준 오류로
  거절. 이 환경에서 가능한 한 가장 "라이브"에 가까운 검증이다 — 유일하게 실물이
  아닌 것은 익스텐션 background의 `BridgeTools` 응답(그건 `bridge-tools.test.ts`가
  이미 주입식으로 검증).

## 남은 작업 (이 환경에서 런타임 검증 불가 — 사용자의 실제 브라우저·계정 필요)

- **M2 잔여 — 실제 Claude Code·Chrome 라이브 연결**: 프로토콜 왕복은 위
  `e2e.test.ts`로 검증됐지만, ①실제 Claude Code CLI 프로세스가 `.mcp.json`으로
  이 서버를 stdio로 띄우는 것과 ②실제 Chrome에 익스텐션을 로드해 WS로 붙는
  것은 이 세션 자체가 Claude Code 프로세스이자 이 대화의 실행 주체라 자기
  자신을 재시작해 검증할 수 없다 — 사용자가 직접(또는 다음 세션에서) 확인해야
  한다. `read_page`의 셀렉터 생성이 실제 쇼핑몰 DOM에서 충분히 안정적인지도
  라이브 검증 필요.
- **M3 — 실결제 어댑터 라이브 셀렉터**: **쿠팡(패턴 C)은 2026-09-22 라이브 캡처로
  확정.** 실계정 로그인 상태의 `checkout.coupang.com/direct/checkout/…` 주문서에
  CDP로 붙어 결제 **직전까지** 진행(결제 클릭 안 함)하고 셀렉터를 검증했다.
  - 확정: `amount=label:최종 결제 금액`(→"3,650원") · `payButton=text:결제하기` ·
    `items=location:items`(→"86091485721:1") · `merchant` 노드 없음(→"쿠팡" 폴백) ·
    비밀번호 키패드 **부재**(= 패턴 C 원터치 확인) · origin=`https://checkout.coupang.com`.
  - 발견: 쿠팡 웹은 Tailwind 자동생성 클래스뿐이라 **고정 CSS 셀렉터가 없다** →
    셀렉터 스킴(`text:`/`label:`/`after:`/`location:`) 도입(`executor/selector.ts`,
    `docs/spec/executor.md §2.2`). 장바구니 CTA는 "앱에서 바로 구매하기"라
    상품 페이지 `.prod-buy-btn`(바로구매)로 주문서에 진입해야 한다.
  - **잔여**: `success`/`orderId`는 **결제 완료 후 페이지**에만 존재해 미검증
    (실주문을 하지 않았다). 첫 실주문 때 확정 필요.
  - 카카오/토스(패턴 B)는 여전히 placeholder — 실결제 캡처 필요.
  - **2026-09-23 실사용 중 발견**: 실제 [결제하기] 클릭 시 **원터치가 켜져
    있음에도 6자리 비번 화면이 떴다** — 쿠팡 FDS가 리스크 기준으로 원터치를
    건너뛸 수 있음(`payment-flows.md`가 이미 이 가능성을 언급해뒀었음). 이건
    쿠팡의 의도된 보안 동작이라 우회 대상이 아니다(AGENTS §2.5 "FDS/안티봇
    회피" 채택 안 함). 문제는 우리 쪽 감지 실패였다 — `passwordUi` 셀렉터가
    `css:[class*=keypad],[class*=password]`(검증 안 된 추측, Tailwind
    클래스엔 애초에 나올 수 없는 문자열)라 비번 모달을 못 잡고 3분 타임아웃까지
    그냥 대기했다. `contains:` 셀렉터 스킴을 새로 추가(부분 텍스트 포함 매칭)
    해서 `passwordUi: "contains:비밀번호"`로 교체 — 정확한 문구를 몰라도 즉시
    감지해 `failed(password_required)`로 빠르게 수렴한다. 실제 비번 모달
    DOM은 여전히 못 봤으니(다음에 마주치면) 재검증 필요.
- **M4 — 빌링키(패턴 A)**: refstore에 빌링키 저장 계약만 존재. PG 가맹점 계약
  전제. **2026-09-22 문서 조사 완료**(`docs/payment-flows.md` "빌링키 가맹점
  요건 조사") — 토스·카카오 모두 PG 계약 필수, 사업자 등록 사실상 전제,
  자동결제는 별도 추가 심사. 사업자 등록·실계약 여부는 사업 결정이라 코드로
  대신할 수 없음 — 아직 미정.

## 알려진 한계 (설계상 명시)

- **카테고리 스푸핑**: 정책 카테고리는 에이전트 제출 items에 의존. 실제 장바구니
  상품 대조는 사이트별 파싱이 필요해 미구현(AGENTS §1.1 범위). TOCTOU 재검증은
  승인 후 변경을 막지만, 최초 카테고리 위장은 실장바구니 파싱 전까지 잔여.
- **교차 워커 원자성**: **해소됨** — `BrokerCore.recoverStaleExecutions()`가
  5분 알람 틱마다 `payTimeoutMs+60s`를 넘긴 중단된 실행을 `failed(interrupted)`
  로 안전 수렴시키고(재시도 없음, 중복 결제 방지), 세션 키 소실은 기존
  `Unlock` UI가 반응형으로 처리(AGENTS §9). MCP 브리지 WS 연결 재기동 지연
  (최대 5분)은 남은 제약 — 사용자가 재시도하면 되는 수준.
- **세션 쿠키 탈취**(별도 익스텐션 에이전트): 브로커 통제 밖(AGENTS §2.6).
  MCP 브리지 경로(③)는 이 리스크가 구조적으로 없음 — 스킬은 페이지에 직접
  접근하지 않는다(§2.6 표 참조).

## 실행 방법

`README.md` 참조 (빌드·로드·테스트·MCP 브리지 설정).
