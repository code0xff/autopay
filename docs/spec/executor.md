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
  /** 외부 인간 게이트(폰 승인) 존재 여부. false면 브로커가 확인 게이트 강제 */
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
- **금액 독립 검증**: `verify()`의 amount를 policy가 `verifiedAmount`로 사용.
  에이전트가 주장한 `totalAmount`와 불일치면 policy가 `amount_mismatch`로 deny.

## 3.1 쿠팡 어댑터 동작 (패턴 C, `hasExternalApproval:false`)

```
verify(tabId):
  - 쿠팡 인-페이지 체크아웃에서 결제 예정 금액 DOM 파싱 → amount
pay(input):
  1. (원터치 결제 ON 전제) [결제하기] 클릭  ← 식별정보·폰 승인 없음
     ※ 원터치 OFF라 6자리 비번을 요구하면 즉시 failed로 중단(비번 입력 금지)
  2. 인-페이지 완료 상태(주문완료 화면/주문번호) 독립 파싱
     - 성공 → approved(orderId, amount)
     - 비번 요구/차단 → failed  / 그 외 → failed
```

- **외부 게이트가 없으므로** background가 confirm 게이트를 담당한다
  (정책 임계값·비지정 구매는 사용자 확인 필수). 완료 후 즉시 통지 필수.
- **비밀번호 경로 진입 금지**: 결제 과정에서 6자리 비번 입력 UI가 나타나면
  진행하지 않고 failed 반환(§2.5 금지). 원터치가 전제 조건.

## 4. 불변식

- 결제 비밀번호·카드번호를 입력하거나 저장하지 않는다. 화면에서 채우는 건
  휴대폰번호·생년월일(PII)뿐.
- 보안 키패드를 합성 클릭으로 조작하지 않는다(대상 결제수단엔 애초에 없음).
- 완료 판정은 **에이전트 보고가 아니라** 쇼핑몰 완료 신호의 독립 파싱에 근거.
- **실행 직전 스냅샷이 `approvedSnapshot`과 불일치하면 결제하지 않는다**
  (§2.1 TOCTOU 방어). "승인한 것 ≠ 결제되는 것"을 원천 차단.
- `identity`(PII)는 로그·에러·audit에 원문으로 남기지 않는다.
- 패턴 B의 최종 결제 승인은 폰에서 사용자가 수행(대행 불가).
- 패턴 C(쿠팡): 결제 비밀번호를 입력하지 않는다. 비번 UI 등장 시 failed로
  중단. 외부 게이트가 없으므로 confirm 게이트·즉시 통지로 사용자 인지 보장.

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
11. 결제 중 6자리 비번 UI 등장 → `failed`(비번 미입력), 진행 중단
12. `hasExternalApproval:false` → background가 confirm 게이트 적용(통합 테스트)
