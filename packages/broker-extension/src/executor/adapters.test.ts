import { describe, expect, it, vi } from "vitest";
import { type PageBridge, createAdapter, parseWon } from "./adapters.js";
import type { CompletionResult } from "./types.js";

function fakeBridge(over: Partial<PageBridge> = {}): PageBridge {
  return {
    readText:
      over.readText ??
      vi.fn(async (_t, sel) => {
        // 쿠팡은 "label:총 결제 금액", 카카오는 "[data-amount]" 형태.
        if (sel.startsWith("label:") || sel.includes("price") || sel.includes("amount"))
          return "₩23,500";
        if (sel === "location:items" || sel.includes("items")) return "86091485721:1";
        // 쿠팡 결제창엔 가맹점명 노드가 없다 → null → merchantName 폴백 경로를 탄다.
        if (sel.includes("merchant")) return null;
        return null;
      }),
    origin: over.origin ?? vi.fn(async () => "https://coupang.com"),
    fill: over.fill ?? vi.fn(async () => {}),
    click: over.click ?? vi.fn(async () => {}),
    waitClickable: over.waitClickable ?? vi.fn(async () => true),
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
    expect(click).toHaveBeenCalledWith(1, "text:결제하기"); // 원터치 결제 버튼(라이브 확정)
  });

  // 2026-09-26 실사용 버그: [결제하기]를 찾아 눌렀는데 화면이 전혀 변하지 않고
  // 타임아웃만 났다. 쿠팡 결제창은 React 앱이라 서버 렌더된 버튼이 먼저 보이고
  // 하이드레이션이 끝나야 onClick이 붙는데, 그 전 클릭은 오류 없이 무시된다.
  // 확인 게이트가 있을 땐 사용자가 승인하는 사이에 준비가 끝나 우연히 동작했고,
  // 확인을 끄자(정책 변경) 로드 직후 클릭이 되면서 매번 실패했다.
  it("[2026-09-26 회귀] 버튼이 눌리는 상태가 될 때까지 기다린 뒤에 클릭한다", async () => {
    const order: string[] = [];
    const waitClickable = vi.fn(async () => {
      order.push("wait");
      return true;
    });
    const click = vi.fn(async () => {
      order.push("click");
    });
    const bridge = fakeBridge({ waitClickable, click });
    const adapter = createAdapter("coupay", bridge);
    const { snapshot } = await adapter.verify(1);
    await adapter.pay({ tabId: 1, timeoutMs: 1000, approvedSnapshot: snapshot });
    expect(order).toEqual(["wait", "click"]); // 반드시 확인이 먼저
    expect(waitClickable).toHaveBeenCalledWith(1, "text:결제하기", expect.any(Number));
  });

  it("[2026-09-26 회귀] 끝내 눌리는 상태가 안 되면 클릭하지 않고 실패 사유를 알린다", async () => {
    // 무의미한 클릭 후 타임아웃까지 기다리면 원인이 안 보인다. 또 눌러본 뒤
    // 재시도하는 건 중복 결제 위험이 있어 하지 않는다 — 클릭 전에 끝낸다.
    const click = vi.fn(async () => {});
    const bridge = fakeBridge({ waitClickable: vi.fn(async () => false), click });
    const adapter = createAdapter("coupay", bridge);
    const { snapshot } = await adapter.verify(1);
    const out = await adapter.pay({ tabId: 1, timeoutMs: 1000, approvedSnapshot: snapshot });
    expect(out).toEqual({ status: "failed", error: "pay_button_not_ready" });
    expect(click).not.toHaveBeenCalled();
  });

  it("[2026-10-08] 누르기 전에 취소됐으면 결제 버튼을 누르지 않는다", async () => {
    const click = vi.fn(async () => {});
    const adapter = createAdapter("coupay", fakeBridge({ click }));
    const { snapshot } = await adapter.verify(1);
    const ctrl = new AbortController();
    ctrl.abort();
    const out = await adapter.pay({
      tabId: 1,
      timeoutMs: 1000,
      approvedSnapshot: snapshot,
      signal: ctrl.signal,
    });
    expect(out).toEqual({ status: "canceled", reason: "user" });
    expect(click).not.toHaveBeenCalled();
  });

  it("[2026-10-08] 취소 신호를 완료 대기까지 전달한다", async () => {
    const waitForOutcome = vi.fn(async (): Promise<CompletionResult> => ({ status: "canceled" }));
    const adapter = createAdapter("coupay", fakeBridge({ waitForOutcome }));
    const { snapshot } = await adapter.verify(1);
    const ctrl = new AbortController();
    await adapter.pay({
      tabId: 1,
      timeoutMs: 1000,
      approvedSnapshot: snapshot,
      signal: ctrl.signal,
    });
    expect(waitForOutcome).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ signal: ctrl.signal }),
    );
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

