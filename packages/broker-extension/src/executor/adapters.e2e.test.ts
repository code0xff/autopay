import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { type PageBridge, createAdapter } from "./adapters.js";
import { resolveIn } from "./selector.js";
import type { CompletionResult } from "./types.js";

// 픽스처 E2E: 모킹 결제창/완료 HTML에 실제 어댑터(createAdapter)를 돌려
// verify→(재검증)→클릭/입력→완료 파싱까지 "실제 실행 직전"까지 검증한다.
// 실결제·실계정 없이 어댑터 config 셀렉터 + 코어 로직을 확인.
//
// 쿠팡 픽스처는 **라이브 캡처(2026-09-22 checkout.coupang.com)** 구조를 그대로
// 옮긴 것이다 — Tailwind 클래스뿐이라 id/의미 클래스가 없고, 금액은 "최종 결제
// 금액" 라벨 뒤에, 결제는 텍스트 "결제하기" 버튼으로 존재한다.

/** linkedom 기반 PageBridge. completeOn 셀렉터 클릭 시 afterClick 페이지로 전이. */
class FixtureBridge implements PageBridge {
  private doc: ReturnType<typeof parseHTML>["document"];
  readonly filled: Record<string, string> = {};
  readonly clicked: string[] = [];
  handoffs = 0; // onPasswordRequired 호출 횟수
  /** 핸드오프 후 "사람이 직접 비번을 입력해" 도달하는 페이지. 없으면 사람이 입력 안 함. */
  afterUserPasswordHtml?: string;

  constructor(
    checkoutHtml: string,
    private readonly afterClickHtml: string,
    private readonly originStr: string,
    private readonly completeOn: string,
    private readonly completeOrigin?: string, // 완료 시점 origin(미지정 시 originStr)
    private itemsParam = "86091485721:1", // location:items (상품id:수량)
  ) {
    this.doc = parseHTML(checkoutHtml).document;
  }

  /** 테스트에서 승인 후 결제 대상을 바꿔치기(TOCTOU 시뮬레이션). */
  mutate(fn: (doc: FixtureBridge["doc"]) => void): void {
    fn(this.doc);
  }
  setItems(v: string): void {
    this.itemsParam = v;
  }
  /** 어댑터와 동일한 스킴 해석으로 요소를 찾는다. */
  find(sel: string): Element | null {
    return resolveIn(this.doc as unknown as Document, sel);
  }

  async readText(_t: number, sel: string): Promise<string | null> {
    if (sel === "location:items") return this.itemsParam;
    return this.find(sel)?.textContent ?? null;
  }
  async origin(): Promise<string> {
    return this.originStr;
  }
  async fill(_t: number, sel: string, value: string): Promise<void> {
    const el = this.find(sel) as { value?: string } | null;
    if (el) el.value = value;
    this.filled[sel] = value;
  }
  async click(_t: number, sel: string): Promise<void> {
    this.clicked.push(sel);
    if (sel === this.completeOn) this.doc = parseHTML(this.afterClickHtml).document;
  }
  async waitForOutcome(
    _t: number,
    cfg: {
      successSel: string;
      orderIdSel: string;
      passwordUiSel?: string;
      timeoutMs: number;
      expectedOrigin: string;
      onPasswordRequired?: () => Promise<void>;
    },
  ): Promise<CompletionResult> {
    // 완료 판정은 승인 시점 origin과 일치할 때만(허위 완료 페이지 차단).
    if ((this.completeOrigin ?? this.originStr) !== cfg.expectedOrigin)
      return { status: "timeout" };
    if (cfg.passwordUiSel && this.find(cfg.passwordUiSel)) {
      if (!cfg.onPasswordRequired) return { status: "failed", error: "password_required" };
      // 핸드오프: 통지 1회 후 사람의 직접 입력을 기다린다(브리지는 비번칸에 손대지 않음).
      this.handoffs++;
      await cfg.onPasswordRequired();
      if (!this.afterUserPasswordHtml) return { status: "timeout" }; // 사람이 입력 안 함
      this.doc = parseHTML(this.afterUserPasswordHtml).document;
    }
    const ok = this.find(cfg.successSel);
    const orderId = this.find(cfg.orderIdSel)?.textContent?.trim() ?? "";
    if (ok && orderId) return { status: "approved", orderId };
    return { status: "timeout" };
  }
}

// ── 픽스처 HTML (라이브 캡처 구조 반영) ──
const COUPANG_CHECKOUT = `
  <div><span>결제수단</span><span>쿠페이 머니</span></div>
  <div><span>최종 결제 금액</span><span>3,650원</span></div>
  <div><span>배송비</span><span>0원</span></div>
  <div><span>총 결제 금액</span><span>3,650원</span></div>
  <button>결제하기</button>`;
const COUPANG_COMPLETE = `
  <div>주문이 완료되었습니다</div>
  <div><span>주문번호</span><span>8842-1179</span></div>`;
