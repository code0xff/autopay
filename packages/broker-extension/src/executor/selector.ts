// 셀렉터 스킴 해석 (docs/spec/executor.md).
//
// 왜 필요한가 — 라이브 캡처(2026-09-22, checkout.coupang.com) 결과:
// 쿠팡 웹 결제창은 클래스가 전부 Tailwind 자동생성(`twc-mr-0.5 twc-whitespace-nowrap`)
// 이고 의미 있는 id가 없다. 즉 `#place-order` / `.total-price` 같은 **안정적 CSS
// 셀렉터가 존재하지 않는다.** 대신 화면 텍스트(라벨/버튼명)는 안정적이므로
// 텍스트·라벨 앵커로 요소를 찾는다.
//
// 지원 스킴:
//   css:<sel> | <sel>    → querySelector (기본)
//   text:<정확한 텍스트>  → 그 텍스트의 요소. 클릭요소(button/a/[role=button]) 우선,
//                          없으면 아무 요소나(완료 문구 같은 div 판정용)
//   contains:<부분 문자열> → 그 문자열을 포함하는 아무 요소나(정확한 문구를 모를 때 —
//                           예: 비밀번호 모달은 문구가 매번 다를 수 있어 "비밀번호"만 확인)
//   label:<라벨>          → 라벨 요소 뒤, 문서순 첫 "…원" 금액 요소
//   after:<라벨>          → 라벨 요소 뒤, 문서순 첫 비어있지 않은 리프(주문번호 등)
//
// 실 DOM에선 XPath(document.evaluate)로 빠르게, linkedom(테스트 픽스처)처럼
// XPath가 없는 환경에선 순회로 폴백한다.

const AMOUNT_RE = /[\d,]{2,}\s*원/;

/** 문서에서 스킴을 해석해 요소 하나를 찾는다. 못 찾으면 null. */
export function resolveIn(doc: Document, sel: string): Element | null {
  if (sel.startsWith("text:")) return findByText(doc, sel.slice(5));
  if (sel.startsWith("contains:")) return findByContains(doc, sel.slice(9));
  if (sel.startsWith("label:")) return findAfterLabel(doc, sel.slice(6), true);
  if (sel.startsWith("after:")) return findAfterLabel(doc, sel.slice(6), false);
  const css = sel.startsWith("css:") ? sel.slice(4) : sel;
  try {
    return doc.querySelector(css);
  } catch {
    return null;
  }
}

/** 정확 텍스트를 가진 요소. 클릭요소 우선, 없으면 아무 요소. (예: text:결제하기) */
function findByText(doc: Document, text: string): Element | null {
  const lit = xpLiteral(text);
  const clickable =
    tryXPath(doc, `//button[normalize-space(.)=${lit}]`) ??
    tryXPath(doc, `//a[normalize-space(.)=${lit}]`) ??
    tryXPath(doc, `//*[@role="button"][normalize-space(.)=${lit}]`);
  if (clickable) return clickable;
  const any = tryXPath(doc, `//*[normalize-space(text())=${lit}]`);
  if (any) return any;
  // 폴백(XPath 미지원): 클릭요소 → 임의 리프 순.
  const nodes = Array.from(doc.querySelectorAll("button,a,[role=button],input[type=submit]"));
  const hit = nodes.find((el) => (el.textContent ?? "").trim() === text);
  if (hit) return hit;
  return (
    Array.from(doc.querySelectorAll("*")).find(
      (el) => el.children.length === 0 && (el.textContent ?? "").trim() === text,
    ) ?? null
  );
}

/** 문자열을 포함하는 아무 요소나(존재 여부 판정용 — 정확한 문구를 모를 때).
 *  가장 안쪽(자식 없는) 일치 요소를 우선해 컨테이너가 아니라 실제 텍스트
 *  노드에 가까운 걸 반환한다. (예: contains:비밀번호) */
function findByContains(doc: Document, needle: string): Element | null {
  const lit = xpLiteral(needle);
  const xp = tryXPath(
    doc,
    `//*[contains(normalize-space(.),${lit})][not(.//*[contains(normalize-space(.),${lit})])]`,
  );
  if (xp) return xp;
  // 폴백(XPath 미지원): 전체 순회에서 텍스트가 가장 짧게 일치하는(=가장 안쪽) 요소.
  const matches = Array.from(doc.querySelectorAll("*")).filter((el) =>
    (el.textContent ?? "").includes(needle),
  );
  if (matches.length === 0) return null;
  // 길이가 같으면(조상-자손이 같은 텍스트만 감쌀 때) 문서순 뒤쪽 = 더 안쪽을 우선.
  return matches.reduce((a, b) =>
    (b.textContent ?? "").length <= (a.textContent ?? "").length ? b : a,
  );
}

/** 라벨 뒤 문서순 첫 요소. amountOnly면 "…원"인 것만.
 *  (label:최종 결제 금액 → "3,650원" / after:주문번호 → "8842-1179") */
function findAfterLabel(doc: Document, label: string, amountOnly: boolean): Element | null {
  const lit = xpLiteral(label);
  const cond = amountOnly ? '[contains(text(),"원")]' : '[normalize-space(text())!=""]';
  const xp = tryXPath(doc, `//*[normalize-space(text())=${lit}]/following::*${cond}[1]`);
  // 라이브 함정: 쿠팡은 "총 결제 금액" 뒤에 숫자 없는 빈 "원" 노드가 온다.
  // XPath contains()는 그걸 잡으므로 금액성 검증을 통과할 때만 채택한다.
  if (xp && (!amountOnly || AMOUNT_RE.test((xp.textContent ?? "").trim()))) return xp;
  // 폴백: 전체 순회에서 라벨 위치를 찾고 그 이후 첫 리프.
  const all = Array.from(doc.querySelectorAll("*"));
  const idx = all.findIndex((el) => (el.textContent ?? "").trim() === label);
  if (idx < 0) return null;
  for (let i = idx + 1; i < all.length; i++) {
    const el = all[i];
    if (!el || el.children.length > 0) continue;
    const t = (el.textContent ?? "").trim();
    if (t === "") continue;
    if (amountOnly && !AMOUNT_RE.test(t)) continue;
    return el;
  }
  return null;
}

function tryXPath(doc: Document, query: string): Element | null {
  const evaluate = (doc as { evaluate?: Document["evaluate"] }).evaluate;
  if (typeof evaluate !== "function") return null; // linkedom 등 XPath 미지원
  try {
    const r = evaluate.call(doc, query, doc, null, 9 /* FIRST_ORDERED_NODE_TYPE */, null);
    return (r.singleNodeValue as Element | null) ?? null;
  } catch {
    return null;
  }
}

/** XPath 문자열 리터럴(따옴표 포함 안전). */
function xpLiteral(s: string): string {
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return `concat("${s.split('"').join('",\'"\',"')}")`;
}
