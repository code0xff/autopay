# Spec: Payment Executor (`broker-extension/executor`)

## 1. 목적

정책 통과 후 결제를 수행한다. 두 패턴을 하나의 `SimplePayAdapter`로 공통화:
- **패턴 B (카카오·토스)**: 결제창을 인수해 식별정보(휴대폰번호·생년월일)
  입력 → 폰 푸시 트리거 → **폰에서 사용자 승인**(외부 인간 게이트).
- **패턴 C (쿠팡 원터치)**: 인-페이지에서 [결제하기] 클릭만으로 완결
  (식별정보·폰 승인 없음). **외부 게이트 없음** → 정책+확인+통지가 게이트.

어느 경우든 **쇼핑몰 완료 신호를 독립 파싱**해 결과를 확정한다. **최초 검증은
카카오(패턴 B)**, 이어서 쿠팡(패턴 C), 토스(패턴 B) 순.

**비책임 / 금지**: 결제 비밀번호·카드번호 입력·보관, 보안 키패드 우회, 폰
생체인증 대행, FDS 회피(AGENTS.md §2.5). 최종 승인 권한은 100% 사용자(폰).

## 2. 계약

```typescript
export interface VerifiedCheckout {
  amount: number;        // 체크아웃에서 파싱한 실제 결제 금액(원)
  merchantName: string;
  snapshot: string;      // 결제 대상 스냅샷 해시 (금액+상품+가맹점 등 핵심 필드)
}

export interface PayInput {
  tabId: number;               // 결제창/체크아웃 탭
  identity?: { phone: string; birth: string }; // 패턴 B만 필요. 출처=refstore(암호화 저장, spec/refstore.md). 패턴 C는 미사용
  timeoutMs: number;           // 폰 승인 대기 상한(패턴 B). 패턴 C는 완료 파싱 상한
  approvedSnapshot: string;    // 승인 시점 스냅샷. 실행 직전 재검증 기준(TOCTOU 방어)
}

// PayOutcome → 에이전트向 PaymentResult 매핑은 broker-api.md §2.3이 담당:
//   approved→approved, canceled→canceled(phone_declined), timeout→failed("timeout"), failed→failed
export type PayOutcome =
  | { status: "approved"; orderId: string; amount: number }
  | { status: "canceled" }        // 사용자가 승인 취소/거절(폰)
  | { status: "timeout" }
  | { status: "failed"; error: string };

export interface SimplePayAdapter {
  readonly method: "kakaopay" | "tosspay" | "coupay";
  /** 외부 인간 게이트(폰 승인) 존재 여부. false(쿠팡)면 identity 없이
   *  실행되고 결제는 정책(policy.confirmation)에 걸린다 — 브로커가 별도로
   *  강제하지 않는다(2026-09-23 변경, AGENTS §2.5·§9 잔여 리스크). */
  readonly hasExternalApproval: boolean;   // 카카오/토스=true, 쿠팡=false
  /** 결제창/페이지에서 실제 결제 금액을 독립 파싱 + 스냅샷 산출 */
  verify(tabId: number): Promise<VerifiedCheckout>;
  /** 패턴 B: 식별정보→폰푸시→완료파싱 / 패턴 C: 결제하기 클릭→완료파싱.
   *  실행 직전 verify()를 재실행해 approvedSnapshot과 대조, 불일치면 중단. */
  pay(input: PayInput): Promise<PayOutcome>;
}
```

## 2.1 스냅샷 바인딩 & 실행 직전 재검증 (TOCTOU 방어)

승인(confirm/폰) 대기와 실제 결제 사이에 신뢰하지 않는 에이전트가 결제 대상을
바꿔치기할 수 있다(검사 시점 ≠ 사용 시점). "차단"이 아니라 **"바뀌었으면 중단"**
으로 방어한다.

- **스냅샷 산출**: `verify()`가 결제 대상 핵심 필드(금액·상품·수량·가맹점)를
  정규화해 해시(`snapshot`)로 만든다.
