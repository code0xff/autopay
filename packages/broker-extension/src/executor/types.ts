import type { PaymentMethod } from "@autopay/shared";
import type { Identity } from "../refstore/refstore.js";

// Payment Executor 타입 (docs/spec/executor.md).

export interface VerifiedCheckout {
  amount: number; // 결제창에서 파싱한 실제 금액(원)
  merchantName: string;
  origin: string; // 실제 결제 탭의 origin(정책 머천트 바인딩)
  snapshot: string; // 결제 대상 핵심 필드 해시(TOCTOU 재검증 기준)
}

export interface PayInput {
  tabId: number;
  identity?: Identity; // 패턴 B만 필요(refstore). 패턴 C 미사용.
  timeoutMs: number;
  /** 비번 핸드오프가 시작된 뒤 적용할 대기 상한(미지정이면 timeoutMs 유지).
   *  사람이 알림을 보고 탭을 찾아 6자리를 입력하는 시간은 자동 진행보다 훨씬
   *  오래 걸려서, 기본 timeoutMs로는 입력 중에 타임아웃이 난다(실사용 확인). */
  handoffTimeoutMs?: number;
  approvedSnapshot: string; // 승인 시점 스냅샷 — 실행 직전 재검증
  /** 비번 UI 등장 시 1회 호출(사용자 핸드오프 통지, executor.md §3.2). 미주입이면
   *  비번 UI 등장 = failed(password_required). */
  onPasswordHandoff?: () => Promise<void>;
}

export type PayOutcome =
  | { status: "approved"; orderId: string; amount: number }
  | { status: "canceled"; reason: "user" | "content_changed" }
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
  origin: string; // 결제 탭의 실제 origin
  itemsKey: string; // 상품·수량 정규화 키(스냅샷 구성용)
}

export type CompletionResult =
  | { status: "approved"; orderId: string }
  | { status: "canceled" } // 사용자 취소(폰/원터치)
  | { status: "timeout" }
  | { status: "failed"; error: string };

export interface CheckoutDriver {
  readonly method: PaymentMethod;
  readonly hasExternalApproval: boolean;
  /** 결제창/체크아웃에서 결제 대상 필드를 독립 파싱. */
  readCheckout(tabId: number): Promise<CheckoutView>;
  /** 패턴 B: 식별정보 입력→폰 푸시 트리거 / 패턴 C: [결제하기] 클릭. */
  startPayment(tabId: number, ctx: { identity?: Identity }): Promise<void>;
  /** 완료 신호 독립 파싱까지 대기. 완료 시점의 탭 origin이 expectedOrigin과
   *  일치해야 승인으로 인정(다른 페이지의 허위 완료 신호 차단).
   *  handoffTimeoutMs가 있으면 비번 핸드오프 시작 후 대기 상한을 그 값으로 늘린다. */
  awaitCompletion(
    tabId: number,
    timeoutMs: number,
    expectedOrigin: string,
    onPasswordRequired?: () => Promise<void>,
    handoffTimeoutMs?: number,
  ): Promise<CompletionResult>;
}
