# Spec: 내장 어시스턴트 (`broker-extension/assistant`)

> 상태(2026-10-07): 구현·유닛 테스트 완료, **라이브 미검증**. 실제 ChatGPT 계정으로
> 로그인해 본 적이 아직 없다. §8의 미검증 항목이 첫 로그인에서 확인돼야 한다.

## 1. 목적

사이드패널 "주문" 탭에서 "○○ 사줘"를 직접 받아 실행한다. 두뇌는 사용자의 ChatGPT
플랜이다. Sign in with ChatGPT(SIWC)의 오픈소스 흐름으로 로그인하고, 받은 토큰으로
Responses API를 호출한다. API 키나 Claude Code 없이 익스텐션 단독으로 동작한다.

`agent-integration.md`의 두뇌 부착 방식 ①(익스텐션 내장)에 해당하며, ③(스킬→MCP→
브리지)과 병행한다. 두 경로는 같은 `BridgeTools`를 쓴다.

**비책임**: 정책 판정, 결제 실행, 감사, 통지. 어시스턴트는 도구를 호출할 뿐이다.

## 2. 신뢰 모델

모델은 익스텐션 프로세스 안에서 호출되지만 **신뢰하지 않는 에이전트**다. 웹페이지
내용(`read_page` 결과)을 읽으므로 프롬프트 인젝션에 노출되는 것은 ③과 같다.

- 모델이 할 수 있는 일은 MCP 표면과 같은 7개 도구뿐이다(`mcp-integration.md §3`).
- 모델이 낸 인자는 `BridgeToolCall` 스키마로 다시 검증한다. 스키마에 맞지 않거나
  목록에 없는 도구는 실행하지 않고 `invalid_tool_call`을 돌려준다.
- 잠금(`autopay_locked`), 결제 중 페이지 잠금(`page_locked_during_payment`), 금액
  독립 검증, 정책, 감사는 `BridgeTools`와 `BrokerCore`가 그대로 적용한다.
- 내장 방식의 격리는 프로세스 경계가 아니라 **코드 구조**로 지킨다. `Assistant`가
  받는 의존성은 `tools.handle` 하나이고 `BrokerCore`·refstore·정책 저장소 참조는
  없다. 이 의존성 목록을 넓히는 변경은 이 절과 대조해야 한다.

이 모듈이 새로 들이는 비밀은 **OAuth 토큰**(액세스·리프레시)이다. 결제 비밀은
아니지만 사용자의 ChatGPT 플랜을 쓸 수 있는 자격이다(§5).

## 3. 로그인 (SIWC 오픈소스 흐름)

출처: <https://developers.openai.com/siwc/token-sharing-open-source/sign-in>

| 항목 | 값 |
|---|---|
| 인가 | `https://auth.openai.com/api/accounts/authorize` |
| 토큰 | `https://auth.openai.com/api/accounts/oauth/token` (form, 시크릿 없음) |
| client_id | 첫 로그인 `dynamic_agent_client` → 콜백의 `client_id`(`oaiapp_…`)를 저장해 재사용 |
| scope | `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct` |
| resource | `https://api.openai.com/v1` |
| PKCE | S256 필수. `state`·`nonce`는 시도마다 새로 생성 |
| redirect_uri | `http://127.0.0.1:<PORT>/callback` (`localhost` 불가, 경로 고정, 포트만 가변) |
| ext_agent_host_id | 설치본마다 고정인 `urn:uuid:…`. 첫 로그인 전에 만들어 보존 |
| agent_name_hint | `AutoPay`. 첫 등록 요청에만 넣고 재인가에서는 뺀다 |

**콜백 수신.** 익스텐션은 포트를 열 수 없다. 대신 아무도 듣지 않는 임의의 고포트를
`redirect_uri`로 쓰고, `chrome.tabs.onUpdated`에서 탭이 그 주소로 이동하는 것을 보고
URL에서 `code`를 읽은 뒤 탭을 닫는다. 진행 중인 로그인의 `redirect_uri`와 정확히
일치하는 주소만 처리한다. 가로채기가 실패하면 사용자가 주소창의 URL을 설정 탭에
붙여넣는 수동 경로를 쓴다.

**검증.** `state` 일치, 부여된 scope에 `chatgpt.tokens.use.direct` 포함, ID 토큰의
`nonce` 일치를 확인한다. ID 토큰 서명(JWKS)은 검증하지 않는다. 토큰을 TLS로 토큰
엔드포인트에서 직접 받고, 신원 클레임을 어떤 판단에도 쓰지 않기 때문이다.

**리프레시.** 액세스 토큰은 1시간, 리프레시 토큰은 30일이다. 만료 60초 전부터
`grant_type=refresh_token`으로 갱신한다. 리프레시 토큰은 회전할 수 있으므로 동시
요청은 하나로 합치고, 응답에 새 리프레시 토큰이 오면 교체한다. `invalid_grant` 등
토큰이 죽었다는 응답을 받으면 저장된 토큰을 지우고 재로그인을 안내한다.

## 4. 추론 (Responses API)

- `POST https://api.openai.com/v1/responses`, `Authorization: Bearer <액세스 토큰>`.
- 프리뷰 제약: `store:false`, `stream:true` 필수. `temperature`·`metadata`·
  `previous_response_id`와 호스티드 도구는 쓸 수 없다.
- 서버가 대화를 기억하지 않으므로 매 요청에 지침(`developer` 메시지), 사용자 발화,
  모델 출력 항목, 도구 결과를 전부 `input`으로 보낸다. 추론 항목을 되돌려 보내기
  위해 `include:["reasoning.encrypted_content"]`를 요청하고, 거절되면 빼고 재시도한다.