- **승인 바인딩**: 사용자에게 보여주고 승인받은 값이 이 스냅샷이다. `pay()`에
  `approvedSnapshot`으로 전달된다.
- **실행 직전 재검증**: `pay()`는 실제 결제 완료 직전 `verify()`를 다시 호출해
  현재 스냅샷과 `approvedSnapshot`을 비교한다.
  - 일치 → 결제 진행.
  - 불일치 → 결제하지 않고 중단. `PayOutcome=canceled`(사유 로깅), 브로커는
    사용자에게 "내용이 변경되어 취소됨"을 통지하고 재확인을 요구.
- **손 소유 시 추가 방어(①/③)**: 대기 중 에이전트의 페이지 조작 도구 호출은
  브로커가 거부한다(에이전트가 독립 DOM 접근이 없으므로 강제 가능). 별도
  익스텐션(②)에서는 강제 불가하므로 위 재검증이 최종 방어선.

background는 method에 맞는 어댑터를 선택한다(`kakaopay`→`KakaoAdapter`,
`coupay`→`CoupayAdapter`). **`hasExternalApproval===false`(쿠팡)이면 background는
결제 실행 전 정책의 confirm 규칙을 더 보수적으로 적용**한다(외부 게이트가
없으므로) — broker-api 오케스트레이션에서 강제.

## 3. 카카오 어댑터 동작 (payment-flows.md 플로우)

```
verify(tabId):
  - 결제창(online-payment.kakaopay.com)에서 표시 금액 DOM 파싱 → amount
pay(input):
  1. 휴대폰번호/생년월일 입력 필드(일반 input) 채움 → [다음] 클릭
     ※ "기기 기억"으로 입력이 생략되면 이 단계 스킵(검증 항목)
  2. 카카오 서버가 폰으로 카톡 푸시 발송(브로커는 트리거만)
  3. notify로 "폰에서 승인" 안내, 완료/취소/타임아웃까지 대기(timeoutMs)
  4. 쇼핑몰 리다이렉트 완료 페이지에서 주문번호/성공 신호 독립 파싱
     - 성공 → approved(orderId, amount)
     - 사용자 취소 → canceled / 시간초과 → timeout / 그 외 → failed
```

- 셀렉터·완료신호 파싱 지점은 실결제 캡처로 확정(payment-flows.md 검증 항목).

### 2.2 셀렉터 스킴 (`src/executor/selector.ts`)

라이브 캡처(2026-09-22 `checkout.coupang.com`) 결과 **쿠팡 결제창에는 안정적인
CSS 셀렉터가 존재하지 않는다** — 클래스가 전부 Tailwind 자동생성
(`twc-mr-0.5 twc-whitespace-nowrap`)이고 의미 있는 `id`가 없다. 대신 화면
텍스트(라벨·버튼명)는 안정적이므로 어댑터 셀렉터는 스킴을 가진다.

| 스킴 | 의미 | 예 |
|---|---|---|
| `css:<sel>` / `<sel>` | `querySelector` (기본) | `css:[data-amount]` |
| `text:<텍스트>` | 정확 텍스트 요소. 클릭요소(button/a/[role=button]) 우선, 없으면 임의 요소 | `text:결제하기` |
| `contains:<부분 문자열>` | 그 문자열을 포함하는 **화면에 보이는** 가장 안쪽 요소(정확한 문구를 모를 때 — 존재 여부 판정용) | `contains:비밀번호` |
| `label:<라벨>` | 라벨 뒤 문서순 첫 **금액**(`…원`) 요소 | `label:총 결제 금액` |
| `after:<라벨>` | 라벨 뒤 문서순 첫 비어있지 않은 리프 | `after:주문번호` |
| `location:items` | 주소의 `item[]=<상품id>:<수량>` — 주문 내용 스냅샷 키 | — |

