import type { Decision, PaymentPolicy, PaymentRequest, UsageSnapshot } from "@autopay/shared";

/**
 * 정책 엔진 — 순수 함수. 같은 입력 → 같은 출력. (docs/spec/policy.md)
 * 부수효과 없음: 시계·스토리지·랜덤 접근 금지(현재 시각·사용량은 인자로 주입).
 *
 * @param verifiedAmount executor가 체크아웃에서 독립 파싱한 실제 결제 금액.
 *        생략 시(사전 판정) amount_mismatch 검사를 건너뜀.
 *
 * 판정 순서는 고정이며, 다중 위반 시 아래 순서상 첫 위반을 반환한다(결정적).
 * 입력은 이미 shared 스키마로 검증된 것으로 가정(여기서 throw 하지 않음).
 */
export function evaluate(
  request: PaymentRequest,
  policy: PaymentPolicy,
  usage: UsageSnapshot,
  verifiedAmount?: number,
): Decision {
  const amount = verifiedAmount ?? request.totalAmount;

  // 1. amount_mismatch
  if (verifiedAmount !== undefined && request.totalAmount !== verifiedAmount) {
    return { type: "deny", violation: "amount_mismatch" };
  }
  // 2. method_not_allowed
  if (!policy.methods.includes(request.method)) {
    return { type: "deny", violation: "method_not_allowed" };
  }
  // 3. merchant_not_allowed
  if (
    policy.merchants.mode === "allowlist" &&
    !policy.merchants.origins.includes(request.merchant.origin)
  ) {
    return { type: "deny", violation: "merchant_not_allowed" };
  }
  // 4. category_not_allowed
  if (violatesCategory(request, policy)) {
    return { type: "deny", violation: "category_not_allowed" };
  }
  // 5. over_per_transaction (경계는 초과에서만 위반: > 위반, === 허용)
  if (amount > policy.limits.perTransaction) {
    return { type: "deny", violation: "over_per_transaction" };
  }
  // 6. over_count
  if (usage.countToday + 1 > policy.limits.maxTransactionsPerDay) {
    return { type: "deny", violation: "over_count" };
  }
  // 7. over_daily
  if (usage.spentToday + amount > policy.limits.daily) {
    return { type: "deny", violation: "over_daily" };
  }
  // 8. over_monthly
  if (usage.spentThisMonth + amount > policy.limits.monthly) {
    return { type: "deny", violation: "over_monthly" };
  }
  // 9. confirm 판정
  if (policy.confirmation.alwaysConfirm) {
    return { type: "confirm", reason: "always" };
  }
  if (amount > policy.confirmation.requireUserConfirmationAbove) {
    return { type: "confirm", reason: "threshold" };
  }
  // 10. allow
  return { type: "allow" };
}

/** 카테고리 규칙 (docs/spec/policy.md §3):
 *  - allowlist: 모든 item.category가 values에 포함되어야 통과. 미지정 item이 있으면 위반(보수적).
 *  - denylist: 어떤 item.category라도 values에 포함되면 위반. 미지정 item은 통과. */
function violatesCategory(request: PaymentRequest, policy: PaymentPolicy): boolean {
  const { mode, values } = policy.categories;
  if (mode === "allowlist") {
    return !request.items.every((i) => i.category !== undefined && values.includes(i.category));
  }
  return request.items.some((i) => i.category !== undefined && values.includes(i.category));
}