const COUPANG_PASSWORD = `<div class="payment-password-keypad">비밀번호 6자리</div>`;
const COUPAY_PAY_SEL = "text:결제하기";

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
  it("쿠팡(패턴 C): 라이브 구조 파싱 → [결제하기] → 완료 파싱 → approved", async () => {
    const bridge = new FixtureBridge(
      COUPANG_CHECKOUT,
      COUPANG_COMPLETE,
      "https://checkout.coupang.com",
      COUPAY_PAY_SEL,
    );
    const adapter = createAdapter("coupay", bridge);

    const v = await adapter.verify(0);
    expect(v.amount).toBe(3_650); // "최종 결제 금액" 라벨 뒤 금액
    expect(v.merchantName).toBe("쿠팡"); // 가맹점 노드 없음 → 폴백
    expect(v.origin).toBe("https://checkout.coupang.com");
    expect(v.snapshot).toMatch(/^[0-9a-f]{64}$/);

    const out = await adapter.pay({ tabId: 0, timeoutMs: 1000, approvedSnapshot: v.snapshot });
    expect(out).toEqual({ status: "approved", orderId: "8842-1179", amount: 3_650 });
    expect(bridge.clicked).toContain(COUPAY_PAY_SEL);
  });

  it("쿠팡: 승인 후 금액 바꿔치기(TOCTOU) → 재검증 불일치 → canceled, 클릭 안 함", async () => {
    const bridge = new FixtureBridge(
      COUPANG_CHECKOUT,
      COUPANG_COMPLETE,
      "https://checkout.coupang.com",
      COUPAY_PAY_SEL,
    );
    const adapter = createAdapter("coupay", bridge);
    const v = await adapter.verify(0);
    bridge.mutate(() => {
      const el = bridge.find("label:최종 결제 금액");
      if (el) el.textContent = "250,000원"; // 결제 직전 대상 변경
    });
    const out = await adapter.pay({ tabId: 0, timeoutMs: 1000, approvedSnapshot: v.snapshot });
    expect(out).toEqual({ status: "canceled", reason: "content_changed" });
    expect(bridge.clicked).not.toContain(COUPAY_PAY_SEL); // 결제 시작 자체를 안 함
  });

  it("쿠팡: 금액 그대로여도 주문 상품(item[])이 바뀌면 → canceled", async () => {
    const bridge = new FixtureBridge(
      COUPANG_CHECKOUT,
      COUPANG_COMPLETE,
      "https://checkout.coupang.com",
      COUPAY_PAY_SEL,
    );
    const adapter = createAdapter("coupay", bridge);
    const v = await adapter.verify(0);
    bridge.setItems("99999999999:1"); // 같은 금액, 다른 상품으로 바꿔치기
    const out = await adapter.pay({ tabId: 0, timeoutMs: 1000, approvedSnapshot: v.snapshot });
    expect(out).toEqual({ status: "canceled", reason: "content_changed" });
    expect(bridge.clicked).not.toContain(COUPAY_PAY_SEL);
  });

  it("쿠팡: 비밀번호 UI 등장 + 핸드오프 훅 → 통지 1회 → 사람이 입력 → approved", async () => {
    const bridge = new FixtureBridge(
      COUPANG_CHECKOUT,
      COUPANG_PASSWORD,
      "https://checkout.coupang.com",
      COUPAY_PAY_SEL,
    );
    bridge.afterUserPasswordHtml = COUPANG_COMPLETE;
    const adapter = createAdapter("coupay", bridge);
    const v = await adapter.verify(0);
    let notified = 0;
    const out = await adapter.pay({
      tabId: 0,
      timeoutMs: 1000,
      approvedSnapshot: v.snapshot,
      onPasswordHandoff: async () => {
        notified++;
      },
    });
    expect(out).toEqual({ status: "approved", orderId: "8842-1179", amount: 3_650 });
    expect(notified).toBe(1);
    // 브로커는 비번칸을 채우거나 키패드를 누르지 않는다 — [결제하기] 한 번뿐.
    expect(bridge.filled).toEqual({});
    expect(bridge.clicked).toEqual([COUPAY_PAY_SEL]);
  });

  it("쿠팡: 핸드오프 후 사람이 입력하지 않으면 → timeout(결제 없음)", async () => {
    const bridge = new FixtureBridge(
      COUPANG_CHECKOUT,
      COUPANG_PASSWORD,
      "https://checkout.coupang.com",
      COUPAY_PAY_SEL,
    );
    const adapter = createAdapter("coupay", bridge);
    const v = await adapter.verify(0);
    const out = await adapter.pay({
      tabId: 0,
      timeoutMs: 1000,
      approvedSnapshot: v.snapshot,
      onPasswordHandoff: async () => {},
    });
    expect(out).toEqual({ status: "timeout" });
    expect(bridge.handoffs).toBe(1);
    expect(bridge.filled).toEqual({});
  });

  it("쿠팡: 비밀번호 UI 등장 + 핸드오프 훅 없음(구 호출부) → failed(password_required)", async () => {
    const bridge = new FixtureBridge(
      COUPANG_CHECKOUT,
      COUPANG_PASSWORD,
      "https://checkout.coupang.com",
      COUPAY_PAY_SEL,
    );
    const adapter = createAdapter("coupay", bridge);
    const v = await adapter.verify(0);
    const out = await adapter.pay({ tabId: 0, timeoutMs: 1000, approvedSnapshot: v.snapshot });
    expect(out).toEqual({ status: "failed", error: "password_required" });
  });

  it("쿠팡: 완료 페이지 origin이 승인 시점과 다르면(허위 완료) → 미승인(timeout)", async () => {
    const bridge = new FixtureBridge(
      COUPANG_CHECKOUT,
      COUPANG_COMPLETE,
      "https://checkout.coupang.com",
      COUPAY_PAY_SEL,
      "https://evil.example", // 완료 시점 다른 origin(탭 바꿔치기)
    );
    const adapter = createAdapter("coupay", bridge);
    const v = await adapter.verify(0);
    const out = await adapter.pay({ tabId: 0, timeoutMs: 50, approvedSnapshot: v.snapshot });
    expect(out).toEqual({ status: "timeout" }); // 완료로 인정하지 않음
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
