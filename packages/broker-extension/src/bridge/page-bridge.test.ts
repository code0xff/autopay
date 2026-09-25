import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { serializePage } from "./page-bridge.js";

// serializePage는 chrome.scripting.executeScript로 **소스 직렬화되어** 페이지에
// 주입된다. 그래서 모듈 스코프의 상수·헬퍼를 참조하면 페이지 컨텍스트에서
// ReferenceError가 나는데, readPage가 빈 스냅샷으로 폴백해서 **조용히 실패**한다
// (2026-09-26 실사용: read_page가 계속 {url:"",title:"",elements:[]}만 반환).
//
// 그냥 import해서 호출하면 모듈 스코프가 살아 있어 이 버그를 못 잡는다. 그래서
// 함수 소스를 document/location만 있는 격리 스코프에서 평가해 제약을 재현한다.
function runIsolated(html: string) {
  const { document } = parseHTML(`<html><head><title>t</title></head><body>${html}</body></html>`);
  // linkedom엔 레이아웃이 없어 getBoundingClientRect가 없다 — 보이는 요소로 친다.
  for (const el of Array.from(document.querySelectorAll("*"))) {
    (el as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
      ({ width: 10, height: 10 }) as DOMRect;
  }
  const factory = new Function("document", "location", `return (${serializePage.toString()})`);
  const fn = factory(document, { href: "https://checkout.example/x" }) as typeof serializePage;
  return fn(150, 200);
}

describe("serializePage — 주입 격리 스코프에서 동작", () => {
  it("1. 모듈 스코프를 참조하지 않는다(격리 평가에서 throw 없음)", () => {
    expect(() => runIsolated("<button>결제하기</button>")).not.toThrow();
  });

  it("2. 상호작용 요소를 담는다", () => {
    const snap = runIsolated("<button>결제하기</button>");
    expect(snap.url).toBe("https://checkout.example/x");
    expect(snap.elements.some((e) => e.tag === "button" && e.text === "결제하기")).toBe(true);
  });

  it("3. 상호작용 요소가 아닌 KRW 금액 리프도 담는다(체크아웃 총액)", () => {
    const snap = runIsolated(
      "<div><span>총 결제 금액</span><span>20,230원</span></div><button>결제하기</button>",
    );
    expect(snap.elements.some((e) => e.text === "20,230원")).toBe(true);
  });

  it("4. 금액이 아닌 긴 본문 텍스트까지 긁어오지는 않는다", () => {
    const long = "가".repeat(120);
    const snap = runIsolated(`<p>${long}</p><button>결제하기</button>`);
    expect(snap.elements.some((e) => e.text.includes(long))).toBe(false);
  });
});
