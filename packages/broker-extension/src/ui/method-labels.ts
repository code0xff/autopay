import type { PaymentPolicy } from "@autopay/shared";

// 결제수단 표시 이름(한글 통일). 내부 id(coupay 등)는 화면에 그대로 노출하지 않는다.
export const METHOD_LABELS: Record<PaymentPolicy["methods"][number], string> = {
  coupay: "쿠페이",
  kakaopay: "카카오페이",
  tosspay: "토스페이",
  naverpay: "네이버페이",
};
