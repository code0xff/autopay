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

// 라벨류 매칭(`contains:`/`label:`/`after:`)은 XPath가 아니라 이 정규화 + JS
// 문자열 비교로 한다. 이유: 한국어 사이트는 여러 단어짜리 라벨(예: "총 결제
// 금액")이 줄바꿈 없이 붙어 보이도록 단어 사이에 NBSP(U+00A0)를 쓰는 경우가
// 흔한데, XPath의 normalize-space()는 ASCII 공백만 처리하고 NBSP는 그대로
// 남겨서 소스에 일반 스페이스로 적은 라벨 리터럴과 절대 안 맞는다.
// ⚠️ 이력 정정(2026-09-23): 이 정규화를 "쿠팡 amount 파싱 실패의 진짜 원인"으로
//    단정하고 커밋한 적이 있는데 **틀렸다**. 라이브 DOM을 직접 검사해 보니 그
//    라벨은 일반 스페이스(0x20)였고, 실제 원인은 숫자와 "원"이 별개 리프로
//    쪼개져 있던 것(findAfterLabel 주석 참조)이었다. 이 정규화는 여전히 유효한
//    방어 코드지만, 그 버그의 원인은 아니었다.
function normText(s: string): string {
  return s
    .replace(/[   -​  　]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function elementText(el: Element): string {
  return normText(el.textContent ?? "");
}

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

/** 문자열을 포함하는 **화면에 보이는** 요소(존재 여부 판정용 — 정확한 문구를 모를 때).
 *  가장 안쪽(같은 문자열을 포함하는 자식이 없는) 일치 요소만 후보로 삼아
 *  컨테이너가 아니라 실제 텍스트 노드에 가까운 걸 반환한다. (예: contains:비밀번호)
 *  숨김 요소(미리 렌더된 모달·display:none 템플릿 등)는 건너뛴다 — 그런 곳의
 *  "비밀번호" 문구가 원터치 정상 결제를 password_required로 오판하게 만들기 때문.
 *  XPath가 아니라 순수 JS 순회 + normText로 비교한다(NBSP 등 대응, 위 설명 참조). */
function findByContains(doc: Document, needle: string): Element | null {
  const target = normText(needle);
  const innermost = Array.from(doc.querySelectorAll("*")).filter(
    (el) =>
      elementText(el).includes(target) &&
      !Array.from(el.children).some((c) => elementText(c).includes(target)),
  );
  return innermost.find(isVisible) ?? null;
}

/** 화면에 보이는가. 실 브라우저는 checkVisibility(레이아웃 기준)로, 레이아웃이
 *  없는 환경(linkedom)은 hidden/aria-hidden/inline style 조상 검사로 판정한다.
 *  ⚠️ chrome-page-bridge.pageOp에 같은 로직이 인라인 복제돼 있다 — 같이 고칠 것. */
function isVisible(el: Element): boolean {
  const check = (el as { checkVisibility?: (o?: object) => boolean }).checkVisibility;
  if (typeof check === "function") {
    return check.call(el, { visibilityProperty: true, opacityProperty: true });
  }
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    if (cur.hasAttribute("hidden") || cur.getAttribute("aria-hidden") === "true") return false;
    const style = (cur.getAttribute("style") ?? "").replace(/\s+/g, "").toLowerCase();
    if (/display:none|visibility:hidden|opacity:0(?![.\d])/.test(style)) return false;
  }
  return true;
}

/** 라벨 뒤 문서순 첫 요소. amountOnly면 "…원"인 것만.
 *  (label:총 결제 금액 → "16,300원" / after:주문번호 → "8842-1179")
 *  라벨 자체는 findByContains와 같은 전략(부분 포함 + 가장 안쪽 + 화면에
 *  보이는 요소 + normText)으로 앵커한다 — 강조 태그로 감싸여 있어도, 단어
 *  사이에 NBSP가 있어도 안정적으로 잡는다(둘 다 실사용 중 발견한 실패 원인).
 *
 *  2026-09-23 실사용 3차 버그: 쿠팡은 금액 숫자와 "원" 단위를 **서로 다른
 *  형제 리프**로 쪼개 렌더링한다("16,300"과 "원"이 별개 span — 하나의 리프
 *  안에 "16,300원"처럼 같이 있지 않다). 리프 하나만 보고 AMOUNT_RE를 검사하면
 *  "16,300"(원 없음)도 "원"(숫자 없음)도 둘 다 탈락해 스킵되고, 계속 진행하다
 *  우연히 숫자+원이 한 리프에 같이 있는 엉뚱한 값("163원 적립" 같은 적립 배지)을
 *  잘못 집는다. 그래서 숫자만 있는 리프(`[\d,]{2,}`)를 만나면 바로 다음
 *  비어있지 않은 리프가 "원"으로 시작하는지 확인해 결합 판정한다. */
function findAfterLabel(doc: Document, label: string, amountOnly: boolean): Element | null {
  const all = Array.from(doc.querySelectorAll("*"));
  const target = normText(label);
  const idx = all.findIndex(
    (el) =>
      isVisible(el) &&
      elementText(el).includes(target) &&
      !Array.from(el.children).some((c) => elementText(c).includes(target)),
  );
  if (idx < 0) return null;
  for (let i = idx + 1; i < all.length; i++) {
    const el = all[i];
    if (!el || el.children.length > 0) continue; // 리프만
    const t = elementText(el);
    if (t === "") continue;
    if (amountOnly) {
      const combined = AMOUNT_RE.test(t);
      const splitNumber = /^[\d,]{2,}$/.test(t) && nextLeafStartsWithWon(all, i);
      if (!combined && !splitNumber) continue; // 라이브 함정: 빈 "원" 노드 건너뜀
    }
    if (!isVisible(el)) continue;
    return el;
  }
  return null;
}

/** i 다음 문서순 리프들을 몇 개 훑어 첫 비어있지 않은 텍스트가 "원"으로
 *  시작하는지 본다 — 숫자만 있는 리프와 "원" 리프가 분리된 케이스 판정용. */
function nextLeafStartsWithWon(all: Element[], i: number): boolean {
  for (let j = i + 1; j < Math.min(i + 4, all.length); j++) {
    const el = all[j];
    if (!el || el.children.length > 0) continue;
    const t = elementText(el);
    if (t === "") continue;
    return t.startsWith("원");
  }
  return false;
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
