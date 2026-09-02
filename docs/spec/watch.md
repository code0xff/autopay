# Spec: 감시 엔진 (`broker-extension/watch`)

## 1. 목적

플래그십(§1.1) "지정가 자동 구매"의 엔진. 사용자가 지정한 상품·조건을 모니터링
하다가 **조건 충족 시 결제 요청을 생성**한다. 에이전트는 무엇을 살지 판단하지
않고, 사용자가 정한 조건의 "타이밍"만 실행한다.

**비책임**: 결제 판정(policy)·실행(executor)·UI 렌더링(ui). 감시는 조건 감지와
트리거까지만. 트리거된 결제도 반드시 정책 게이트를 통과한다.

## 2. 계약

```typescript
import { z } from "zod";
import { Amount, PaymentMethod } from "shared";

export const WatchSpec = z.object({
  id: z.string(),
  productRef: z.string(),        // 상품 URL 또는 식별자
  title: z.string(),
  maxPrice: Amount,              // 상한가(이하일 때만 구매)
  freeShippingOnly: z.boolean(), // 배송비 포함가로 비교
  buyOnRestock: z.boolean(),     // 품절 시 입고까지 대기
  method: PaymentMethod,
  status: z.enum(["watching", "condition_met", "purchased", "paused", "failed"]),
  lastCheckedAt: z.string().optional(),
  lastPrice: Amount.optional(),
});
export type WatchSpec = z.infer<typeof WatchSpec>;

export interface WatchEngine {
  add(spec: Omit<WatchSpec, "id" | "status">): Promise<WatchSpec>;
  list(): Promise<WatchSpec[]>;
  remove(id: string): Promise<void>;
  pause(id: string, paused: boolean): Promise<void>;
  /** 스케줄러가 호출: 한 항목의 현재가·재고 확인 → 조건 평가 */
  check(id: string): Promise<void>;
}
```

## 3. 동작

```
스케줄: chrome.alarms로 주기 폴링(항목별, 과도한 빈도 금지 — 최소 간격 준수)
check(id):
  1. productRef 페이지의 현재가·재고를 "손"(content script)으로 파싱
     (freeShippingOnly면 배송비 포함가로 비교)
  2. lastPrice/lastCheckedAt 갱신
  3. 조건 평가:
       - 재고 없음 && buyOnRestock=false → 대기
       - 현재가 ≤ maxPrice && (무료배송 조건 충족) → status=condition_met
  4. condition_met → broker.requestPayment(req) 생성
       → 정책 검증(policy) → allow/confirm/deny (broker-api)
       → 결제 성공 시 status=purchased(1회성은 감시 종료), 실패 시 failed/watching
```

- 저장: `chrome.storage.local`의 watches 컬렉션(WatchSpec).
- **maxPrice는 정책 위에 얹는 사용자 지정 상한**이지 정책을 대체하지 않는다.
  트리거된 결제도 한도·머천트·카테고리·횟수 정책을 그대로 통과해야 한다.

## 4. 불변식

- 감시가 스스로 결제를 완료하지 않는다. 항상 `requestPayment` → 정책 게이트를
  거친다(감시는 트리거일 뿐).
- 현재가가 `maxPrice`를 초과하면 결제 요청을 만들지 않는다.
- 폴링 간격은 최소 간격을 지킨다(과도한 요청·FDS 유발 금지, §2.5 무우회 원칙).
- 조건 판정에 쓰는 가격은 "손"이 실제 페이지에서 파싱한 값(에이전트 주장 아님).

## 5. 수용 기준

- [ ] add/list/remove/pause/check 구현, WatchSpec 저장(chrome.storage.local)
- [ ] check가 현재가 파싱 → 조건 평가 → condition_met 시 requestPayment 트리거
- [ ] 상한가 초과 시 트리거 안 함
- [ ] 트리거된 결제가 정책 게이트를 통과(통합 테스트로 확인)
- [ ] 폴링 최소 간격 준수(alarms)

## 6. 테스트 케이스

1. 현재가 ≤ maxPrice → condition_met + requestPayment 호출
2. 현재가 > maxPrice → 트리거 없음, status=watching 유지
3. freeShippingOnly=true, 유료배송 → 배송비 포함가로 비교해 미충족
4. 재고 없음 + buyOnRestock=false → 대기
5. condition_met이지만 정책 deny → 결제 안 됨, status=failed/watching
6. pause 후 check → 트리거 없음