구현 주의:
- `text:`만 XPath(`document.evaluate`)를 쓰고, **라벨류(`contains:`/`label:`/
  `after:`)는 XPath를 쓰지 않는다** — XPath의 `normalize-space()`가 ASCII 공백만
  처리해 NBSP(U+00A0)가 섞인 한국어 라벨을 못 맞추기 때문에, 유니코드 공백을
  정규화(`normText`)한 순수 JS 순회로 찾는다. linkedom(픽스처 테스트)에도
  동일 경로가 적용돼 테스트가 실제 동작을 검증한다.
- 라벨 앵커는 **부분 포함 + 가장 안쪽(같은 문자열을 포함하는 자식이 없는) +
  화면에 보이는** 요소로 찾는다. 강조 태그로 한 겹 감싸여 있어도(`<b>총 결제
  금액</b>`) 잡히고, 숨겨진(미리 렌더된 모달) 사본은 무시한다.
- **라이브 함정 ①(빈 `원` 노드)**: 라벨 뒤에 숫자 없는 빈 `원` 노드가 올 수
  있어 `label:`은 금액성(`[\d,]{2,}원`)을 재검증하고 실패 시 다음 후보로 넘어간다.
- **라이브 함정 ②(숫자와 단위 분리)**: 쿠팡은 금액 숫자와 `원` 단위를 **서로
  다른 형제 리프**로 렌더링한다(`<span>16,300</span><span>원</span>` — 한 리프에
  `16,300원`으로 합쳐져 있지 않다). 리프 하나만 보고 `[\d,]{2,}\s*원`을
  검사하면 둘 다 탈락해 건너뛰고, 그 뒤 우연히 숫자+원이 한 리프에 같이 있는
  무관한 값(적립 배지 `163원 적립` 등)을 잘못 집는다. 그래서 숫자만 있는
  리프(`^[\d,]{2,}$`)를 만나면 **바로 다음 비어있지 않은 리프가 `원`으로
  시작하는지** 확인해 금액으로 인정한다.
- **라이브 함정 ③(제목 vs 라벨)**: `최종 결제 금액`은 값이 붙은 라벨이 아니라
  **섹션 제목**이고, 그 뒤 첫 금액은 할인 전 `총 상품 가격`이다 → amount 앵커는
  반드시 `총 결제 금액`을 쓴다.
- `chrome.scripting.executeScript`는 함수를 소스로 직렬화해 주입하므로 모듈
  참조가 불가하다 → `platform/chrome-page-bridge.ts`의 `pageOp`가 리졸버를
  **인라인 복제**한다. ⚠️ 자동 동등성 테스트가 없어(브라우저 전역 의존) 실제로
  두 번이나 한쪽만 고치고 라이브에서 조용히 실패한 이력이 있다 —
  **`selector.ts`의 스킴·매칭 규칙을 바꾸면 반드시 `pageOp`도 같이 고칠 것.**
- 상품 DOM 앵커가 없어 `itemsKey`는 DOM이 아니라 **URL의 `item[]`** 에서 얻는다.
  금액이 같아도 상품이 바뀌면 스냅샷이 달라져 TOCTOU가 잡힌다.
- **금액 독립 검증**: `verify()`의 amount를 policy가 `verifiedAmount`로 사용.
  에이전트가 주장한 `totalAmount`와 불일치면 policy가 `amount_mismatch`로 deny.

## 3.1 쿠팡 어댑터 동작 (패턴 C, `hasExternalApproval:false`)

```
verify(tabId):
  - 쿠팡 인-페이지 체크아웃에서 결제 예정 금액 DOM 파싱 → amount
pay(input):
  1. (원터치 결제 ON 전제) [결제하기] 클릭  ← 식별정보·폰 승인 없음
  2. 6자리 비번 UI가 (보이는 상태로) 나타나면 → **§3.2 비밀번호 핸드오프**
     (브로커는 키패드에 손대지 않고 사용자 직접 입력을 기다린다)
  3. 인-페이지 완료 상태(주문완료 화면/주문번호) 독립 파싱
     - 성공 → approved(orderId, amount)
     - timeoutMs 내 미완료 → timeout / 그 외 → failed
```

## 3.2 비밀번호 핸드오프 (패턴 C, 2026-09-23)

