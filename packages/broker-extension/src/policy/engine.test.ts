import type { PaymentPolicy, PaymentRequest, UsageSnapshot } from "@autopay/shared";
import { describe, expect, it } from "vitest";
import { evaluate } from "./engine.js";

// docs/spec/policy.md §6 — 기준 픽스처
const basePolicy: PaymentPolicy = {
  limits: { perTransaction: 50_000, daily: 100_000, monthly: 300_000, maxTransactionsPerDay: 3 },
  merchants: { mode: "allowlist", origins: ["https://shop.example"] },
  categories: { mode: "allowlist", values: ["keyboard", "mouse"] },
  methods: ["kakaopay"],
  confirmation: { requireUserConfirmationAbove: 30_000, alwaysConfirm: false },
  notifications: { channels: ["chrome"], notifyOnRejection: true },
};

const baseUsage: UsageSnapshot = { spentToday: 0, spentThisMonth: 0, countToday: 0 };

const baseReq: PaymentRequest = {
  merchant: { origin: "https://shop.example", name: "Shop" },
  items: [{ title: "무선 키보드", category: "keyboard", quantity: 1, unitPrice: 20_000 }],
  totalAmount: 20_000,
  currency: "KRW",
  method: "kakaopay",
  checkoutTabId: 1,
};

const req = (o: Partial<PaymentRequest>): PaymentRequest => ({ ...baseReq, ...o });
const pol = (o: Partial<PaymentPolicy>): PaymentPolicy => ({ ...basePolicy, ...o });
const usage = (o: Partial<UsageSnapshot>): UsageSnapshot => ({ ...baseUsage, ...o });
const item = (category: string | undefined, unitPrice: number) => ({
  title: "상품",
  category,
  quantity: 1,
  unitPrice,
});

