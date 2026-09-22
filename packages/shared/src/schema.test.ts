import { describe, expect, it } from "vitest";
import {
  BridgeFrame,
  BridgeToolCall,
  BridgeToolResult,
  Decision,
  PaymentRequest,
} from "./schema.js";

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

// docs/spec/mcp-integration.md §3·§4·§10 테스트 케이스
describe("bridge protocol schemas", () => {
  it("1. open 도구 호출 → https URL이면 success", () => {
    const call = { id: "c1", tool: "open", args: { url: "https://shop.example/search?q=키보드" } };
    expect(BridgeToolCall.safeParse(call).success).toBe(true);
  });

  it("2. open에 자격증명·비-https URL → 거절", () => {
    const bad = (url: string) =>
      BridgeToolCall.safeParse({ id: "c1", tool: "open", args: { url } }).success;
    expect(bad("https://user:pass@shop.example")).toBe(false);
    expect(bad("http://shop.example")).toBe(false);
  });

  it("3. 미지의 tool → 거절(alowlist 밖 도구 없음, AGENTS §2.6/§4)", () => {
    const call = { id: "c1", tool: "get_secret", args: {} };
    expect(BridgeToolCall.safeParse(call).success).toBe(false);
  });

  it("4. request_payment는 checkoutTabId 없이도 success(익스텐션이 채움)", () => {
    const call = {
      id: "c1",
      tool: "request_payment",
      args: {
        merchant: { origin: "https://shop.example", name: "Shop" },
        items: [{ title: "키보드", quantity: 1, unitPrice: 20000 }],
        totalAmount: 20000,
        currency: "KRW",
        method: "coupay",
      },
    };
    expect(BridgeToolCall.safeParse(call).success).toBe(true);
  });

  it("5. request_payment에 checkoutTabId를 실어 보내면(탭 id 노출 시도) 거절 — strict", () => {
    const call = {
      id: "c1",
      tool: "request_payment",
      args: {
        merchant: { origin: "https://shop.example", name: "Shop" },
        items: [{ title: "키보드", quantity: 1, unitPrice: 20000 }],
        totalAmount: 20000,
        currency: "KRW",
        method: "coupay",
        checkoutTabId: 1,
      },
    };
    expect(BridgeToolCall.safeParse(call).success).toBe(false);
  });

  it("6. click/fill의 selector가 비어있으면 거절", () => {
    expect(
      BridgeToolCall.safeParse({ id: "c1", tool: "click", args: { selector: "" } }).success,
    ).toBe(false);
  });

  it("7. BridgeToolResult — ok:true엔 result, ok:false엔 error 문자열 필요", () => {
    expect(BridgeToolResult.safeParse({ id: "c1", ok: true, result: { any: 1 } }).success).toBe(
      true,
    );
    expect(BridgeToolResult.safeParse({ id: "c1", ok: false, error: "x" }).success).toBe(true);
    expect(BridgeToolResult.safeParse({ id: "c1", ok: false }).success).toBe(false);
  });

  it("8. BridgeFrame — auth 토큰이 16자 미만이면 거절", () => {
    expect(BridgeFrame.safeParse({ type: "auth", token: "short" }).success).toBe(false);
    expect(BridgeFrame.safeParse({ type: "auth", token: "a".repeat(32) }).success).toBe(true);
  });

  it("9. BridgeFrame — call 프레임은 내부 BridgeToolCall도 검증", () => {
    const frame = {
      type: "call",
      call: { id: "c1", tool: "get_policy_summary", args: {} },
    };
    expect(BridgeFrame.safeParse(frame).success).toBe(true);
    expect(
      BridgeFrame.safeParse({ type: "call", call: { id: "c1", tool: "bad", args: {} } }).success,
    ).toBe(false);
  });
});