원터치가 켜져 있어도 쿠팡 FDS가 리스크 판단으로 6자리 비번을 재요구할 수 있다
(쿠팡의 의도된 보안 동작 — 우회 대상 아님, AGENTS §2.5). 이전엔 즉시
`failed(password_required)`로 끝냈으나, 그러면 사람이 직접 입력해 결제를 마쳐도
감사·통지 흐름 밖으로 빠진다. 그래서 **사람에게 넘기고(handoff) 결과만 독립
파싱**한다 — 패턴 B의 "폰 승인 대기"와 같은 구조를 브라우저 안에서 한다.

```
awaitCompletion 폴링 중 passwordUi(보이는 요소) 최초 감지:
  1. onPasswordRequired() 1회 호출 → 브로커가 notify("enter_password_on_page")
     "○○원 — 결제 탭에서 비밀번호를 직접 입력하세요"
  2. 대기 상한을 handoffTimeoutMs(기본 10분)로 **재설정**한 뒤 계속 폴링
     (키패드·입력칸에 어떤 조작도 하지 않음)
     - 완료 신호+주문번호 파싱(동일 origin) → approved
     - 경과 → timeout (사용자가 입력 안 함/취소)
  3. onPasswordRequired 미주입(구 호출부) → 기존대로 failed(password_required)
```

**불변식 (핸드오프 중)**
- 브로커는 비번 값을 읽거나(`readText`로 입력칸 값 조회 없음), 채우거나, 키패드를
  클릭하지 않는다. 감지는 "비밀번호" 문구가 **보이는지**만 본다(§2.2 `contains:`).
- **에이전트 페이지 도구 잠금**: 결제 실행 중(executing 색인 비어있지 않음)에는
  브리지의 `open`/`read_page`/`click`/`fill`을 `page_locked_during_payment`로
  거부한다(§2.1 "손 소유 시 추가 방어"의 구현). 사용자가 입력하는 동안 에이전트가
  페이지를 읽거나 키패드를 누를 수 없다. `get_payment_result`/
  `get_policy_summary`는 허용(상태만 반환, 비밀 없음).
- **read_page는 `input[type=password]` 값을 절대 반환하지 않는다**(잠금과 무관한
  상시 방어 — 잠금이 풀린 뒤에도 값이 남아있을 수 있으므로).
- 에이전트向 결과는 핸드오프 중에도 `pending_user_confirmation` 그대로(새 상태
  없음 — broker-api 표면 불변).

**대기 상한 (2026-09-25 실사용 수정)**
자동 진행용 `payTimeoutMs`(기본 180s)를 사람 입력에도 그대로 쓰면 **입력 중에
타임아웃**이 난다(실제로 발생 — 사용자가 비번을 입력하기 전에 `failed(timeout)`).
그러면 **쿠팡에선 결제가 되고 우리 기록은 `failed`** 인 최악의 불일치가 생길 수
있다. 그래서 핸드오프 감지 시점에 상한을 `handoffTimeoutMs`(기본 600s)로 다시
잡는다.
- ⚠️ `recoverStaleExecutions`의 `staleAfterMs` 기준(`payTimeoutMsValue`)은
  **실제 최대 대기 시간**(= `max(payTimeoutMs, handoffTimeoutMs)`)이어야 한다.
  더 작으면 5분 틱 스윕이 정상 대기 중인 핸드오프를 `failed(interrupted)`로
  오판한다. 회귀 테스트: `broker-core.test.ts` #21·#22.
- 타임아웃 후 사용자가 뒤늦게 비번을 입력하면 여전히 불일치가 남는다 —
  **미해결**(AGENTS §9 핸드오프 취소 UX). 현재는 타임아웃 시 사용자에게
  결제창을 닫으라고 안내하는 것 외엔 방법이 없다.

- **외부 게이트가 없으므로** background가 confirm 게이트를 담당한다
  (정책 임계값·비지정 구매는 사용자 확인 필수). 완료 후 즉시 통지 필수.