describe("createAdapter (naverpay, 핸드오프 전용)", () => {
  it("hasExternalApproval=false, verify는 금액·스냅샷을 돌려준다", async () => {
    const adapter = createAdapter("naverpay", fakeBridge());
    expect(adapter.method).toBe("naverpay");
    expect(adapter.hasExternalApproval).toBe(false);
    const v = await adapter.verify(1);
    expect(v.amount).toBe(23_500);
    expect(v.snapshot).toMatch(/^[0-9a-f]{64}$/);
  });

  it("키패드 문구 감지 → 핸드오프 통지 요청, 입력·fill 없이 결제 버튼 클릭 1회만", async () => {
    const fill = vi.fn(async () => {});
    const click = vi.fn(async () => {});
    const waitForOutcome = vi.fn(
      async (_t: number, cfg: Parameters<PageBridge["waitForOutcome"]>[1]) => {
        await cfg.onPasswordRequired?.();
        return { status: "approved", orderId: "N-1" } as CompletionResult;
      },
    );
    const adapter = createAdapter("naverpay", fakeBridge({ fill, click, waitForOutcome }));
    const { snapshot } = await adapter.verify(1);
    const onPasswordHandoff = vi.fn(async () => {});
    const out = await adapter.pay({
      tabId: 1,
      timeoutMs: 1000,
      approvedSnapshot: snapshot,
      onPasswordHandoff,
    });
    expect(out).toEqual({ status: "approved", orderId: "N-1", amount: 23_500 });
    expect(onPasswordHandoff).toHaveBeenCalledTimes(1);
    expect(fill).not.toHaveBeenCalled();
    expect(click).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledWith(1, "text:네이버페이 결제");
    // 키패드 감지 셀렉터가 전달되고 "보이는가"만 확인한다.
    expect(waitForOutcome).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ passwordUiSel: "contains:결제 비밀번호" }),
    );
  });

  it("핸드오프 훅 없이 키패드가 뜨면 → failed(password_required), PIN 시도 없음", async () => {
    const fill = vi.fn(async () => {});
    const bridge = fakeBridge({
      fill,
      waitForOutcome: vi.fn(
        async (): Promise<CompletionResult> => ({ status: "failed", error: "password_required" }),
      ),
    });
    const adapter = createAdapter("naverpay", bridge);
    const { snapshot } = await adapter.verify(1);
    expect(await adapter.pay({ tabId: 1, timeoutMs: 10, approvedSnapshot: snapshot })).toEqual({
      status: "failed",
      error: "password_required",
    });
    expect(fill).not.toHaveBeenCalled();
  });

  it("승인 후 금액이 바뀌면(검증 불일치) 클릭하지 않고 canceled(content_changed)", async () => {
    let amount = "₩23,500";
    const click = vi.fn(async () => {});
    const bridge = fakeBridge({
      click,
      readText: vi.fn(async (_t, sel) => (sel.startsWith("label:") ? amount : "86091485721:1")),
    });
    const adapter = createAdapter("naverpay", bridge);
    const { snapshot } = await adapter.verify(1);
    amount = "₩99,000";
    const out = await adapter.pay({ tabId: 1, timeoutMs: 100, approvedSnapshot: snapshot });
    expect(out).toEqual({ status: "canceled", reason: "content_changed" });
    expect(click).not.toHaveBeenCalled();
  });

  it("금액을 파싱하지 못하면 NaN을 돌려 정책 단계에서 거절되게 한다", async () => {
    const bridge = fakeBridge({ readText: vi.fn(async () => null) });
    const v = await createAdapter("naverpay", bridge).verify(1);
    expect(v.amount).toBeNaN();
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
