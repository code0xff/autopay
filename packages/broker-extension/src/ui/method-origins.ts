import type { PaymentPolicy } from "@autopay/shared";

type Method = PaymentPolicy["methods"][number];

// 결제수단별 기본 머천트 오리진 — 정책 엔진은 request.merchant.origin을 allowlist와
// 정확히 일치 비교한다(policy/engine.ts). 쿠팡은 기본 정책(compose.ts DEFAULT_POLICY)과
// 같은 3개(상품·메인·체크아웃). 네이버는 어댑터 verify 픽스처(smartstore.naver.com)와
// 주문/결제 도메인(order.pay.naver.com)을 쓰되 둘 다 라이브 캡처 전의 잠정값이다.
// 카카오·토스는 가맹점마다 달라 기본값이 없다.
export const METHOD_DEFAULT_ORIGINS: Record<Method, readonly string[]> = {
  coupay: ["https://coupang.com", "https://www.coupang.com", "https://checkout.coupang.com"],
  naverpay: ["https://smartstore.naver.com", "https://order.pay.naver.com"],
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
