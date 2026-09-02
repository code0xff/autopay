import { describe, expect, it } from "vitest";
import { Decision, PaymentRequest } from "./schema.js";

// docs/spec/data-model.md §5 테스트 케이스
const validReq = {
  merchant: { origin: "https://shop.example", name: "Shop" },
  items: [{ title: "무선 키보드", category: "keyboard", quantity: 1, unitPrice: 20000 }],
  totalAmount: 20000,
  currency: "KRW",
  method: "kakaopay",
  checkoutTabId: 1,
};

describe("data-model schemas", () => {
  it("1. 유효한 PaymentRequest → success", () => {
    expect(PaymentRequest.safeParse(validReq).success).toBe(true);
  });

  it("2. totalAmount 음수 → 실패", () => {
    expect(PaymentRequest.safeParse({ ...validReq, totalAmount: -100 }).success).toBe(false);
  });

  it("3. 미지원 method(naverpay) → 실패", () => {
    expect(PaymentRequest.safeParse({ ...validReq, method: "naverpay" }).success).toBe(false);
  });

  it("4. 잘못된 merchant.origin → 실패", () => {
    expect(
      PaymentRequest.safeParse({
        ...validReq,
        merchant: { origin: "not-a-url", name: "Shop" },
      }).success,
    ).toBe(false);
  });

  it("5. 빈 items → 실패", () => {
    expect(PaymentRequest.safeParse({ ...validReq, items: [] }).success).toBe(false);
  });

  it("6. Decision 각 변형 라운드트립", () => {
    expect(Decision.parse({ type: "allow" })).toEqual({ type: "allow" });
    expect(Decision.parse({ type: "confirm", reason: "threshold" })).toEqual({
      type: "confirm",
      reason: "threshold",
    });
    expect(Decision.parse({ type: "deny", violation: "over_daily" })).toEqual({
      type: "deny",
      violation: "over_daily",
    });
  });

  // Codex 리뷰 반영 — 격리 강화
  it("7. 미지의 필드(cardNumber) → strict 거절 (조용히 버리지 않음)", () => {
    const withSecret = { ...validReq, cardNumber: "4111111111111111", cvv: "123" };
    expect(PaymentRequest.safeParse(withSecret).success).toBe(false);
  });

  it("8. origin에 자격증명/경로/비-https → 거절", () => {
    const bad = (origin: string) =>
      PaymentRequest.safeParse({ ...validReq, merchant: { origin, name: "S" } }).success;
    expect(bad("https://user:pass@shop.example")).toBe(false); // 자격증명
    expect(bad("https://shop.example/checkout?token=secret")).toBe(false); // 경로·쿼리
    expect(bad("http://shop.example")).toBe(false); // 비-https
    expect(bad("https://shop.example")).toBe(true); // 정상 오리진
  });
});
