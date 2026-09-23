import type { PageBridge } from "../executor/adapters.js";
import type { CompletionResult } from "../executor/types.js";

// "손": chrome.scripting으로 탭 DOM을 조작하는 PageBridge (docs/spec/agent-integration.md 방식 A).
// chrome.debugger 미사용 — 합성 이벤트(isTrusted:false). 셀렉터는 어댑터 config가 제공.
//
// 셀렉터는 단순 CSS가 아니라 스킴을 가진다(executor/selector.ts 참조):
//   css:<sel> | <sel> / text:<텍스트> / contains:<부분 문자열> / label:<라벨> /
//   after:<라벨> / location:items|href
// 쿠팡 결제창이 Tailwind 자동생성 클래스뿐이라 CSS로 고정할 수 없기 때문이다.
//
// ⚠️ chrome.scripting.executeScript는 func를 소스로 직렬화해 주입하므로 모듈
//    스코프 참조가 불가하다. 그래서 아래 pageOp는 리졸버를 **인라인 복제**한다.
//    ⚠️⚠️ 2026-09-23: 이 복제 때문에 `contains:` 스킴을 selector.ts에만 추가하고
//    여기 반영을 깜빡해 실사용에서 비번 감지가 조용히 실패한 적이 있다(추가한
//    스킴이 실제 브라우저 경로에서 그냥 무시되고 fail-closed 없이 null만 반환).
//    **selector.ts에 스킴을 추가하면 반드시 여기도 같이 고칠 것.** 자동
//    동등성 테스트는 아직 없다(pageOp가 브라우저 전역 document/location에
//    직접 의존해 node 테스트 환경에서 그대로 못 돌림 — TODO).