describe("policy.evaluate", () => {
  it("1. 기준 그대로, amount 20,000 → allow", () => {
    expect(evaluate(baseReq, basePolicy, baseUsage)).toEqual({ type: "allow" });
  });

  it("2. amount 40,000 (>30k 임계) → confirm(threshold)", () => {
    const r = req({ items: [item("keyboard", 40_000)], totalAmount: 40_000 });
    expect(evaluate(r, basePolicy, baseUsage)).toEqual({ type: "confirm", reason: "threshold" });
  });

  it("3. alwaysConfirm=true, amount 10,000 → confirm(always)", () => {
    const r = req({ items: [item("keyboard", 10_000)], totalAmount: 10_000 });
    const p = pol({ confirmation: { requireUserConfirmationAbove: 30_000, alwaysConfirm: true } });
    expect(evaluate(r, p, baseUsage)).toEqual({ type: "confirm", reason: "always" });
  });

  it("4. amount 60,000 (>perTx 50k) → deny(over_per_transaction)", () => {
    const r = req({ items: [item("keyboard", 60_000)], totalAmount: 60_000 });
    expect(evaluate(r, basePolicy, baseUsage)).toEqual({
      type: "deny",
      violation: "over_per_transaction",
    });
  });

  it("5. amount 50,000 (=perTx) → confirm(threshold): deny 아님(> 경계), 단 30k 임계 초과", () => {
    const r = req({ items: [item("keyboard", 50_000)], totalAmount: 50_000 });
    expect(evaluate(r, basePolicy, baseUsage)).toEqual({ type: "confirm", reason: "threshold" });
  });

  it("6. merchant not in allowlist → deny(merchant_not_allowed)", () => {
    const r = req({ merchant: { origin: "https://evil.example", name: "Evil" } });
    expect(evaluate(r, basePolicy, baseUsage)).toEqual({
      type: "deny",
      violation: "merchant_not_allowed",
    });
  });

  it("7. merchants.mode=any + evil origin → allow", () => {
    const r = req({ merchant: { origin: "https://evil.example", name: "Evil" } });
    const p = pol({ merchants: { mode: "any", origins: [] } });
    expect(evaluate(r, p, baseUsage)).toEqual({ type: "allow" });
  });

  it("8. item category 'gift' (allowlist 밖) → deny(category_not_allowed)", () => {
    const r = req({ items: [item("gift", 20_000)] });
    expect(evaluate(r, basePolicy, baseUsage)).toEqual({
      type: "deny",
      violation: "category_not_allowed",
    });
  });

  it("9. item category 미지정 (allowlist) → deny(category_not_allowed)", () => {
    const r = req({ items: [item(undefined, 20_000)] });
    expect(evaluate(r, basePolicy, baseUsage)).toEqual({
      type: "deny",
      violation: "category_not_allowed",
    });
  });

  it("10. denylist ['gift'], item 'keyboard' → allow", () => {
    const p = pol({ categories: { mode: "denylist", values: ["gift"] } });
    expect(evaluate(baseReq, p, baseUsage)).toEqual({ type: "allow" });
  });

  it("11. method 'tosspay' (policy엔 kakaopay만) → deny(method_not_allowed)", () => {
    const r = req({ method: "tosspay" });
    expect(evaluate(r, basePolicy, baseUsage)).toEqual({
      type: "deny",
      violation: "method_not_allowed",
    });
  });

  it("12. countToday=3, amount 10,000 → deny(over_count)", () => {
    const r = req({ items: [item("keyboard", 10_000)], totalAmount: 10_000 });
    expect(evaluate(r, basePolicy, usage({ countToday: 3 }))).toEqual({
      type: "deny",
      violation: "over_count",
    });
  });

  it("13. spentToday=90,000, amount 20,000 (>daily) → deny(over_daily)", () => {
    expect(evaluate(baseReq, basePolicy, usage({ spentToday: 90_000 }))).toEqual({
      type: "deny",
      violation: "over_daily",
    });
  });

  it("14. spentToday=80,000, amount 20,000 (=daily) → allow (경계)", () => {
    expect(evaluate(baseReq, basePolicy, usage({ spentToday: 80_000 }))).toEqual({ type: "allow" });
  });

  it("15. spentThisMonth=290,000, amount 20,000 (>monthly) → deny(over_monthly)", () => {
    expect(evaluate(baseReq, basePolicy, usage({ spentThisMonth: 290_000 }))).toEqual({
      type: "deny",
      violation: "over_monthly",
    });
  });

  it("16. verifiedAmount 25,000, totalAmount 20,000 → deny(amount_mismatch)", () => {
    expect(evaluate(baseReq, basePolicy, baseUsage, 25_000)).toEqual({
      type: "deny",
      violation: "amount_mismatch",
    });
  });

  it("17. verifiedAmount 20,000, totalAmount 20,000 → allow", () => {
    expect(evaluate(baseReq, basePolicy, baseUsage, 20_000)).toEqual({ type: "allow" });
  });

  it("18. 다중 위반: evil origin + amount 60,000 → merchant_not_allowed(순서 우선)", () => {
    const r = req({
      merchant: { origin: "https://evil.example", name: "Evil" },
      items: [item("keyboard", 60_000)],
      totalAmount: 60_000,
    });
    expect(evaluate(r, basePolicy, baseUsage)).toEqual({
      type: "deny",
      violation: "merchant_not_allowed",
    });
  });

  it("19. 다중 위반: amount_mismatch + over_per_tx → amount_mismatch(최우선)", () => {
    const r = req({ items: [item("keyboard", 60_000)], totalAmount: 60_000 });
    expect(evaluate(r, basePolicy, baseUsage, 55_000)).toEqual({
      type: "deny",
      violation: "amount_mismatch",
    });
  });

  // ── 경계·불변성 (Codex 리뷰 반영) ──
  it("20. amount 30,000 (=임계) → allow (confirm은 > 경계)", () => {
    const r = req({ items: [item("keyboard", 30_000)], totalAmount: 30_000 });
    expect(evaluate(r, basePolicy, baseUsage)).toEqual({ type: "allow" });
  });

  it("21. countToday=2 (=max-1), amount 10,000 → allow (횟수 경계)", () => {
    const r = req({ items: [item("keyboard", 10_000)], totalAmount: 10_000 });
    expect(evaluate(r, basePolicy, usage({ countToday: 2 }))).toEqual({ type: "allow" });
  });

  it("22. spentThisMonth=280,000, amount 20,000 (=monthly) → allow (경계)", () => {
    expect(evaluate(baseReq, basePolicy, usage({ spentThisMonth: 280_000 }))).toEqual({
      type: "allow",
    });
  });

  it("23. denylist, item category 미지정 → allow (denylist는 미지정 통과)", () => {
    const p = pol({ categories: { mode: "denylist", values: ["gift"] } });
    const r = req({ items: [item(undefined, 20_000)] });
    expect(evaluate(r, p, baseUsage)).toEqual({ type: "allow" });
  });

  it("24. 다중 item 중 하나가 allowlist 밖 → deny(category_not_allowed)", () => {
    const r = req({
      items: [item("keyboard", 10_000), item("gift", 10_000)],
      totalAmount: 20_000,
    });
    expect(evaluate(r, basePolicy, baseUsage)).toEqual({
      type: "deny",
      violation: "category_not_allowed",
    });
  });

  it("25. confirm이 deny를 덮지 않음: alwaysConfirm=true + over perTx → deny", () => {
    const r = req({ items: [item("keyboard", 60_000)], totalAmount: 60_000 });
    const p = pol({ confirmation: { requireUserConfirmationAbove: 30_000, alwaysConfirm: true } });
    expect(evaluate(r, p, baseUsage)).toEqual({ type: "deny", violation: "over_per_transaction" });
  });

  it("26. 순수성: 입력을 변형하지 않는다", () => {
    const r = req({ items: [item("keyboard", 20_000)] });
    const p = pol({});
    const u = usage({});
    const rSnap = structuredClone(r);
    const pSnap = structuredClone(p);
    const uSnap = structuredClone(u);
    evaluate(r, p, u, 20_000);
    expect(r).toEqual(rSnap);
    expect(p).toEqual(pSnap);
    expect(u).toEqual(uSnap);
  });
});
