import { describe, expect, it, vi } from "vitest";
import { type PageBridge, createAdapter, parseWon } from "./adapters.js";
import type { CompletionResult } from "./types.js";

function fakeBridge(over: Partial<PageBridge> = {}): PageBridge {
  return {
    readText:
      over.readText ??
      vi.fn(async (_t, sel) => {
        if (sel.includes("price") || sel.includes("amount")) return "₩23,500";
        if (sel.includes("merchant")) return "쿠팡";
        if (sel.includes("items")) return "usb-hub x1";
        return null;
      }),
    origin: over.origin ?? vi.fn(async () => "https://coupang.com"),
    fill: over.fill ?? vi.fn(async () => {}),
    click: over.click ?? vi.fn(async () => {}),
    waitForOutcome:
      over.waitForOutcome ??
      vi.fn(async (): Promise<CompletionResult> => ({ status: "approved", orderId: "#8842" })),
  };
}

describe("parseWon", () => {
  it("통화 표기 → 정수", () => {
    expect(parseWon("₩23,500")).toBe(23_500);
    expect(parseWon("23,500원")).toBe(23_500);
    expect(parseWon(null)).toBeNaN();
    expect(parseWon("무료")).toBeNaN();
  });
});

describe("createAdapter (coupay, 패턴 C)", () => {
  it("hasExternalApproval=false", () => {
    expect(createAdapter("coupay", fakeBridge()).hasExternalApproval).toBe(false);
  });

  it("verify → 결제창 금액 파싱 + 스냅샷", async () => {
    const v = await createAdapter("coupay", fakeBridge()).verify(1);
    expect(v.amount).toBe(23_500);
    expect(v.merchantName).toBe("쿠팡");
    expect(v.snapshot).toMatch(/^[0-9a-f]{64}$/);
  });

  it("pay 정상: [결제하기] 클릭 → approved", async () => {
    const click = vi.fn(async () => {});
    const bridge = fakeBridge({ click });
    const adapter = createAdapter("coupay", bridge);
    const { snapshot } = await adapter.verify(1);
    const out = await adapter.pay({ tabId: 1, timeoutMs: 1000, approvedSnapshot: snapshot });
    expect(out).toEqual({ status: "approved", orderId: "#8842", amount: 23_500 });
    expect(click).toHaveBeenCalledWith(1, "#place-order"); // 원터치 결제 버튼
  });

  it("pay: 비번 UI 등장 → failed(비번 미입력)", async () => {
    const bridge = fakeBridge({
      waitForOutcome: vi.fn(
        async (): Promise<CompletionResult> => ({ status: "failed", error: "password_required" }),
      ),
    });
    const adapter = createAdapter("coupay", bridge);
    const { snapshot } = await adapter.verify(1);
    expect(await adapter.pay({ tabId: 1, timeoutMs: 10, approvedSnapshot: snapshot })).toEqual({
      status: "failed",
      error: "password_required",
    });
  });
});

describe("createAdapter (kakaopay, 패턴 B)", () => {
  it("hasExternalApproval=true, identity 입력 후 결제 진행", async () => {
    const fill = vi.fn(async () => {});
    const bridge = fakeBridge({
      fill,
      readText: vi.fn(async (_t, sel) =>
        sel.includes("amount") || sel.includes("price")
          ? "₩23,500"
          : sel.includes("merchant")
            ? "카카오"
            : "item",
      ),
    });
    const adapter = createAdapter("kakaopay", bridge);
    expect(adapter.hasExternalApproval).toBe(true);
    const { snapshot } = await adapter.verify(1);
    await adapter.pay({
      tabId: 1,
      timeoutMs: 10,
      approvedSnapshot: snapshot,
      identity: { phone: "01012345678", birth: "19900101" },
    });
    expect(fill).toHaveBeenCalledWith(1, "#phoneNumber", "01012345678");
    expect(fill).toHaveBeenCalledWith(1, "#dateOfBirth", "19900101");
  });
});
