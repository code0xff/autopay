import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { type PageBridge, createAdapter } from "./adapters.js";
import type { CompletionResult } from "./types.js";

// 픽스처 E2E: 모킹 결제창/완료 HTML에 실제 어댑터(createAdapter)를 돌려
// verify→(재검증)→클릭/입력→완료 파싱까지 "실제 실행 직전"까지 검증한다.
// 실결제·실계정·브라우저 없이 어댑터 config 셀렉터 + 코어 로직을 확인.
// (라이브 셀렉터 확정 시 이 픽스처만 실제 캡처로 교체하면 된다 — payment-flows.md)

/** linkedom 기반 PageBridge. completeOn 셀렉터 클릭 시 afterClick 페이지로 전이. */
class FixtureBridge implements PageBridge {
  private doc: ReturnType<typeof parseHTML>["document"];
  readonly filled: Record<string, string> = {};
  readonly clicked: string[] = [];

  constructor(
    checkoutHtml: string,
    private readonly afterClickHtml: string,
    private readonly originStr: string,
    private readonly completeOn: string,
  ) {
    this.doc = parseHTML(checkoutHtml).document;
  }

  /** 테스트에서 승인 후 결제 대상을 바꿔치기(TOCTOU 시뮬레이션). */
  mutate(fn: (doc: FixtureBridge["doc"]) => void): void {
    fn(this.doc);
  }

  async readText(_t: number, sel: string): Promise<string | null> {
    return this.doc.querySelector(sel)?.textContent ?? null;
  }
  async origin(): Promise<string> {
    return this.originStr;
  }
  async fill(_t: number, sel: string, value: string): Promise<void> {
    const el = this.doc.querySelector(sel) as { value?: string } | null;
    if (el) el.value = value;
    this.filled[sel] = value;
  }
  async click(_t: number, sel: string): Promise<void> {
    this.clicked.push(sel);
    if (sel === this.completeOn) this.doc = parseHTML(this.afterClickHtml).document;
  }
  async waitForOutcome(
    _t: number,
    cfg: { successSel: string; orderIdSel: string; passwordUiSel?: string; timeoutMs: number },
  ): Promise<CompletionResult> {
    if (cfg.passwordUiSel && this.doc.querySelector(cfg.passwordUiSel)) {
      return { status: "failed", error: "password_required" };
    }
    const ok = this.doc.querySelector(cfg.successSel);
    const orderId = this.doc.querySelector(cfg.orderIdSel)?.textContent?.trim() ?? "";
    if (ok && orderId) return { status: "approved", orderId };
    return { status: "timeout" };
  }
}

// ── 픽스처 HTML (placeholder 셀렉터 = adapters.ts config와 일치) ──
const COUPANG_CHECKOUT = `
  <div class="total-price">₩23,500</div>
  <div class="merchant-name">쿠팡</div>
  <div class="order-items">USB-C 허브 7in1 · 수량 1</div>
  <button id="place-order">결제하기</button>`;
const COUPANG_COMPLETE = `
  <div class="order-complete">주문이 완료되었습니다</div>
  <div class="order-number">8842-1179</div>`;
const COUPANG_PASSWORD = `<div class="payment-password-keypad">비밀번호 6자리</div>`;

const KAKAO_CHECKOUT = `
  <div data-amount>28,900원</div>
  <div data-merchant>카카오페이</div>
  <div data-items>무선 키보드 · 수량 1</div>
  <input id="phoneNumber" />
  <input id="dateOfBirth" />
  <button id="kakaopay-select">카카오페이</button>
  <button id="kakaopay-next">다음</button>`;
const KAKAO_COMPLETE = `
  <div data-order-complete>결제 완료</div>
  <div data-order-id>KKO-2211</div>`;

describe("결제 흐름 E2E (픽스처)", () => {
  it("쿠팡(패턴 C): verify 파싱 → [결제하기] → 완료 파싱 → approved", async () => {
    const bridge = new FixtureBridge(
      COUPANG_CHECKOUT,
      COUPANG_COMPLETE,
      "https://coupang.com",
      "#place-order",
    );
    const adapter = createAdapter("coupay", bridge);

    const v = await adapter.verify(0);
    expect(v.amount).toBe(23_500);
    expect(v.merchantName).toBe("쿠팡");
    expect(v.origin).toBe("https://coupang.com");
    expect(v.snapshot).toMatch(/^[0-9a-f]{64}$/);

    const out = await adapter.pay({ tabId: 0, timeoutMs: 1000, approvedSnapshot: v.snapshot });
    expect(out).toEqual({ status: "approved", orderId: "8842-1179", amount: 23_500 });
    expect(bridge.clicked).toContain("#place-order");
  });

  it("쿠팡: 승인 후 금액 바꿔치기(TOCTOU) → 재검증 불일치 → canceled, 클릭 안 함", async () => {
    const bridge = new FixtureBridge(
      COUPANG_CHECKOUT,
      COUPANG_COMPLETE,
      "https://coupang.com",
      "#place-order",
    );
    const adapter = createAdapter("coupay", bridge);
    const v = await adapter.verify(0);
    bridge.mutate((doc) => {
      const el = doc.querySelector(".total-price");
      if (el) el.textContent = "₩250,000"; // 결제 직전 대상 변경
    });
    const out = await adapter.pay({ tabId: 0, timeoutMs: 1000, approvedSnapshot: v.snapshot });
    expect(out).toEqual({ status: "canceled", reason: "content_changed" });
    expect(bridge.clicked).not.toContain("#place-order"); // 결제 시작 자체를 안 함
  });

  it("쿠팡: 비밀번호 UI 등장(원터치 아님) → failed(password_required)", async () => {
    const bridge = new FixtureBridge(
      COUPANG_CHECKOUT,
      COUPANG_PASSWORD,
      "https://coupang.com",
      "#place-order",
    );
    const adapter = createAdapter("coupay", bridge);
    const v = await adapter.verify(0);
    const out = await adapter.pay({ tabId: 0, timeoutMs: 1000, approvedSnapshot: v.snapshot });
    expect(out).toEqual({ status: "failed", error: "password_required" });
  });

  it("카카오(패턴 B): 휴대폰·생년월일 입력 → 다음 → 완료 파싱 → approved", async () => {
    const bridge = new FixtureBridge(
      KAKAO_CHECKOUT,
      KAKAO_COMPLETE,
      "https://coupang.com",
      "#kakaopay-next",
    );
    const adapter = createAdapter("kakaopay", bridge);
    const v = await adapter.verify(0);
    expect(v.amount).toBe(28_900);

    const out = await adapter.pay({
      tabId: 0,
      timeoutMs: 1000,
      approvedSnapshot: v.snapshot,
      identity: { phone: "01012345678", birth: "19900101" },
    });
    expect(out).toEqual({ status: "approved", orderId: "KKO-2211", amount: 28_900 });
    expect(bridge.filled["#phoneNumber"]).toBe("01012345678");
    expect(bridge.filled["#dateOfBirth"]).toBe("19900101");
    expect(bridge.clicked).toContain("#kakaopay-next");
  });
});
