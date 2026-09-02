import type { PaymentMethod } from "@autopay/shared";
import type { Identity } from "../refstore/refstore.js";
import { SimplePayCore } from "./core.js";
import type { CheckoutDriver, CheckoutView, CompletionResult, SimplePayAdapter } from "./types.js";

// 결제수단별 어댑터 (docs/spec/executor.md, docs/payment-flows.md).
// "손"(content script)은 PageBridge로 추상화. 셀렉터·완료신호는 실결제 네트워크
// 캡처로 확정한다(payment-flows 검증 항목) — 아래 값은 확정 전 placeholder.

export interface PageBridge {
  readText(tabId: number, selector: string): Promise<string | null>;
  origin(tabId: number): Promise<string>; // 결제 탭의 실제 origin(location.origin)
  fill(tabId: number, selector: string, value: string): Promise<void>;
  click(tabId: number, selector: string): Promise<void>;
  /** 완료/취소/타임아웃/비번UI 등장을 관찰해 결과로 반환(대기는 브리지가 소유). */
  waitForOutcome(
    tabId: number,
    cfg: { successSel: string; orderIdSel: string; passwordUiSel?: string; timeoutMs: number },
  ): Promise<CompletionResult>;
}

interface AdapterConfig {
  method: PaymentMethod;
  hasExternalApproval: boolean;
  flow: "patternB" | "patternC";
  selectors: {
    amount: string;
    merchant: string;
    items: string;
    payButton: string; // 패턴 C: [결제하기] / 패턴 B: 결제수단 확정 버튼
    next?: string; // 패턴 B: 휴대폰/생년월일 입력 후 [다음]
    phone?: string;
    birth?: string;
    success: string;
    orderId: string;
    passwordUi?: string; // 등장 시 failed(비번 미입력) — 패턴 C 안전장치
  };
  merchantName: string;
}

// ⚠️ placeholder 셀렉터 — 실결제 캡처로 확정 필요 (payment-flows.md "검증 필요").
export const KAKAO: AdapterConfig = {
  method: "kakaopay",
  hasExternalApproval: true,
  flow: "patternB",
  merchantName: "카카오페이",
  selectors: {
    amount: "[data-amount]",
    merchant: "[data-merchant]",
    items: "[data-items]",
    payButton: "#kakaopay-select",
    next: "#kakaopay-next",
    phone: "#phoneNumber",
    birth: "#dateOfBirth",
    success: "[data-order-complete]",
    orderId: "[data-order-id]",
  },
};

export const COUPAY: AdapterConfig = {
  method: "coupay",
  hasExternalApproval: false,
  flow: "patternC",
  merchantName: "쿠팡",
  selectors: {
    amount: ".total-price",
    merchant: ".merchant-name",
    items: ".order-items",
    payButton: "#place-order",
    success: ".order-complete",
    orderId: ".order-number",
    passwordUi: ".payment-password-keypad", // 등장 = 원터치 아님 → failed
  },
};

export const TOSS: AdapterConfig = { ...KAKAO, method: "tosspay", merchantName: "토스페이" };

const CONFIGS: Record<PaymentMethod, AdapterConfig> = {
  kakaopay: KAKAO,
  coupay: COUPAY,
  tosspay: TOSS,
};

class DomCheckoutDriver implements CheckoutDriver {
  constructor(
    private readonly bridge: PageBridge,
    private readonly cfg: AdapterConfig,
  ) {}

  get method() {
    return this.cfg.method;
  }
  get hasExternalApproval() {
    return this.cfg.hasExternalApproval;
  }

  async readCheckout(tabId: number): Promise<CheckoutView> {
    const s = this.cfg.selectors;
    const amount = parseWon(await this.bridge.readText(tabId, s.amount));
    const merchant = (await this.bridge.readText(tabId, s.merchant)) ?? this.cfg.merchantName;
    const itemsKey = ((await this.bridge.readText(tabId, s.items)) ?? "").trim();
    const origin = await this.bridge.origin(tabId);
    // 페이지 문자열은 길이 상한으로 방어(로그·API 유출 최소화, coding-guide §4).
    return { amount, merchantName: cap(merchant.trim(), 80), origin, itemsKey: cap(itemsKey, 200) };
  }

  async startPayment(tabId: number, ctx: { identity?: Identity }): Promise<void> {
    const s = this.cfg.selectors;
    if (this.cfg.flow === "patternB") {
      if (ctx.identity && s.phone && s.birth) {
        await this.bridge.fill(tabId, s.phone, ctx.identity.phone);
        await this.bridge.fill(tabId, s.birth, ctx.identity.birth);
      }
      await this.bridge.click(tabId, s.payButton);
      if (s.next) await this.bridge.click(tabId, s.next);
    } else {
      // 패턴 C: 원터치 [결제하기] 클릭만. 비밀번호 입력 없음.
      await this.bridge.click(tabId, s.payButton);
    }
  }

  async awaitCompletion(tabId: number, timeoutMs: number): Promise<CompletionResult> {
    const s = this.cfg.selectors;
    return this.bridge.waitForOutcome(tabId, {
      successSel: s.success,
      orderIdSel: s.orderId,
      passwordUiSel: s.passwordUi,
      timeoutMs,
    });
  }
}

export function createAdapter(method: PaymentMethod, bridge: PageBridge): SimplePayAdapter {
  return new SimplePayCore(new DomCheckoutDriver(bridge, CONFIGS[method]));
}

/** "₩23,500", "23,500원" 등 → 23500 */
export function parseWon(text: string | null): number {
  if (!text) return Number.NaN;
  const digits = text.replace(/[^\d]/g, "");
  return digits === "" ? Number.NaN : Number.parseInt(digits, 10);
}

/** 페이지 유래 문자열 길이 상한(로그·API 유출 표면 축소). */
function cap(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}