- `response.completed`를 받아야만 성공이다.
- 모델은 `GET /v1/models`의 목록에서 고른다. 선택이 없으면 첫 번째 모델을 쓴다.

**루프.** 프롬프트 하나당 모델 호출은 최대 40회다. 함수 호출이 없는 응답이 오면
끝난다. 도구 결과는 16,000자에서 자른다. `get_payment_result`가 대기 상태면 5초
쉰 뒤 돌려준다(모델이 조회를 연달아 호출해 플랜을 소모하지 않도록).

**오류.** `subscription_sharing_usage_limit_exceeded`(429) 등 문서의 오류 코드를
한국어 안내로 바꿔 대화에 남긴다. 401은 재로그인 안내로 처리한다.

## 5. 저장

| 키 | 저장소 | 내용 |
|---|---|---|
| `assistant:client` | `chrome.storage.local` 평문 | `clientId`, `hostId` (공개 클라이언트라 비밀 아님) |
| `assistant:tokens` | `chrome.storage.local` **봉인** | 토큰 묶음. 잠금 패스프레이즈 파생 키로 AES-GCM |
| `assistant:model` | `chrome.storage.local` 평문 | 선택한 모델 slug |
| `assistant:login` | `chrome.storage.session` | 진행 중인 로그인의 PKCE 검증자·state·nonce |
| `assistant:chat` | `chrome.storage.session` | 대화 기록. 브라우저를 닫으면 사라진다 |

> **주의.** SIWC 문서는 토큰을 "보호된 로컬 저장소"에 두고 브라우저 저장소에는 두지
> 말라고 안내한다. 이 구현은 익스텐션 저장소에 두되 패스프레이즈 키로 봉인하므로
> 잠금 상태에서는 읽을 수 없다. 이 방식이 문서의 요구를 충족하는지는 OpenAI의 해석에
> 달려 있어 확정하지 못했다. 엄격히 따르려면 토큰을 로컬 프로세스(mcp-server)로
> 옮겨야 하고, 그러면 익스텐션 단독 동작을 잃는다.

## 6. UI

- **주문 탭**: 대화 목록, 입력창(Enter 전송, Shift+Enter 줄바꿈), 보내기/중단, 새 대화.
  도구 호출은 한 줄 요약으로만 보여준다(인자 전문과 결과는 싣지 않는다).
- **설정 탭 "ChatGPT 연결" 카드**: 로그인, 연결 해제, 모델 선택, 수동 콜백 입력.
- 실행은 background가 하고 UI는 1초 간격으로 상태를 읽는다. 패널을 닫아도 진행된다.
- `assistantSend`는 접수만 하고 돌아온다. 쓰기 RPC는 직렬 큐라서 실행을 기다리면
  다른 쓰기 RPC(승인 등)가 막힌다. 읽기 전용 RPC(`getState`·`getAudit`·`getAssistant`)는
  큐를 우회하고, 어시스턴트의 네트워크 호출은 응답 헤더 대기 20초 상한(`withTimeout`)을
  둬서 멈춘 호출이 큐를 붙잡지 못하게 한다.

## 7. 불변식

- 액세스·리프레시 토큰은 UI 상태, 대화 기록, 모델 입력, 콘솔 로그에 나가지 않는다.
- 평문 토큰을 디스크에 쓰지 않는다.
- 모델이 호출할 수 있는 도구는 7개이고, 실행 전에 `BridgeToolCall`로 검증된다.
- `request_payment`의 `checkoutTabId`는 모델이 지정할 수 없다(스키마가 거부).
- 진행 중인 로그인과 일치하지 않는 `127.0.0.1` 주소의 탭은 건드리지 않는다.
- 잠겨 있으면 로그인 완료·전송·도구 실행이 모두 거부된다.

## 8. 미검증 (첫 라이브 로그인에서 확인할 것)

1. `chrome.tabs.onUpdated`로 `127.0.0.1` 콜백 이동을 잡을 수 있는가. 실패하면 수동
   붙여넣기 경로를 쓴다.
2. SIWC 토큰으로 **커스텀 함수 도구 호출**이 되는가. 문서는 호스티드 도구 불가만
   명시하고 함수 도구는 언급하지 않는다. 안 되면 이 기능은 성립하지 않는다.
3. `developer` 역할 메시지와 `include`가 프리뷰에서 허용되는가.
4. 모델 출력 항목을 `store:false`에서 그대로 `input`에 되돌려 보내도 되는가.
5. 익스텐션 서비스워커에서 `api.openai.com`·`auth.openai.com`을 호출할 때 Origin
   때문에 거절되지 않는가.
6. 긴 실행(수 분) 동안 서비스워커가 유지되는가. 워커가 죽으면 진행 중이던 실행은
   사라지고 대화 기록만 남는다.

`scripts/siwc-spike.mjs`는 2·3·4번을 익스텐션 없이 Node에서 확인하는 스크립트다.

## 9. 테스트 케이스

`src/assistant/*.test.ts` (28건). 인가 URL 구성, 콜백 판별과 `state` 검증, 토큰
교환의 scope·nonce 확인, 리프레시 회전과 죽은 토큰 처리, SSE 조각 읽기, 프리뷰 필수
필드, 도구 왕복과 맥락 재전송, 스키마 위반 호출 거부, 토큰 비노출, 단계 상한,
오류 안내.
