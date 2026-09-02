import { describe, expect, it, vi } from "vitest";
import { SimplePayCore } from "./core.js";
import type { CheckoutDriver, CheckoutView, CompletionResult } from "./types.js";

const view: CheckoutView = { amount: 23_500, merchantName: "쿠팡", itemsKey: "usb-hub#1" };

function fakeDriver(
  over: Partial<CheckoutDriver> & { views?: CheckoutView[] } = {},
): CheckoutDriver {
  const views = over.views ?? [view, view];
  let call = 0;
  return {
    method: over.method ?? "coupay",
    hasExternalApproval: over.hasExternalApproval ?? false,
    readCheckout:
      over.readCheckout ??
      vi.fn(async () => views[Math.min(call++, views.length - 1)] as CheckoutView),
    startPayment: over.startPayment ?? vi.fn(async () => {}),
    awaitCompletion:
      over.awaitCompletion ??
      vi.fn(async () => ({ status: "approved", orderId: "#1" }) as CompletionResult),
  };
}

describe("SimplePayCore", () => {
  it("A. verify → amount + snapshot 반환", async () => {
    const core = new SimplePayCore(fakeDriver());
    const v = await core.verify(1);
    expect(v.amount).toBe(23_500);
    expect(v.snapshot).toMatch(/^[0-9a-f]{64}$/);
  });

  it("B. 정상: 스냅샷 일치 → approved(orderId, amount)", async () => {
    const core = new SimplePayCore(fakeDriver());
    const { snapshot } = await core.verify(1);
    const out = await core.pay({ tabId: 1, timeoutMs: 1000, approvedSnapshot: snapshot });
    expect(out).toEqual({ status: "approved", orderId: "#1", amount: 23_500 });
  });

  it("C. TOCTOU: 승인 후 대상 변경 → 재검증 불일치 → canceled(결제 안 함)", async () => {
    const changed: CheckoutView = { amount: 250_000, merchantName: "쿠팡", itemsKey: "tv#1" };
    const start = vi.fn(async () => {});
    const core = new SimplePayCore(fakeDriver({ views: [view, changed], startPayment: start }));
    const { snapshot } = await core.verify(1); // view 기준 승인
    const out = await core.pay({ tabId: 1, timeoutMs: 1000, approvedSnapshot: snapshot });
    expect(out).toEqual({ status: "canceled" });
    expect(start).not.toHaveBeenCalled(); // 결제 시작 자체를 안 함
  });

  it("D. 완료 대기 timeout → timeout", async () => {
    const core = new SimplePayCore(
      fakeDriver({
        awaitCompletion: vi.fn(async (): Promise<CompletionResult> => ({ status: "timeout" })),
      }),
    );
    const { snapshot } = await core.verify(1);
    expect(await core.pay({ tabId: 1, timeoutMs: 10, approvedSnapshot: snapshot })).toEqual({
      status: "timeout",
    });
  });

  it("E. 쿠팡 비번 UI 등장 등 → failed", async () => {
    const core = new SimplePayCore(
      fakeDriver({
        awaitCompletion: vi.fn(
          async (): Promise<CompletionResult> => ({ status: "failed", error: "password_required" }),
        ),
      }),
    );
    const { snapshot } = await core.verify(1);
    expect(await core.pay({ tabId: 1, timeoutMs: 10, approvedSnapshot: snapshot })).toEqual({
      status: "failed",
      error: "password_required",
    });
  });

  it("F. 패턴 B: identity가 startPayment로 전달됨", async () => {
    const start = vi.fn(async () => {});
    const core = new SimplePayCore(
      fakeDriver({ method: "kakaopay", hasExternalApproval: true, startPayment: start }),
    );
    const { snapshot } = await core.verify(1);
    await core.pay({
      tabId: 1,
      timeoutMs: 10,
      approvedSnapshot: snapshot,
      identity: { phone: "01000000000", birth: "20000101" },
    });
    expect(start).toHaveBeenCalledWith(1, {
      identity: { phone: "01000000000", birth: "20000101" },
    });
  });
});
