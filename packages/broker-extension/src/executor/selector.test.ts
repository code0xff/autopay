import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { resolveIn } from "./selector.js";

// 셀렉터 스킴 리졸버. 케이스는 라이브 캡처(2026-09-22 checkout.coupang.com)
// 구조를 그대로 옮겼다 — Tailwind 클래스뿐이라 CSS로 못 잡는 상황.
// 주의: linkedom엔 document.evaluate가 없어 여기선 **순회 폴백 경로**를 검증한다
//       (실 DOM의 XPath 경로는 chrome-page-bridge.pageOp가 같은 규칙을 쓴다).

const doc = (html: string) => parseHTML(`<body>${html}</body>`).document as unknown as Document;

// 라이브 결제창 구조: 금액 라벨/값이 형제 span, 결제는 텍스트 버튼.
const CHECKOUT = `
  <div><span>결제수단</span><span>쿠페이 머니</span></div>
  <div><span>최종 결제 금액</span><span>3,650원</span></div>
  <div><span>배송비</span><span>0원</span></div>
  <div><span>총 결제 금액</span><span>원</span><span>3,650원</span></div>
  <button class="twc-cursor-pointer twc-text-sm">결제하기</button>`;

describe("resolveIn — css 스킴", () => {
  it("접두사 없으면 querySelector, css: 접두사도 동일", () => {
    const d = doc(`<div class="x">v</div>`);
    expect(resolveIn(d, ".x")?.textContent).toBe("v");
    expect(resolveIn(d, "css:.x")?.textContent).toBe("v");
  });

  it("잘못된 셀렉터는 throw 대신 null", () => {
    expect(resolveIn(doc("<p>a</p>"), "css:[[[")).toBeNull();
  });
});

describe("resolveIn — text 스킴", () => {
  it("클릭 요소를 찾는다 (결제하기 버튼)", () => {
    const el = resolveIn(doc(CHECKOUT), "text:결제하기");
    expect(el?.tagName.toLowerCase()).toBe("button");
  });

  it("클릭 요소가 없으면 일반 요소도 찾는다 (완료 문구 div)", () => {
    const el = resolveIn(doc("<div>주문이 완료되었습니다</div>"), "text:주문이 완료되었습니다");
    expect(el?.tagName.toLowerCase()).toBe("div");
  });

  it("부분일치는 잡지 않는다(정확 텍스트만)", () => {
    expect(resolveIn(doc("<button>결제하기여부</button>"), "text:결제하기")).toBeNull();
  });
});

describe("resolveIn — label 스킴(금액)", () => {
  it("라벨 뒤 첫 금액을 찾는다", () => {
    expect(resolveIn(doc(CHECKOUT), "label:최종 결제 금액")?.textContent).toBe("3,650원");
  });

  it("라이브 함정: 숫자 없는 빈 '원' 노드는 건너뛰고 진짜 금액을 잡는다", () => {
    expect(resolveIn(doc(CHECKOUT), "label:총 결제 금액")?.textContent).toBe("3,650원");
  });

  it("없는 라벨 → null", () => {
    expect(resolveIn(doc(CHECKOUT), "label:존재하지 않는 라벨")).toBeNull();
  });
});

describe("resolveIn — after 스킴(비금액)", () => {
  it("라벨 뒤 첫 비어있지 않은 리프 (주문번호)", () => {
    const d = doc("<div><span>주문번호</span><span>8842-1179</span></div>");
    expect(resolveIn(d, "after:주문번호")?.textContent).toBe("8842-1179");
  });
});
