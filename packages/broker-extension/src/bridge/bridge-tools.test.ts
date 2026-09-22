import type { BridgeToolCall, PaymentResult } from "@autopay/shared";
import { describe, expect, it, vi } from "vitest";
import { BridgeTools } from "./bridge-tools.js";
import type { GenericPageBridge, PageSnapshot } from "./page-bridge.js";

// docs/spec/mcp-integration.md §3·§10 테스트 케이스

function makeDeps(overrides: { tabId?: number | null } = {}) {
  let bridgeTabId: number | null = overrides.tabId ?? null;
  const pageBridge: GenericPageBridge = {
    openOrReuse: vi.fn(async () => 7),
    readPage: vi.fn(
      async (): Promise<PageSnapshot> => ({
        url: "https://shop.example",
        title: "t",
        elements: [],
      }),
    ),
    click: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
  };
  const broker = {
    requestPayment: vi.fn(async () => ({ requestId: "r1" })),
    getPaymentResult: vi.fn(
      async (): Promise<PaymentResult> => ({ status: "pending_user_confirmation" }),
    ),
    getPolicySummary: vi.fn(async () => ({
      remainingDailyBudget: 1000,
      remainingCountToday: 1,
      allowedCategories: [],
      allowedMerchants: "any" as const,
      allowedMethods: ["coupay" as const],
    })),
  };
  return {
    pageBridge,
    broker,
    getBridgeTabId: vi.fn(async () => bridgeTabId),
    setBridgeTabId: vi.fn(async (id: number) => {
      bridgeTabId = id;
    }),
  };
}

describe("BridgeTools", () => {
  it("1. open → pageBridge.openOrReuse 호출 + 브리지 탭 id 저장", async () => {
    const deps = makeDeps();
    const tools = new BridgeTools(deps);
    const call: BridgeToolCall = {
      id: "c1",
      tool: "open",
      args: { url: "https://shop.example/search?q=keyboard" },
    };
    const res = await tools.handle(call);
    expect(res).toEqual({ id: "c1", ok: true, result: { opened: true } });
    expect(deps.pageBridge.openOrReuse).toHaveBeenCalledWith(
      "https://shop.example/search?q=keyboard",
      null,
    );
    expect(deps.setBridgeTabId).toHaveBeenCalledWith(7);
  });

  it("2. open 전에 read_page/click/fill → no_open_tab 실패(fail-closed)", async () => {
    const deps = makeDeps();
    const tools = new BridgeTools(deps);
    const res = await tools.handle({ id: "c1", tool: "read_page", args: {} });
    expect(res).toEqual({ id: "c1", ok: false, error: "no_open_tab" });
    expect(deps.pageBridge.readPage).not.toHaveBeenCalled();
  });

  it("3. open 이후 read_page/click/fill은 추적된 탭 id로 위임", async () => {
    const deps = makeDeps({ tabId: 7 });
    const tools = new BridgeTools(deps);
    await tools.handle({ id: "c1", tool: "click", args: { selector: "#buy" } });
    expect(deps.pageBridge.click).toHaveBeenCalledWith(7, "#buy");
    await tools.handle({ id: "c2", tool: "fill", args: { selector: "#q", value: "keyboard" } });
    expect(deps.pageBridge.fill).toHaveBeenCalledWith(7, "#q", "keyboard");
    const res = await tools.handle({ id: "c3", tool: "read_page", args: {} });
    expect(res.ok).toBe(true);
  });

  it("4. request_payment — 에이전트가 준 인자에 브리지 탭 id를 채워 broker로 전달", async () => {
    const deps = makeDeps({ tabId: 7 });
    const tools = new BridgeTools(deps);
    const args = {
      merchant: { origin: "https://shop.example", name: "Shop" },
      items: [{ title: "키보드", quantity: 1, unitPrice: 20000 }],
      totalAmount: 20000,
      currency: "KRW" as const,
      method: "coupay" as const,
    };
    const res = await tools.handle({ id: "c1", tool: "request_payment", args });
    expect(res).toEqual({ id: "c1", ok: true, result: { requestId: "r1" } });
    expect(deps.broker.requestPayment).toHaveBeenCalledWith({ ...args, checkoutTabId: 7 });
  });

  it("5. request_payment — 브리지 탭이 없으면 broker를 호출하지 않고 실패", async () => {
    const deps = makeDeps();
    const tools = new BridgeTools(deps);
    const res = await tools.handle({
      id: "c1",
      tool: "request_payment",
      args: {
        merchant: { origin: "https://shop.example", name: "Shop" },
        items: [{ title: "키보드", quantity: 1, unitPrice: 20000 }],
        totalAmount: 20000,
        currency: "KRW",
        method: "coupay",
      },
    });
    expect(res).toEqual({ id: "c1", ok: false, error: "no_open_tab" });
    expect(deps.broker.requestPayment).not.toHaveBeenCalled();
  });

  it("6. get_payment_result / get_policy_summary — broker로 그대로 위임(브라우저 접근 없음)", async () => {
    const deps = makeDeps();
    const tools = new BridgeTools(deps);
    const r1 = await tools.handle({
      id: "c1",
      tool: "get_payment_result",
      args: { requestId: "r1" },
    });
    expect(deps.broker.getPaymentResult).toHaveBeenCalledWith("r1");
    expect(r1.ok).toBe(true);

    const r2 = await tools.handle({ id: "c2", tool: "get_policy_summary", args: {} });
    expect(deps.broker.getPolicySummary).toHaveBeenCalled();
    expect(r2.ok).toBe(true);
  });

  it("7. 도구 내부 예외 → 예외를 던지지 않고 ok:false로 수렴", async () => {
    const deps = makeDeps({ tabId: 7 });
    deps.pageBridge.click = vi.fn(async () => {
      throw new Error("boom");
    });
    const tools = new BridgeTools(deps);
    const res = await tools.handle({ id: "c1", tool: "click", args: { selector: "#buy" } });
    expect(res).toEqual({ id: "c1", ok: false, error: "boom" });
  });
});
