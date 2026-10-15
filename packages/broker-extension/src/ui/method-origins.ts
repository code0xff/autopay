import type { PaymentPolicy } from "@autopay/shared";

type Method = PaymentPolicy["methods"][number];

// 결제수단별 기본 머천트 오리진 — 정책 엔진은 정확 일치 또는 `https://*.도메인`
// 와일드카드로 비교한다(policy/engine.ts, 2026-10-15 사용자 결정: 편의 우선).
// 쿠팡은 기본 정책(compose.ts DEFAULT_POLICY)과 같은 와일드카드. 네이버도 *.naver.com
// (blog/cafe 등 사용자 콘텐츠 서브도메인 포함 — 잔여 리스크, policy.md).
// 카카오·토스는 가맹점마다 달라 기본값이 없다.
export const METHOD_DEFAULT_ORIGINS: Record<Method, readonly string[]> = {
  coupay: ["https://*.coupang.com"],
  naverpay: ["https://*.naver.com"],
  kakaopay: [],
  tosspay: [],
};

/** 결제수단을 켤 때: allowlist 모드에서만 기본 오리진을 중복 없이 뒤에 붙인다. */
export function addMethodOrigins(
  merchants: PaymentPolicy["merchants"],
  method: Method,
): { origins: string[]; added: string[] } {
  if (merchants.mode !== "allowlist") return { origins: merchants.origins, added: [] };
  const added = METHOD_DEFAULT_ORIGINS[method].filter((o) => !merchants.origins.includes(o));
  return { origins: [...merchants.origins, ...added], added };
}

/** 결제수단을 끌 때: 남은(켜진) 수단이 필요로 하지 않는 기본 오리진만 제거한다. */
export function removeMethodOrigins(
  merchants: PaymentPolicy["merchants"],
  method: Method,
  remainingMethods: readonly Method[],
): { origins: string[]; removed: string[] } {
  if (merchants.mode !== "allowlist") return { origins: merchants.origins, removed: [] };
  const stillNeeded = new Set(remainingMethods.flatMap((m) => METHOD_DEFAULT_ORIGINS[m]));
  const removed = METHOD_DEFAULT_ORIGINS[method].filter(
    (o) => !stillNeeded.has(o) && merchants.origins.includes(o),
  );
  return { origins: merchants.origins.filter((o) => !removed.includes(o)), removed };
}
