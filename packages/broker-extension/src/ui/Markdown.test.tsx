import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown.js";

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

describe("Markdown", () => {
  it("1. 굵게·목록·문단 (실제 답변 모양)", () => {
    const out = html(
      "오늘 남은 결제 한도는 **50,000원**, 결제 가능 횟수는 **3회**입니다.\n\n- 건당 한도: **20,000원**\n- 이용 가능: 쿠팡 · 쿠페이",
    );
    expect(out).toContain("<strong>50,000원</strong>");
    expect(out).toContain(
      "<ul><li>건당 한도: <strong>20,000원</strong></li><li>이용 가능: 쿠팡 · 쿠페이</li></ul>",
    );
    expect(out).not.toContain("**");
  });

  it("2. 번호 목록·제목·인라인 코드·코드 블록", () => {
    const out = html("## 결과\n1. 첫째\n2. `둘째`\n\n```\nconst a = 1 * 2;\n**그대로**\n```");
    expect(out).toContain("<h4>결과</h4>");
    expect(out).toContain("<ol><li>첫째</li><li><code>둘째</code></li></ol>");
    expect(out).toContain("<pre>const a = 1 * 2;\n**그대로**</pre>"); // 코드 블록 안은 해석 안 함
  });

  it("3. HTML은 주입되지 않고 글자로 나온다", () => {
    const out = html('<img src=x onerror="alert(1)"> **굵게**');
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
    expect(out).toContain("<strong>굵게</strong>");
  });

  it("4. 링크는 클릭할 수 없는 글자로 보여준다(주소를 숨기지 않는다)", () => {
    const out = html("[결제하러 가기](https://evil.example/pay)");
    expect(out).not.toContain("<a");
    expect(out).toContain("결제하러 가기 (https://evil.example/pay)");
  });

  it("5. 닫히지 않은 기호(스트리밍 도중)는 그대로 둔다", () => {
    expect(html("가격은 **20,2")).toContain("가격은 **20,2");
    expect(html("2 * 3 = 6")).toContain("2 * 3 = 6");
  });
});
