# Spec: 에이전트 제어 메커니즘 & 통합 (`broker-extension` + 전송)

## 1. 목적

에이전트가 **어떻게 웹을 조작하는가(제어 메커니즘)** 와 **에이전트 두뇌가
브로커에 어떻게 붙는가(통합/전송)** 를 정의한다. executor·broker-api 스펙이
암묵적으로 전제하는 하부 메커니즘을 명시화한다.

## 2. 제어 메커니즘 — "마우스"가 아니라 DOM 조작

에이전트는 대부분 **진짜 마우스를 움직이지 않는다.** content script가 페이지
DOM을 직접 조작한다.

### 2.1 방식 A — Content Script DOM 조작 (기본)

```js
document.querySelector('button.pay-now').click();          // "클릭"
const el = document.querySelector('#phoneNumber');
el.value = '01012345678';
el.dispatchEvent(new Event('input', { bubbles: true }));   // 프레임워크에 알림
```

- 커서·OS 개입 없음. 요소에게 이벤트를 프로그램으로 전달.
- React 등은 native value setter를 통해 값 설정 필요할 수 있음(구현 주의).

### 2.2 방식 B — `chrome.debugger` → CDP (필요 시)

`debugger` 권한으로 `Input.dispatchMouseEvent` 등 **진짜 입력 이벤트 합성**
(`isTrusted: true`). Playwright/Puppeteer와 같은 원리. 단 "디버깅 중" 배너가
뜨고 무겁다. **기본은 방식 A, B는 최후 수단**(우리 대상 결제엔 불필요).

### 2.3 페이지 → 액션 루프

```
1. content script가 페이지를 텍스트로 직렬화(요소 목록/접근성 트리; 스크린샷 아님)
2. 두뇌(LLM)에 전달 → 액션 반환 { action:"click", selector:"..." }
3. content script가 DOM으로 실행
4. 페이지 변화 → 1로 반복
```

### 2.4 한계 (정직하게)

- **`isTrusted:false`**: 방식 A 이벤트는 합성 표시. 대부분 버튼은 수용하나,
  강한 봇 방지·보안 키패드는 거부(→ 네이버 키패드 제외 이유).
- **cross-origin iframe**: 결제창이 타 도메인 프레임이면 그 프레임에도 주입 +
  host 권한 필요.
- **canvas/이미지 UI**: DOM 요소가 아닌 그림(보안 키패드 등)은 방식 A로 불가.
  → 그런 결제수단은 대상에서 제외.

## 3. 통합 — 두뇌를 브로커에 붙이는 3가지 방식

"손"(content script)은 항상 익스텐션 안에 있다(익스텐션만 주입 가능). 두뇌
위치만 다르다.

| # | 두뇌 위치 | 연결 메커니즘 | 격리 강제력 |
|---|---|---|---|
| ① | 익스텐션 내장 모듈 | 내부 함수 호출(전송 없음). Claude API 직접 호출 | 코드 규율 수준 |
| ② | 다른 익스텐션(Claude for Chrome) | `externally_connectable` + `runtime.sendMessage` | 사용자 설정 의존 |
| ③ | 로컬 프로세스(Claude Code/Codex/자체) | `nativeMessaging`(`connectNative`) → MCP 서버 | **강제 가능(우월)** |

- **②** 는 프로그램적 트리거가 안 돼 지정가 자동 감시(플래그십)와 안 맞음.
- **③** 은 에이전트가 페이지 직접 접근 없이 브로커 도구만 호출 → §2.6 우선 방식.

## 4. 관통 원리 — "손"을 도구(tool)로 노출

브로커는 능력을 **도구 집합**으로 정의하고, 두뇌는 위치와 무관하게 이 도구만
호출한다. **도구 인터페이스가 경계**이고, 두뇌 위치는 전송(transport)만 다름.

```typescript
export interface BrokerTools {
  // 쇼핑 손 (Untrusted 두뇌가 사용하지만 실행은 브로커 content script)
  navigate(url: string): Promise<void>;
  readPage(tabId: number): Promise<string>;   // 직렬화된 DOM
  click(tabId: number, selector: string): Promise<void>;
  fill(tabId: number, selector: string, value: string): Promise<void>;
  // 결제 (정책 게이트 통과 필수 — broker-api.md)
  requestPayment(req: PaymentRequest): Promise<{ requestId: string }>;
  getPaymentResult(requestId: string): Promise<PaymentResult>;
  getPolicySummary(): Promise<PolicySummary>;
}
```

- **①**: 두뇌가 이 도구를 내부 호출.
- **③**: 같은 도구를 MCP로 노출 → 외부 두뇌가 호출. 브로커 코어(policy/
  executor/audit)는 두뇌 위치와 무관하게 동일.

## 5. 결정 (MVP)

- **MVP = ① (익스텐션 내장 두뇌).** 가장 빨리 검증. 단 두뇌는 브로커 코어를
  **반드시 §4 도구 인터페이스를 통해서만** 호출하도록 설계 → 나중에 ③으로
  전환 시 같은 도구를 MCP로 노출만 하면 되고 코어 재작성 없음.
- 제어는 **방식 A(DOM 조작)** 중심. 방식 B(`chrome.debugger`)는 도입하지 않음.
- 쇼핑 손·결제 손 모두 브로커가 보유(플래그십 자동 감시를 위해 ②는 배제).

## 6. 불변식

- 두뇌(Untrusted)는 §4 도구 인터페이스 밖으로 브로커 코어에 접근하지 못한다.
- 결제 관련 도구(`requestPayment`)는 항상 정책 엔진 게이트를 거친다.
- 전송 방식이 바뀌어도 도구 인터페이스·브로커 코어는 불변.

## 7. 수용 기준

- [ ] `BrokerTools` 인터페이스 정의, ①에서 내부 구현
- [ ] 두뇌 모듈이 도구 인터페이스만 통해 코어를 호출(리뷰)
- [ ] content script 기반 navigate/read/click/fill 동작(테스트 쇼핑몰)
- [ ] `chrome.debugger` 미사용 확인(권한 목록에 `debugger` 없음)

## 8. 테스트 케이스

1. `readPage`가 요소 목록/접근성 정보를 직렬화해 반환
2. `click`/`fill`이 대상 요소에 반영(input 이벤트 포함)
3. cross-origin iframe 결제창: 해당 프레임 주입 필요성 감지/처리
4. 두뇌가 도구 밖 경로로 코어 접근 시도 → 불가(설계상 노출 안 됨)
