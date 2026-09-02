import type { PaymentMethod } from "@autopay/shared";
import type { Identity } from "../refstore/refstore.js";

// Payment Executor 타입 (docs/spec/executor.md).

export interface VerifiedCheckout {
  amount: number; // 결제창에서 파싱한 실제 금액(원)
  merchantName: string;
  snapshot: string; // 결제 대상 핵심 필드 해시(TOCTOU 재검증 기준)
}

export interface PayInput {
  tabId: number;
  identity?: Identity; // 패턴 B만 필요(refstore). 패턴 C 미사용.
  timeoutMs: number;
  approvedSnapshot: string; // 승인 시점 스냅샷 — 실행 직전 재검증
}

export type PayOutcome =
  | { status: "approved"; orderId: string; amount: number }
  | { status: "canceled" }
  | { status: "timeout" }
  | { status: "failed"; error: string };

export interface SimplePayAdapter {
  readonly method: PaymentMethod;
  readonly hasExternalApproval: boolean; // 카카오/토스=true, 쿠팡=false
  verify(tabId: number): Promise<VerifiedCheckout>;
  pay(input: PayInput): Promise<PayOutcome>;
}

// 결제창 조작 추상화(페이지별 구현). "손"(content script)이 실제 DOM을 다룬다.
export interface CheckoutView {
  amount: number;
  merchantName: string;
  itemsKey: string; // 상품·수량 정규화 키(스냅샷 구성용)
}

export type CompletionResult =
  | { status: "approved"; orderId: string }
  | { status: "canceled" }
  | { status: "timeout" }
  | { status: "failed"; error: string };

export interface CheckoutDriver {
  readonly method: PaymentMethod;
  readonly hasExternalApproval: boolean;
  /** 결제창/체크아웃에서 결제 대상 필드를 독립 파싱. */
  readCheckout(tabId: number): Promise<CheckoutView>;
  /** 패턴 B: 식별정보 입력→폰 푸시 트리거 / 패턴 C: [결제하기] 클릭. */
  startPayment(tabId: number, ctx: { identity?: Identity }): Promise<void>;
  /** 완료 신호 독립 파싱까지 대기. 비번 UI 등장(쿠팡)·취소·타임아웃 구분. */
  awaitCompletion(tabId: number, timeoutMs: number): Promise<CompletionResult>;
}
