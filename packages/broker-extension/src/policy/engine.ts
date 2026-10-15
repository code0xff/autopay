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
    !originAllowed(request.merchant.origin, policy.merchants.origins)
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

/**
 * 머천트 allowlist 매칭: 정확 일치, 또는 `https://*.D` 항목에 대해 요청 호스트가
 * D 이거나 `.D`로 끝나는 https 오리진. 문자열 접미사가 아니라 호스트 라벨 경계로 비교한다
 * (`https://evilcoupang.com`은 `*.coupang.com`에 불일치). 순수 함수.
 */
function originAllowed(origin: string, entries: readonly string[]): boolean {
  if (entries.includes(origin)) return true;
  let host: string;
  try {
    const u = new URL(origin);
    if (u.protocol !== "https:") return false;
    host = u.hostname.toLowerCase();
  } catch {
    return false;
  }
  return entries.some((e) => {
    if (!e.startsWith("https://*.")) return false;
    const d = e.slice("https://*.".length).toLowerCase();
    return host === d || host.endsWith(`.${d}`);
  });
}
