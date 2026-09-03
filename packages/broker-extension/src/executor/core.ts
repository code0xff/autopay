import type {
  CheckoutDriver,
  CheckoutView,
  PayInput,
  PayOutcome,
  SimplePayAdapter,
  VerifiedCheckout,
} from "./types.js";

// 패턴 B/C 공통 실행 로직 (docs/spec/executor.md §2.1).
// 페이지별 차이는 CheckoutDriver가 흡수. 코어는 스냅샷 바인딩 + 실행 직전
// 재검증(TOCTOU 방어) + 결과 매핑만 담당한다.

export class SimplePayCore implements SimplePayAdapter {
  constructor(private readonly driver: CheckoutDriver) {}

  get method() {
    return this.driver.method;
  }
  get hasExternalApproval() {
    return this.driver.hasExternalApproval;
  }

  async verify(tabId: number): Promise<VerifiedCheckout> {
    const view = await this.driver.readCheckout(tabId);
    return {
      amount: view.amount,
      merchantName: view.merchantName,
      origin: view.origin,
      snapshot: await snapshotOf(view),
    };
  }

  async pay(input: PayInput): Promise<PayOutcome> {
    // 실행 직전 재검증: 승인 후 결제 대상이 바뀌었으면 결제하지 않는다.
    const current = await this.driver.readCheckout(input.tabId);
    const snapshot = await snapshotOf(current);
    if (snapshot !== input.approvedSnapshot) {
      return { status: "canceled", reason: "content_changed" }; // TOCTOU
    }

    await this.driver.startPayment(input.tabId, { identity: input.identity });
    // 완료 판정은 승인 시점과 동일 origin에서만 인정(허위 완료 페이지 차단).
    const result = await this.driver.awaitCompletion(input.tabId, input.timeoutMs, current.origin);
    if (result.status === "approved") {
      return { status: "approved", orderId: result.orderId.slice(0, 64), amount: current.amount };
    }
    if (result.status === "canceled") {
      return { status: "canceled", reason: "user" };
    }
    return result;
  }
}

/** 결제 대상 스냅샷 해시. 금액·가맹점·origin·상품키를 JSON 정규화(구분자 충돌
 *  없음)해 SHA-256. origin을 포함해 탭 바꿔치기까지 스냅샷에 바인딩한다. */
export async function snapshotOf(view: CheckoutView): Promise<string> {
  const canonical = JSON.stringify([view.amount, view.merchantName, view.origin, view.itemsKey]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
