# Spec: 스킬 → MCP → 익스텐션 통합 (③, Claude Code)

## 1. 목적

에이전트(**Claude Code**)가 **스킬**로 AutoPay 익스텐션에 접근해, 사용자가
"○○ 3만원 이하로 사줘"라고 말하면 **검색·비교·선택·장바구니·체크아웃**을
수행하고 브로커를 통해 **결제**까지 잇는다. 이는 `AGENTS.md §2.6`이 선호하는
격리 우월 경로(③) — 에이전트는 페이지에 직접 접근하지 않고 **도구만** 호출한다.

**역할 분리**: 스킬=두뇌(무엇을), 익스텐션=손(DOM)·금고(정책·결제·감사).

## 2. 구성 & 데이터 흐름

```
[Claude Code + 스킬]        [mcp-server (로컬)]         [AutoPay 익스텐션(MV3)]
  두뇌(LLM)  ──stdio MCP──▶  도구 노출 + 로컬 WS 허브 ──WS──▶  background
  "키보드 사줘"                (토큰 게이트)              ├─ content scripts(손)
             ◀──결과 요약───                             └─ broker(정책·실행·감사)
```

- **전송(권장): 로컬 WebSocket 브리지.** `mcp-server`가 Claude Code에 stdio MCP
  서버로 뜨고, 동시에 `127.0.0.1`에 **토큰 게이트 WS 허브**를 연다. 익스텐션
  background(SW)는 **WS 클라이언트로 접속**(MV3 SW는 서버는 못 열지만 WS
  클라이언트는 가능). 도구 호출이 MCP→WS→익스텐션으로 흐른다.
- **대안: Native Messaging Host.** 익스텐션이 `chrome.runtime.connectNative`로
  네이티브 호스트를 띄우고, 그 호스트가 mcp-server와 로컬 소켓으로 연결. 등록이
  더 번거로워(호스트 매니페스트 배치) MVP는 WS 브리지를 우선한다.
- 실제 검색·클릭·입력은 익스텐션 content script("손")가 수행. 결제는 반드시
  브로커 정책 게이트를 통과.

## 3. MCP 도구 표면 (에이전트에 노출되는 전부)

비밀·빌링키·세션을 반환하는 도구는 없다(§AGENTS 4). 스킬은 아래만 사용:

| 도구 | 설명 | 매핑 |
|---|---|---|
| `open(url)` | 탭 열기/이동 | content/tabs |
| `read_page()` | 현재 탭 직렬화(요소·접근성 트리; 스크린샷 아님) | `BrokerTools.readPage` |
| `click(selector)` / `fill(selector, value)` | DOM 조작(방식 A) | `BrokerTools.click/fill` |
| `request_payment(req)` | 체크아웃에서 결제 요청 | `broker.requestPayment` (broker-api) |
| `get_payment_result(requestId)` | 결과 요약(비밀 없음) | `broker.getPaymentResult` |
| `get_policy_summary()` | 잔여 예산·허용 목록 | `broker.getPolicySummary` |

- 검색은 `open`(쇼핑몰 검색 URL) + `read_page`로 후보를 얻어 **두뇌가 선택**.
- 결제 최종 승인은 도구가 아니라 사용자(패턴 B 폰 / 패턴 C 확인). 도구는
  "요청"까지만 — 승인 게이트를 우회하는 도구는 존재하지 않는다.

## 4. 메시지 프로토콜 (WS 브리지)

```jsonc
// MCP 도구 호출 → WS 프레임 (mcp-server → 익스텐션)
{ "id": "c1", "tool": "click", "args": { "selector": "#buy" } }
// 결과 (익스텐션 → mcp-server → MCP 응답)
{ "id": "c1", "ok": true, "result": { ... } }      // 또는 { ok:false, error }
```

- 모든 인바운드는 익스텐션에서 zod 검증(실패=거절, fail-closed).
- `request_payment`의 페이로드는 `shared`의 `PaymentRequest` 스키마.

## 5. 보안

