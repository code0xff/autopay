// "손"(제네릭): MCP 브리지의 open/read_page/click/fill이 쓰는 범용 DOM 접근.
// executor/adapters의 PageBridge와 달리 특정 결제창 셀렉터에 묶이지 않는다.
// (docs/spec/mcp-integration.md §3 — read_page는 스크린샷이 아니라 요소 목록)

export interface PageElement {
  selector: string; // nth-of-type 기반 CSS 셀렉터(click/fill에 재사용 가능)
  tag: string;
  role?: string;
  text: string; // 트림·길이 상한
  href?: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  elements: PageElement[];
}

export interface GenericPageBridge {
  /** 브리지 탭에서 url을 연다(없으면 새 탭, 있으면 재사용해 이동). 탭 id 반환. */
  openOrReuse(url: string, existingTabId: number | null): Promise<number>;
  readPage(tabId: number): Promise<PageSnapshot>;
  click(tabId: number, selector: string): Promise<void>;
  fill(tabId: number, selector: string, value: string): Promise<void>;
}

const MAX_ELEMENTS = 150;
const MAX_TEXT = 200;

/** 브라우저 컨텍스트에서 실행되는 순수 함수 — chrome.scripting.executeScript로 주입. */
export function serializePage(maxElements: number, maxText: number): PageSnapshot {
  const SEL = "a,button,input,select,textarea,[role],h1,h2,h3,[data-testid]";
  const nodes = Array.from(document.querySelectorAll(SEL)).filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0; // 화면에 실제로 보이는 요소만
  });

  function cssSelector(el: Element): string {
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur !== null && parts.length < 6) {
      const node: Element = cur;
      let part = node.tagName.toLowerCase();
      const parent: Element | null = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(">");
  }

  const elements = nodes.slice(0, maxElements).map((el) => {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role") ?? undefined;
    let text = (el.textContent ?? "").trim();
    if (tag === "input" || tag === "textarea" || tag === "select") {
      // 비번 입력칸의 값은 절대 반환하지 않는다(사용자가 직접 입력한 비번이
      // 에이전트에게 새지 않게 — executor.md §3.2, mcp-integration §10).
      const isPassword = (el as HTMLInputElement).type === "password";
      text = isPassword
        ? el.getAttribute("placeholder") || ""
        : (el as HTMLInputElement).value || el.getAttribute("placeholder") || "";
    }
    text = text.slice(0, maxText);
    const href = tag === "a" ? (el as HTMLAnchorElement).href : undefined;
    return { selector: cssSelector(el), tag, role, text, href };
  });

  return { url: location.href, title: document.title, elements };
}

export class ChromeGenericPageBridge implements GenericPageBridge {
  async openOrReuse(url: string, existingTabId: number | null): Promise<number> {
    if (existingTabId !== null) {
      try {
        const tab = await chrome.tabs.update(existingTabId, { url });
        if (tab?.id) return tab.id;
      } catch {
        // 탭이 사라졌으면 새로 연다.
      }
    }
    const tab = await chrome.tabs.create({ url, active: false });
    if (!tab.id) throw new Error("tab_create_failed");
    return tab.id;
  }

  async readPage(tabId: number): Promise<PageSnapshot> {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [MAX_ELEMENTS, MAX_TEXT],
      func: serializePage,
    });
    return (
      (res?.result as PageSnapshot | undefined) ?? {
        url: "",
        title: "",
        elements: [],
      }
    );
  }

  async click(tabId: number, selector: string): Promise<void> {
    await chrome.scripting.executeScript({
      target: { tabId },
      args: [selector],
      func: (sel: string) => (document.querySelector(sel) as HTMLElement | null)?.click(),
    });
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
}
