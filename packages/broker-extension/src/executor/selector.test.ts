import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { resolveIn } from "./selector.js";

// 셀렉터 스킴 리졸버. 케이스는 라이브 캡처(2026-09-22 checkout.coupang.com)
// 구조를 그대로 옮겼다 — Tailwind 클래스뿐이라 CSS로 못 잡는 상황.
// 주의: 라벨류(contains:/label:/after:)는 실 DOM에서도 XPath를 쓰지 않는 순수 JS
//       경로라 여기 테스트가 실제 동작과 같은 코드를 검증한다. text: 스킴만
//       linkedom에 document.evaluate가 없어 순회 폴백을 타며, 그 경로의 실 DOM
//       대응물은 chrome-page-bridge.pageOp의 인라인 복제본이다(자동 동등성
//       테스트 없음 — 한쪽만 고치면 라이브에서 조용히 깨진다).

const doc = (html: string) => parseHTML(`<body>${html}</body>`).document as unknown as Document;

// 라이브 결제창 구조: 금액 라벨/값이 형제 span, 결제는 텍스트 버튼.
const CHECKOUT = `
  <div><span>결제수단</span><span>쿠페이 머니</span></div>
  <div><span>최종 결제 금액</span><span>3,650원</span></div>
  <div><span>배송비</span><span>0원</span></div>
  <div><span>총 결제 금액</span><span>원</span><span>3,650원</span></div>
  <button class="twc-cursor-pointer twc-text-sm">결제하기</button>`;

// 2026-09-23 실사용 버그 재현: "최종 결제 금액"은 값이 바로 붙은 라벨이 아니라
// **섹션 제목**이고, 그 뒤엔 최종 금액이 아닌 "총 상품 가격"(줄어들기 전 금액)이
// 먼저 나온다. 진짜 최종 금액은 맨 아래 "총 결제 금액" 옆에 있다. 이걸 몰라서
// amount 셀렉터가 "최종 결제 금액"을 앵커로 써서 "총 상품 가격"을 잘못 집었고,
// 브로커가 사용자가 실제로 결제한 금액과 다르다며 정상적으로 거절했다
// (amount_mismatch — 안전하게 작동한 것이지 결제 사고는 아니었음).
const REAL_CHECKOUT_SUMMARY = `
  <h2>최종 결제 금액</h2>
  <div><span>총 상품 가격</span><span>16,500원</span></div>
  <div><span>WOW 와우회원 총 추가 혜택</span><span>-200원</span></div>
  <div><span>와우 전용 즉시할인</span><span>-200원</span></div>
  <div><span>배송비</span><span>0원</span></div>
  <div><span>쿠팡캐시</span><button>전액사용</button><input value="0" /><span>원</span></div>
  <div>잔여 : 34원</div>
  <div><span>총 결제 금액</span><span>16,300원</span></div>`;

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

