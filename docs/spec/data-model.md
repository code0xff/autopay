# Spec: 공용 데이터 모델 (`shared`)

## 1. 목적

신뢰 경계를 넘는 모든 메시지와 저장 레코드의 **단일 진실**. 모든 타입은 Zod
스키마로 정의하고, 스키마에서 TS 타입을 추론(`z.infer`)한다. 경계에서
`schema.safeParse()` 실패 = 즉시 거절.

**비책임**: 비즈니스 로직 없음(정책 판정은 policy 모듈). 비밀·빌링키 원문을
담는 필드를 정의하지 않는다.

## 2. 계약 (스키마)

> 통화는 KRW 기준, 금액은 **정수(원)**. 소수 없음. 다통화는 범위 밖.

```typescript
import { z } from "zod";

// ── 금액/상품 ────────────────────────────────
export const Currency = z.literal("KRW");            // MVP는 KRW만
export const Amount = z.number().int().nonnegative(); // 원 단위 정수

// ── 결제수단 (단일 진실. 다른 스펙·모듈은 이걸 참조) ──
// kakao/toss=패턴 B(폰 승인), coupay=패턴 C(원터치)
export const PaymentMethod = z.enum(["kakaopay", "tosspay", "coupay"]);
export type PaymentMethod = z.infer<typeof PaymentMethod>;

export const LineItem = z.object({
  title: z.string().min(1),
  category: z.string().optional(),   // 정책 카테고리 매칭용
  quantity: z.number().int().positive(),
  unitPrice: Amount,
});

// ── 결제 요청 (에이전트 → 브로커) ──────────────
export const Merchant = z.object({
  origin: z.string().url(),          // 쇼핑몰 origin (정책 머천트 매칭 키)
  name: z.string().min(1),
});

export const PaymentRequest = z.object({
  merchant: Merchant,
  items: z.array(LineItem).min(1),
  totalAmount: Amount,               // 에이전트가 주장하는 총액(검증 대상)
  currency: Currency,
  method: PaymentMethod,
  checkoutTabId: z.number().int(),   // 체크아웃 진행 탭
});
export type PaymentRequest = z.infer<typeof PaymentRequest>;

// ── 정책 ─────────────────────────────────────
export const PaymentPolicy = z.object({
  limits: z.object({
    perTransaction: Amount,
    daily: Amount,
    monthly: Amount,
    maxTransactionsPerDay: z.number().int().nonnegative(),
  }),
  merchants: z.object({
    mode: z.enum(["allowlist", "any"]),
    origins: z.array(z.string().url()),
  }),
  categories: z.object({
    mode: z.enum(["allowlist", "denylist"]),
    values: z.array(z.string()),
  }),
  methods: z.array(PaymentMethod).min(1),
  confirmation: z.object({
    requireUserConfirmationAbove: Amount, // 초과 시 명시적 확인 요구
    alwaysConfirm: z.boolean(),           // true면 모든 건 확인
  }),
  notifications: z.object({
    channels: z.array(z.enum(["chrome", "telegram", "email", "webhook"])),
    notifyOnRejection: z.boolean(),
  }),
});
export type PaymentPolicy = z.infer<typeof PaymentPolicy>;

// ── 사용량 스냅샷 (정책 엔진 입력, 순수성 유지용) ──
export const UsageSnapshot = z.object({
  spentToday: Amount,
  spentThisMonth: Amount,
  countToday: z.number().int().nonnegative(),
});
export type UsageSnapshot = z.infer<typeof UsageSnapshot>;

// ── 판정 결과 (정책 엔진 출력) ─────────────────
export const PolicyViolation = z.enum([
  "merchant_not_allowed",
  "category_not_allowed",
  "method_not_allowed",
  "over_per_transaction",
  "over_daily",
  "over_monthly",
  "over_count",
  "amount_mismatch",     // 검증된 실제 금액과 요청 총액 불일치
]);
export const Decision = z.discriminatedUnion("type", [
  z.object({ type: z.literal("allow") }),
  z.object({ type: z.literal("confirm"), reason: z.enum(["threshold", "always"]) }),
  z.object({ type: z.literal("deny"), violation: PolicyViolation }),
]);
export type Decision = z.infer<typeof Decision>;

// ── 결과 (브로커 → 에이전트) ───────────────────
// 에이전트向 결과는 내부 AuditRecord보다 거칠다(정보 최소화, §4 격리).
// executor PayOutcome → PaymentResult 매핑: approved→approved, canceled→canceled,
// timeout→failed(error:"timeout"), failed→failed. policy deny→rejected.
export const PaymentResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("approved"),
    receipt: z.object({ amount: Amount, merchant: z.string(), orderId: z.string(), at: z.string() }) }),
  z.object({ status: z.literal("rejected"), violation: PolicyViolation }),
  z.object({ status: z.literal("pending_user_confirmation") }),
  // 사용자가 승인 단계(confirm 또는 폰)에서 거절/미응답 → 미결제
  z.object({ status: z.literal("canceled"), reason: z.enum(["user_declined", "phone_declined", "confirm_timeout"]) }),
  z.object({ status: z.literal("failed"), error: z.string() }), // timeout 포함
]);
export type PaymentResult = z.infer<typeof PaymentResult>;

// ── 감사 레코드 (불변 기록) ────────────────────
export const AuditRecord = z.object({
  id: z.string(),                    // uuid
  at: z.string(),                    // ISO8601
  merchant: Merchant,
  amount: Amount,
  method: PaymentMethod,
  decision: Decision,
  outcome: z.enum(["approved", "rejected", "failed", "canceled", "timeout", "confirm_required"]),
  orderId: z.string().optional(),    // 성공 시 쇼핑몰 주문번호
  // 비밀·빌링키·PII 원문 금지 (methodology §3)
});
export type AuditRecord = z.infer<typeof AuditRecord>;
```

## 3. 불변식

- 어떤 스키마에도 카드번호·CVV·결제 비밀번호·빌링키 원문 필드가 없다.
- `Amount`는 항상 정수·음수 아님. 파싱 단계에서 강제.
- `PaymentResult`/`Decision`/`AuditRecord`는 판별 유니온으로 상태 누락 불가.

## 4. 수용 기준

- [ ] `shared`에서 위 스키마를 export하고 `z.infer` 타입도 export
- [ ] 잘못된 입력(음수 금액, 미지원 method, 잘못된 origin)이 `safeParse`
      실패로 걸러짐을 테스트로 확인
- [ ] 스키마에 비밀/빌링키/PII 원문 필드가 없음(리뷰로 확인)

## 5. 테스트 케이스

1. 유효한 `PaymentRequest` → `safeParse.success === true`
2. `totalAmount: -100` → 실패
3. `method: "naverpay"` → 실패(enum 밖)
4. `merchant.origin: "not-a-url"` → 실패
5. `items: []` → 실패(min 1)
6. `Decision` 각 변형 라운드트립(parse→infer) 일치
