import type { PageBridge } from "../executor/adapters.js";
import type { CompletionResult } from "../executor/types.js";

// "손": chrome.scripting으로 탭 DOM을 조작하는 PageBridge (docs/spec/agent-integration.md 방식 A).
// chrome.debugger 미사용 — 합성 이벤트(isTrusted:false). 셀렉터는 어댑터 config가 제공.

export class ChromePageBridge implements PageBridge {
  async readText(tabId: number, selector: string): Promise<string | null> {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [selector],
      func: (sel: string) => document.querySelector(sel)?.textContent ?? null,
    });
    return (res?.result as string | null) ?? null;
  }

  async origin(tabId: number): Promise<string> {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => location.origin,
    });
    return (res?.result as string | undefined) ?? "";
  }

  async fill(tabId: number, selector: string, value: string): Promise<void> {
    await chrome.scripting.executeScript({
      target: { tabId },
      args: [selector, value],
      func: (sel: string, val: string) => {
        const el = document.querySelector(sel) as HTMLInputElement | null;
        if (!el) return;
        el.value = val;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      },
    });
  }

  async click(tabId: number, selector: string): Promise<void> {
    await chrome.scripting.executeScript({
      target: { tabId },
      args: [selector],
      func: (sel: string) => (document.querySelector(sel) as HTMLElement | null)?.click(),
    });
  }

  async waitForOutcome(
    tabId: number,
    cfg: { successSel: string; orderIdSel: string; passwordUiSel?: string; timeoutMs: number },
  ): Promise<CompletionResult> {
    const deadline = Date.now() + cfg.timeoutMs;
    const poll = 500;
    while (Date.now() < deadline) {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        args: [cfg],
        func: (c: typeof cfg) => {
          if (c.passwordUiSel && document.querySelector(c.passwordUiSel))
            return { kind: "password" };
          const ok = document.querySelector(c.successSel);
          const orderId = document.querySelector(c.orderIdSel)?.textContent?.trim() ?? "";
          // 완료 신호 + 주문번호가 모두 있어야 승인으로 인정(허위 완료 방지).
          if (ok && orderId) return { kind: "success", orderId };
          return { kind: "pending" };
        },
      });
      const r = res?.result as { kind: string; orderId?: string } | undefined;
      if (r?.kind === "password") return { status: "failed", error: "password_required" };
      if (r?.kind === "success") return { status: "approved", orderId: r.orderId ?? "" };
      await delay(poll);
    }
    return { status: "timeout" };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
