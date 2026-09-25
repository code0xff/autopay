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
  op: "text" | "click" | "fill" | "clickable",
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
    // 2026-09-23 실사용 3차 버그: 쿠팡은 금액 숫자와 "원" 단위를 서로 다른
    // 형제 리프로 쪼갠다("16,300"과 "원"이 별개 span). 리프 하나만 보고
    // AMOUNT_RE를 검사하면 둘 다 탈락해 스킵되고, 우연히 숫자+원이 한 리프에
    // 같이 있는 엉뚱한 값("163원 적립" 적립 배지)을 잘못 집는다. selector.ts의
    // nextLeafStartsWithWon과 동일 로직 — 같이 고칠 것.
    const nextLeafStartsWithWon = (all: Element[], i: number): boolean => {
      for (let j = i + 1; j < Math.min(i + 4, all.length); j++) {
        const cand = all[j];
        if (!cand || cand.children.length > 0) continue;
        const t = elText(cand);
        if (t === "") continue;
        return t.startsWith("원");
      }
      return false;
    };
    if (labelEl) {
      const all = Array.from(document.querySelectorAll("*"));
      const idx = all.indexOf(labelEl);
      for (let i = idx + 1; i < all.length; i++) {
        const cand = all[i];
        if (!cand || cand.children.length > 0) continue; // 리프만
        const t = elText(cand);
        if (t === "") continue;
        if (amountOnly) {
          const combined = /[\d,]{2,}\s*원/.test(t);
          const splitNumber = /^[\d,]{2,}$/.test(t) && nextLeafStartsWithWon(all, i);
          // 라이브 함정: 라벨 뒤에 숫자 없는 빈 "원" 노드가 올 수 있다 → 금액성 검증.
          if (!combined && !splitNumber) continue;
        }
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
  if (op === "clickable") {
    // 눌리는 상태인가 — DOM에 존재하는 것만으론 부족하다. 쿠팡 결제창은 React
    // 앱이라 서버 렌더된 [결제하기]가 먼저 보이고, 하이드레이션이 끝나야 onClick이
    // 붙는다. 그 전에 누르면 아무 일도 안 일어나고 오류도 없다(2026-09-26 실사용).
    // React는 핸들러를 DOM 노드의 __reactProps$* 에 얹으므로 그 존재를 확인하고,
    // 프레임워크를 안 쓰는 페이지를 위해 inline onclick도 함께 본다.
    const disabled = (el as HTMLButtonElement).disabled === true;
    const hasInline = typeof (el as HTMLElement).onclick === "function";
    const hasReact = Object.keys(el).some((k) => {
      if (!k.startsWith("__reactProps$")) return false;
      const props = (el as unknown as Record<string, { onClick?: unknown }>)[k];
      return typeof props?.onClick === "function";
    });
    return !disabled && (hasInline || hasReact) ? "1" : "0";
  }
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
    action: "text" | "click" | "fill" | "clickable",
    val: string | null = null,
    world?: "MAIN",
  ): Promise<string | null> {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [sel, action, val],
      func: pageOp,
      ...(world ? { world } : {}),
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

  /** ⚠️ 이 검사만 **MAIN 월드**에서 돌린다. executeScript는 기본이 격리 월드인데,
   *  React가 DOM 노드에 얹는 `__reactProps$*`나 페이지가 설정한 `onclick` 같은
   *  expando는 **페이지 월드의 것이라 격리 월드에서는 보이지 않는다** — 격리
   *  월드에서 검사했더니 항상 false가 나와 결제가 pay_button_not_ready로 실패했다
   *  (2026-09-26). 반대로 `.click()`은 DOM 이벤트라 월드를 넘어 전달되므로
   *  클릭은 기존대로 격리 월드에서 한다(페이지 스크립트와 섞이지 않게).
   *  MAIN 월드 주입이 거부되는 환경(구버전 등)에서는 결제를 막지 않고, 대신
   *  `readyState=complete` + 여유 시간으로 대신 판단한다. */
  async waitClickable(tabId: number, selector: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let probeFailed = false;
    while (Date.now() < deadline) {
      try {
        if ((await this.op(tabId, selector, "clickable", null, "MAIN")) === "1") return true;
      } catch {
        probeFailed = true;
        break;
      }
      await delay(200);
    }
    if (!probeFailed) return false;
    // 폴백: 핸들러를 확인할 수 없으니 로딩 완료 + 짧은 정착 시간으로 대신한다.
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.readyState,
    });
    await delay(1500);
    return res?.result === "complete";
  }

  async waitForOutcome(
    tabId: number,
    cfg: {
      successSel: string;
      orderIdSel: string;
      passwordUiSel?: string;
      timeoutMs: number;
      handoffTimeoutMs?: number;
      expectedOrigin: string;
      onPasswordRequired?: () => Promise<void>;
    },
  ): Promise<CompletionResult> {
    let deadline = Date.now() + cfg.timeoutMs;
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
          // 사람이 알림을 보고 탭을 찾아 6자리를 입력하기까지는 자동 진행보다
          // 훨씬 오래 걸린다 — 기본 timeoutMs(180s)로는 입력 중에 타임아웃이 나서
          // "쿠팡에선 결제됐는데 우리 기록은 failed"가 될 수 있다(실사용 확인).
          // 핸드오프 시점부터 상한을 다시 잡는다.
          if (cfg.handoffTimeoutMs) deadline = Date.now() + cfg.handoffTimeoutMs;
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