- **비밀번호를 브로커가 입력하지 않는다**: 6자리 비번 입력 UI가 나타나면 브로커는
  멈추고 사용자에게 넘긴다(§3.2 핸드오프). 입력은 100% 사용자(§2.5 금지).

## 4. 불변식

- 결제 비밀번호·카드번호를 입력하거나 저장하지 않는다. 화면에서 채우는 건
  휴대폰번호·생년월일(PII)뿐.
- 보안 키패드를 합성 클릭으로 조작하지 않는다(대상 결제수단엔 애초에 없음).
- 완료 판정은 **에이전트 보고가 아니라** 쇼핑몰 완료 신호의 독립 파싱에 근거.
- **실행 직전 스냅샷이 `approvedSnapshot`과 불일치하면 결제하지 않는다**
  (§2.1 TOCTOU 방어). "승인한 것 ≠ 결제되는 것"을 원천 차단.
- `identity`(PII)는 로그·에러·audit에 원문으로 남기지 않는다.
- 패턴 B의 최종 결제 승인은 폰에서 사용자가 수행(대행 불가).
- 패턴 C(쿠팡): 결제 비밀번호를 입력하지 않는다. 비번 UI 등장 시 사용자
  핸드오프(§3.2) — 통지 후 사용자 직접 입력을 기다리고 완료만 독립 파싱. 외부
  게이트가 없으므로 confirm 게이트·즉시 통지로 사용자 인지 보장.
- 결제 실행 중 에이전트의 페이지 도구는 잠긴다(§3.2). read_page는 비번 입력칸
  값을 반환하지 않는다.

## 5. 수용 기준

- [ ] `SimplePayAdapter` 인터페이스 정의, `KakaoAdapter` 구현
- [ ] `verify()`가 결제창 금액 + 스냅샷을 반환하고 policy 검증에 연결됨
- [ ] `pay()`가 실행 직전 재검증으로 스냅샷 불일치 시 결제 중단(canceled)
- [ ] 승인/취소/타임아웃/실패 4경로 모두 처리
- [ ] 완료 신호를 독립 파싱해 orderId 확보(에이전트 보고 미사용)
- [ ] PII·비밀이 로그/audit에 원문으로 없음
- [ ] (후속) `TossAdapter`를 동일 인터페이스로 추가

## 6. 테스트 케이스

> E2E는 테스트 쇼핑몰/모킹 결제창으로. 실제 카드·계정 금지(methodology §안전).

1. `verify()`가 결제창 표시 금액을 정확히 파싱
2. `pay()` 정상: 승인 완료 신호 → `approved(orderId, amount)`
3. 사용자 취소 → `canceled`
4. 승인 지연 → `timeout` (timeoutMs 경과)
5. 완료 신호 파싱 실패 → `failed`
6. "기기 기억" 상태: 식별정보 입력 스킵 후에도 정상 완료
7. `verify()` 금액 ≠ 요청 총액 → (policy에서) `amount_mismatch` deny 유발
8. 로그/audit에 phone·birth 원문 없음(grep)

### TOCTOU (스냅샷 재검증)
A. 승인 후 대기 중 금액/상품 변경 → 실행 직전 재검증 불일치 → 결제 중단(canceled)
B. 변경 없음 → 스냅샷 일치 → 정상 결제

### 쿠팡(패턴 C) 전용
9. `CoupayAdapter.hasExternalApproval === false`
10. 원터치 ON: [결제하기] 클릭 → 주문완료 파싱 → `approved`
11. 결제 중 6자리 비번 UI 등장 → 핸드오프 통지 1회 → 사용자 입력 후 완료 파싱
    → `approved` / 미입력 → `timeout`. 브로커는 비번 입력칸을 fill·click하지 않음
11b. onPasswordRequired 미주입 → 기존대로 `failed(password_required)`
11c. 결제 실행 중 브리지 `read_page`/`click`/`fill`/`open` → `page_locked_during_payment`
11d. `read_page`가 `input[type=password]` 값을 반환하지 않음
12. `hasExternalApproval:false` → background가 confirm 게이트 적용(통합 테스트)