/** 페이지 컨텍스트에서 실행되는 자족 함수 — 요소 해석 + 읽기/클릭/입력. */
export function pageOp(
  sel: string,
  op: "text" | "click" | "fill",
  val: string | null,
): string | null {
  // ── location 스킴: DOM이 아니라 주소에서 읽는다 ──
  if (sel === "location:items") {
    try {
      return new URLSearchParams(location.search).getAll("item[]").join(",");
    } catch {
      return "";
    }
  }
  if (sel === "location:href") return location.href;

  // ── 요소 해석 (selector.ts resolveIn과 동일 로직 — 아래 normText 주석 참조) ──
  const xpLiteral = (s: string): string => {
    if (!s.includes('"')) return `"${s}"`;
    if (!s.includes("'")) return `'${s}'`;
    return `concat("${s.split('"').join('",\'"\',"')}")`;
  };
  const xp = (q: string): Element | null => {
    try {
      return (document.evaluate(q, document, null, 9, null).singleNodeValue as Element) ?? null;
    } catch {
      return null;
    }
  };
  // 2026-09-23: 한국어 사이트는 여러 단어짜리 라벨(예: "총 결제 금액")이 줄바꿈
  // 없이 붙어 보이도록 단어 사이에 NBSP( )를 흔히 쓴다. XPath의
  // normalize-space()는 ASCII 공백만 처리해 NBSP를 그대로 남기므로, 소스에 일반
  // 스페이스로 적은 라벨 리터럴과 절대 안 맞는다 — 그래서 라벨류(`contains:`/
  // `label:`/`after:`)는 XPath 문자열 비교가 아니라 이 정규화 + JS 순회로 찾는다
  // (짧은 단일 단어 버튼명 `text:`는 NBSP를 안 써서 XPath로도 문제없었다).
  const normText = (s: string): string =>
    s
      .replace(/[   -​  　]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const elText = (e: Element): string => normText(e.textContent ?? "");
  /** 문자열을 포함하는 가장 안쪽(자식 중엔 없는) + 화면에 보이는 요소. */
  const findInnermostVisible = (needle: string): Element | null => {
    const target = normText(needle);
    const all = Array.from(document.querySelectorAll("*"));
    for (const cand of all) {
      if (!elText(cand).includes(target)) continue;
      if (Array.from(cand.children).some((c) => elText(c).includes(target))) continue;
      if (cand.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return cand;
    }
    return null;
  };
  let el: Element | null = null;
  if (sel.startsWith("text:")) {
    const lit = xpLiteral(sel.slice(5));
    el =
      xp(`//button[normalize-space(.)=${lit}]`) ??
      xp(`//a[normalize-space(.)=${lit}]`) ??
      xp(`//*[@role="button"][normalize-space(.)=${lit}]`) ??
      xp(`//*[normalize-space(text())=${lit}]`);
  } else if (sel.startsWith("contains:")) {
    // 숨김 요소(미리 렌더된 모달·display:none 템플릿 등)는 findInnermostVisible이
    // 건너뛴다 — 그런 곳의 "비밀번호" 문구가 원터치 정상 결제를
    // password_required로 오판하게 만들기 때문.
    el = findInnermostVisible(sel.slice(9));
  } else if (sel.startsWith("label:") || sel.startsWith("after:")) {
    const amountOnly = sel.startsWith("label:");
    const labelEl = findInnermostVisible(sel.slice(6));
    if (labelEl) {
      const all = Array.from(document.querySelectorAll("*"));
      const idx = all.indexOf(labelEl);
      for (let i = idx + 1; i < all.length; i++) {
        const cand = all[i];
        if (!cand || cand.children.length > 0) continue; // 리프만
        const t = elText(cand);
        if (t === "") continue;
        // 라이브 함정: 라벨 뒤에 숫자 없는 빈 "원" 노드가 올 수 있다 → 금액성 검증.
        if (amountOnly && !/[\d,]{2,}\s*원/.test(t)) continue;
        if (!cand.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
        el = cand;
        break;
      }
    }
  } else {
    const css = sel.startsWith("css:") ? sel.slice(4) : sel;
    try {
      el = document.querySelector(css);
    } catch {
      el = null;
    }
  }

  if (!el) return null;
  if (op === "text") return el.textContent ?? null;
  if (op === "click") {
    (el as HTMLElement).click();
    return "clicked";
  }
  const input = el as HTMLInputElement;
  input.value = val ?? "";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return "filled";
}

export class ChromePageBridge implements PageBridge {
  private async op(
    tabId: number,
    sel: string,
    action: "text" | "click" | "fill",
    val: string | null = null,
  ): Promise<string | null> {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [sel, action, val],
      func: pageOp,
    });
    return (res?.result as string | null) ?? null;
  }

  async readText(tabId: number, selector: string): Promise<string | null> {
    return this.op(tabId, selector, "text");
  }

  async origin(tabId: number): Promise<string> {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => location.origin,
    });
    return (res?.result as string | undefined) ?? "";
  }

  async fill(tabId: number, selector: string, value: string): Promise<void> {
    await this.op(tabId, selector, "fill", value);
  }

  async click(tabId: number, selector: string): Promise<void> {
    await this.op(tabId, selector, "click");
  }

  async waitForOutcome(
    tabId: number,
    cfg: {
      successSel: string;
      orderIdSel: string;
      passwordUiSel?: string;
      timeoutMs: number;
      expectedOrigin: string;
      onPasswordRequired?: () => Promise<void>;
    },
  ): Promise<CompletionResult> {
    const deadline = Date.now() + cfg.timeoutMs;
    const poll = 500;
    let handedOff = false;
    while (Date.now() < deadline) {
      // 완료 판정은 승인 시점과 동일 origin에서만(허위 완료 페이지 차단).
      const originNow = await this.origin(tabId);
      if (originNow === cfg.expectedOrigin) {
        // 비번 UI: 핸드오프 훅이 있으면 1회 통지 후 사용자 직접 입력을 계속 기다린다
        // (비번칸·키패드는 읽지도 누르지도 않는다 — executor.md §3.2).
        if (
          !handedOff &&
          cfg.passwordUiSel &&
          (await this.readText(tabId, cfg.passwordUiSel)) !== null
        ) {
          if (!cfg.onPasswordRequired) return { status: "failed", error: "password_required" };
          handedOff = true;
          await cfg.onPasswordRequired().catch(() => {}); // 통지 실패가 결제 대기를 깨지 않게
        }
        const ok = await this.readText(tabId, cfg.successSel);
        const orderId = (await this.readText(tabId, cfg.orderIdSel))?.trim() ?? "";
        // 완료 신호 + 주문번호가 모두 있어야 승인으로 인정(허위 완료 방지).
        if (ok !== null && orderId !== "")
          return { status: "approved", orderId: orderId.slice(0, 64) };
      }
      await delay(poll);
    }
    return { status: "timeout" };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