- **토큰 게이트**: mcp-server가 시작 시 랜덤 토큰을 생성해 로컬 파일
  (`~/.autopay/bridge-token`, 0600)에 쓰고, 익스텐션 옵션에 같은 토큰을 1회
  등록. WS 핸드셰이크에서 토큰 불일치 시 연결 거부(임의 로컬 프로세스·페이지의
  접속 차단).
- **단일 연결**: 익스텐션은 브리지 연결 1개만 허용.
- **정책 게이트 불변**: 모든 결제는 브로커 정책·확인·감사를 그대로 통과.
- **비밀 미노출**: 도구 응답·요약에 비밀·빌링키·PII·세션 없음.
- **로컬 전용**: WS는 `127.0.0.1` 바인딩(외부 노출 금지).

## 6. 스킬 정의 (`packages/agent-skill`)

Claude Code용 스킬(`SKILL.md` + 도구 사용 규칙):
- **트리거**: "사줘 / 구매 / 최저가로 주문 / 지정가로 사줘" 등.
- **절차**: get_policy_summary로 한도·허용몰 확인 → open(검색) → read_page로
  후보 비교 → 상품 선택 → 장바구니 → 체크아웃 진입 → request_payment →
  get_payment_result로 결과 확인 → 사용자에게 보고.
- **금지(스킬 프롬프트에 명시)**: 정책 우회·키패드 조작·FDS 회피·비밀 요구.
  최종 승인은 사용자 몫임을 전제.

## 7. 설치/등록 (Claude Code)

> 사용자용 원커맨드: `pnpm bootstrap`(설치·빌드·토큰 준비·클립보드 복사, README
> "빠른 시작"). 아래는 개별 단계.

1. `pnpm --filter @autopay/mcp-server build`
2. Claude Code에 MCP 서버 등록: `claude mcp add autopay -- node <경로>/mcp-server/dist/index.js`
   (또는 `.mcp.json`에 stdio 커맨드 추가)
3. 익스텐션 로드 후 옵션에서 **브리지 토큰** 등록 → SW가 mcp-server WS에 접속
4. 스킬을 Claude Code 스킬 디렉토리에 배치(프로젝트 `.claude/skills/` 또는 사용자)
5. Claude Code에서 "○○ 사줘" → 스킬이 MCP 도구로 자율 수행 → 승인 한 번

## 8. 범위 / 한계

- **런타임 필요**: Claude Code(MCP 지원). LLM 두뇌는 Claude Code가 제공.
- **결제 완결**: 검색~체크아웃은 자율. 최종은 국내 레일 특성상 쿠팡 원터치
  클릭(C) 또는 폰 승인(B). 에이전트가 페이지를 읽어 처리하므로 하드코딩 캡처는
  불필요(셀렉터 취약 시 read_page 기반으로 적응).
- **미검증**: LLM·WS·네이티브 런타임은 CI에서 실행 불가 — 도구 매핑·프로토콜
  스키마·정책 연동은 유닛 테스트로, 실연결은 로컬 검증.

## 9. 구현 순서 (다음 단계, 이 문서는 설계까지)

1. `shared`에 브리지 프레임/도구 스키마(zod) 추가
2. 익스텐션 background에 WS 클라이언트 + 도구→`BrokerTools`/broker 매핑 + 토큰
   핸드셰이크 (옵션에 토큰 입력 UI)
3. `packages/mcp-server`: stdio MCP 서버 + 로컬 WS 허브(토큰 게이트)
4. `packages/agent-skill`: SKILL.md + 도구 사용 규칙
5. 유닛 테스트(도구 매핑·스키마·정책 연동) → 로컬 E2E(수동)

## 10. 불변식

- 에이전트(스킬)는 §3 도구 밖으로 브로커·페이지에 접근하지 못한다.
- 토큰 미검증 연결은 어떤 부수효과도 만들지 않는다.
- `request_payment`는 항상 정책 게이트를 거치고, 최종 승인은 out-of-band.
- 도구 응답에 비밀·PII·빌링키·세션이 없다. `read_page`는 `input[type=password]`
  값을 반환하지 않는다.
- 결제 실행 중(비번 핸드오프 포함)에는 `open`/`read_page`/`click`/`fill`이
  `page_locked_during_payment`로 거부된다(`executor.md §3.2`).
