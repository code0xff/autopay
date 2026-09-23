import type { BridgeToolCall, PaymentResult } from "@autopay/shared";
import { describe, expect, it, vi } from "vitest";
import { BridgeTools } from "./bridge-tools.js";
import type { GenericPageBridge, PageSnapshot } from "./page-bridge.js";

// docs/spec/mcp-integration.md §3·§10 테스트 케이스

function makeDeps(
  overrides: { tabId?: number | null; executing?: boolean; locked?: boolean } = {},
) {
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
      remainingMonthlyBudget: 1000,
      remainingCountToday: 1,
      perTransactionLimit: 1000,
      allowedCategories: [],
      categoriesMode: "denylist" as const,
      allowedMerchants: "any" as const,
      allowedMethods: ["coupay" as const],
      confirmation: { alwaysConfirm: false, requireUserConfirmationAbove: 1000 },
    })),
    hasActiveExecution: vi.fn(async () => overrides.executing ?? false),
  };
  return {
    pageBridge,
    broker,
    isLocked: vi.fn(async () => overrides.locked ?? false),
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

  // executor.md §3.2 — 결제 실행 중(비번 핸드오프 포함) 페이지 도구 잠금
  it("8. 결제 실행 중에는 open/read_page/click/fill 거부, 페이지에 손대지 않음", async () => {
    const deps = makeDeps({ tabId: 7, executing: true });
    const tools = new BridgeTools(deps);
    const calls: BridgeToolCall[] = [
      { id: "a", tool: "open", args: { url: "https://shop.example" } },
      { id: "b", tool: "read_page", args: {} },
      { id: "c", tool: "click", args: { selector: "#key-1" } },
      { id: "d", tool: "fill", args: { selector: "#pw", value: "x" } },
    ];
    for (const call of calls) {
      expect(await tools.handle(call)).toEqual({
        id: call.id,
        ok: false,
        error: "page_locked_during_payment",
      });
    }
    expect(deps.pageBridge.openOrReuse).not.toHaveBeenCalled();
    expect(deps.pageBridge.readPage).not.toHaveBeenCalled();
    expect(deps.pageBridge.click).not.toHaveBeenCalled();
    expect(deps.pageBridge.fill).not.toHaveBeenCalled();
  });

  it("9. 결제 실행 중에도 상태 조회(get_payment_result/get_policy_summary)는 허용", async () => {
    const deps = makeDeps({ tabId: 7, executing: true });
    const tools = new BridgeTools(deps);
    const r1 = await tools.handle({
      id: "a",
      tool: "get_payment_result",
      args: { requestId: "r1" },
    });
    const r2 = await tools.handle({ id: "b", tool: "get_policy_summary", args: {} });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
  });

  it("10. 잠겨 있으면(AutoPay 비활성) 모든 도구를 autopay_locked로 거부", async () => {
    const deps = makeDeps({ tabId: 7, locked: true });
    const tools = new BridgeTools(deps);
    const calls: BridgeToolCall[] = [
      { id: "a", tool: "open", args: { url: "https://shop.example" } },
      { id: "b", tool: "read_page", args: {} },
      { id: "c", tool: "get_policy_summary", args: {} },
      { id: "d", tool: "get_payment_result", args: { requestId: "r1" } },
    ];
    for (const call of calls) {
      expect(await tools.handle(call)).toEqual({ id: call.id, ok: false, error: "autopay_locked" });
    }
    expect(deps.pageBridge.openOrReuse).not.toHaveBeenCalled();
    expect(deps.broker.getPolicySummary).not.toHaveBeenCalled();
  });
});