describe("resolveIn — contains 스킴(부분 포함, 존재 여부 판정용)", () => {
  // 2026-09-23: 쿠팡 비번 모달 감지가 정확한 문구를 몰라 실패하던 버그의
  // 재발 방지 회귀 — 문구가 뭐든 "비밀번호"만 포함하면 잡아야 한다.
  it("문구를 몰라도 부분 문자열만 있으면 잡는다(비번 모달 감지)", () => {
    const el = resolveIn(doc("<div>결제 비밀번호 6자리를 입력해주세요</div>"), "contains:비밀번호");
    expect(el?.textContent).toContain("비밀번호");
  });

  it("문구가 전혀 다르면(원터치 정상 화면) null", () => {
    expect(resolveIn(doc(CHECKOUT), "contains:비밀번호")).toBeNull();
  });

  it("중첩 컨테이너보다 가장 안쪽 일치 요소를 반환한다", () => {
    const el = resolveIn(
      doc(`<div class="modal"><p>비밀번호 6자리</p></div>`),
      "contains:비밀번호",
    );
    expect(el?.tagName.toLowerCase()).toBe("p");
  });

  // 2026-09-23: 숨김 요소의 "비밀번호" 문구(미리 렌더된 모달 등)로 원터치 정상
  // 결제가 password_required로 오판되지 않도록 — 보이는 요소만 잡는다.
  it("숨김 요소(hidden·aria-hidden·display:none·visibility:hidden·opacity:0)는 무시한다", () => {
    for (const hidden of [
      "<div hidden><p>비밀번호 6자리</p></div>",
      `<div aria-hidden="true"><p>비밀번호 6자리</p></div>`,
      `<div style="display: none"><p>비밀번호 6자리</p></div>`,
      `<div style="visibility:hidden"><p>비밀번호 6자리</p></div>`,
      `<div style="opacity: 0"><p>비밀번호 6자리</p></div>`,
    ]) {
      expect(resolveIn(doc(CHECKOUT + hidden), "contains:비밀번호")).toBeNull();
    }
  });

  it("숨김 사본이 있어도 보이는 비번 모달은 잡는다", () => {
    const el = resolveIn(
      doc("<div hidden><p>비밀번호 템플릿</p></div><div><p>결제 비밀번호 입력</p></div>"),
      "contains:비밀번호",
    );
    expect(el?.textContent).toBe("결제 비밀번호 입력");
  });

  it("opacity:0.5처럼 반투명은 보이는 것으로 본다", () => {
    const el = resolveIn(
      doc(`<div style="opacity:0.5"><p>비밀번호</p></div>`),
      "contains:비밀번호",
    );
    expect(el).not.toBeNull();
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

  it("[2026-09-23 회귀] '최종 결제 금액'은 제목일 뿐이라 그 뒤 첫 금액(총 상품 가격)을 " +
    "잘못 집는다 — 그래서 amount 앵커로 쓰면 안 된다(실사용 버그였음)", () => {
    expect(resolveIn(doc(REAL_CHECKOUT_SUMMARY), "label:최종 결제 금액")?.textContent).toBe(
      "16,500원",
    ); // 총 상품 가격 — 진짜 최종 금액이 아님. 이 값을 쓰면 amount_mismatch.
  });

  it("[2026-09-23 회귀] '총 결제 금액'을 앵커로 쓰면 실제 최종 금액을 정확히 잡는다", () => {
    expect(resolveIn(doc(REAL_CHECKOUT_SUMMARY), "label:총 결제 금액")?.textContent).toBe(
      "16,300원",
    );
  });

  it("[2026-09-23 회귀] 라벨이 강조 태그로 한 겹 더 감싸여도(direct text가 아니어도) 잡는다", () => {
    // amount_parse_failed 재현: 라벨이 <b>총 결제 금액</b>처럼 감싸여 있으면
    // 예전 구현(정확한 direct text만 매치)은 아예 못 찾고 null을 반환했다.
    const wrapped = `
      <div><b>총 결제 금액</b></div>
      <span>16,300원</span>`;
    expect(resolveIn(doc(wrapped), "label:총 결제 금액")?.textContent).toBe("16,300원");
  });

  it("[2026-09-23 회귀] 라벨 단어 사이에 NBSP(줄바꿈 방지용)가 있어도 잡는다", () => {
    // (라이브 DOM 검사 결과 쿠팡 amount 버그의 원인은 이게 아니었다 — 아래
    // '별개 형제 리프' 케이스가 진짜 원인. 이 정규화는 다른 사이트를 위한
    // 방어 코드로 유지한다.) 한국어 사이트는 여러 단어 라벨이 줄바꿈되지
    // 않도록 단어 사이에 일반 스페이스 대신 NBSP( )를 쓰는 경우가 흔하다.
    // 소스 코드의 라벨 리터럴은 일반 스페이스라서, 정규화 없이는 절대 안 맞는다.
    const nbsp = `
      <span>총 결제 금액</span>
      <span>16,300원</span>`;
    expect(resolveIn(doc(nbsp), "label:총 결제 금액")?.textContent).toBe("16,300원");
  });

  // 2026-09-23 실사용 3차 버그(진짜 최종 원인): 실 쿠팡 DOM은 라이브 브라우저
  // 검사(claude-in-chrome)로 확인한 결과 숫자와 "원" 단위가 **서로 다른 형제
  // 리프**다 — 하나의 리프 안에 "16,300원"처럼 합쳐져 있지 않다. 이전 구현은
  // 리프 하나만 보고 AMOUNT_RE(숫자+원 동시 포함)를 검사했기 때문에 "16,300"
  // (원 없음)도 "원"(숫자 없음)도 탈락해 건너뛰고, 그 뒤 우연히 숫자+원이 같이
  // 있는 무관한 적립 배지("163원 적립")를 잘못 집어 amount_mismatch를 냈다.
  it("[2026-09-23 회귀] 금액 숫자와 '원' 단위가 별개 형제 리프로 쪼개져 있어도 숫자 리프를 잡는다", () => {
    const split = `
      <span><span>총 결제 금액</span><span>16,300</span><span>원</span></span>
      <div><span>163원 적립</span></div>`;
    expect(resolveIn(doc(split), "label:총 결제 금액")?.textContent).toBe("16,300");
  });

  it("[2026-09-23 회귀] 쪼개진 숫자 리프 뒤에 '원'이 안 오면(무관한 숫자) 건너뛰고 진짜 금액을 찾는다", () => {
    const split = `
      <span><span>총 결제 금액</span><span>12</span><span>개</span><span>16,300</span><span>원</span></span>`;
    expect(resolveIn(doc(split), "label:총 결제 금액")?.textContent).toBe("16,300");
  });
});

describe("resolveIn — after 스킴(비금액)", () => {
  it("라벨 뒤 첫 비어있지 않은 리프 (주문번호)", () => {
    const d = doc("<div><span>주문번호</span><span>8842-1179</span></div>");
    expect(resolveIn(d, "after:주문번호")?.textContent).toBe("8842-1179");
  });
});
