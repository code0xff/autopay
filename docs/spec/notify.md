# Spec: 알림 (`broker-extension/notify`)

## 1. 목적

결제 관련 이벤트를 **브로커가 직접** 사용자에게 통지한다. 에이전트를 거치지
않으므로 허위 완료 보고를 방지한다(AGENTS.md §5 위협모델). MVP 채널은
`chrome.notifications`. 텔레그램/이메일/webhook은 선택(원격 니즈 확인 시).

**비책임**: 판정·실행. 통지와 (confirm 시) 사용자 확인 UI 노출만.

## 2. 계약

```typescript
export type NotifyEvent =
  | { kind: "confirm_required"; merchant: string; amount: number; requestId: string }
  | { kind: "approve_on_phone"; merchant: string; amount: number; method: "kakaopay"|"tosspay" }
  | { kind: "completed"; merchant: string; amount: number; orderId: string }
  | { kind: "rejected"; merchant: string; amount: number; violation: string }
  | { kind: "failed"; merchant: string; amount: number; error: string };

export interface Notifier {
  notify(event: NotifyEvent, channels: Array<"chrome"|"telegram"|"email"|"webhook">): Promise<void>;
}
```

- `confirm_required` / `approve_on_phone`은 진행 중 안내(사용자 액션 유도).
- `completed` / `rejected` / `failed`는 종료 통지.
- 채널은 정책의 `notifications.channels`를 따른다. MVP는 `chrome`만 구현하고
  나머지 채널은 no-op 또는 미구현(선택 도입).

## 3. 불변식

- 완료 통지는 **브로커가 직접** 발송(에이전트 경유 아님).
- 알림 본문에 비밀·빌링키·PII(휴대폰번호·생년월일) 원문을 넣지 않는다.
  금액·가맹점명·주문번호까지만.
- `notifyOnRejection===false`면 `rejected` 이벤트는 발송하지 않는다.

## 4. 수용 기준

- [ ] `chrome` 채널로 각 이벤트가 알림으로 표시됨
- [ ] 정책 `channels`/`notifyOnRejection` 설정을 반영
- [ ] 미구현 채널 지정 시 안전하게 무시(에러로 흐름 중단 없음)
- [ ] 알림 본문에 비밀·PII 원문 없음

## 5. 테스트 케이스

1. `completed` → chrome 알림에 금액·가맹점·주문번호 표시
2. `approve_on_phone` → "폰에서 승인" 안내 표시
3. `rejected` + `notifyOnRejection:false` → 발송 안 함
4. `rejected` + `notifyOnRejection:true` → 발송함
5. 채널에 `telegram`(미구현) 포함 → chrome은 발송, telegram은 무시(에러 없음)
6. 알림 본문에 phone/birth/빌링키 문자열 없음
