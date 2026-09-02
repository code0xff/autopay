import type {
  Decision,
  PaymentMethod,
  PaymentPolicy,
  PaymentRequest,
  PaymentResult,
} from "@autopay/shared";
import { PaymentRequest as PaymentRequestSchema } from "@autopay/shared";
import type { AuditLog } from "../audit/audit-log.js";
import type { SimplePayAdapter } from "../executor/types.js";
import type { Notifier, NotifyEvent } from "../notify/notifier.js";
import type { Kv } from "../platform/kv.js";
import { evaluate } from "../policy/engine.js";
import type { RefStore } from "../refstore/refstore.js";

// 브로커 오케스트레이션 (docs/spec/broker-api.md §2.3).
// 에이전트 노출 표면: requestPayment / getPaymentResult / getPolicySummary.
// confirm 해소(resolveConfirmation)는 UI 전용 내부 인터페이스.
// 감사에는 종단 결과 1건만 기록(pending confirm은 비종단이라 미기록).

export interface PolicySummary {
  remainingDailyBudget: number;
  remainingCountToday: number;
  allowedCategories: string[];
  allowedMerchants: string[] | "any";
  allowedMethods: PaymentMethod[];
}

export interface BrokerDeps {
  getPolicy: () => Promise<PaymentPolicy>;
  adapterFor: (method: PaymentMethod) => SimplePayAdapter;
  audit: AuditLog;
  notify: Notifier;
  refstore: RefStore;
  kv: Kv;
  now?: () => Date;
  idgen?: () => string;
  payTimeoutMs?: number;
}

type Terminal = "approved" | "rejected" | "failed" | "canceled" | "timeout";

interface RequestState {
  req: PaymentRequest;
  snapshot: string;
  verifiedAmount: number;
  merchantName: string;
  decision: Decision;
  result: PaymentResult;
}

export class BrokerCore {
  private readonly now: () => Date;
  private readonly idgen: () => string;
  private readonly payTimeoutMs: number;

  constructor(private readonly deps: BrokerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.idgen = deps.idgen ?? (() => crypto.randomUUID());
    this.payTimeoutMs = deps.payTimeoutMs ?? 180_000;
  }

  async requestPayment(input: unknown): Promise<{ requestId: string }> {
    const requestId = this.idgen();
    // 1. 경계 검증 — 스키마 실패면 신뢰 영역 진입 금지(fail-closed).
    const parsed = PaymentRequestSchema.safeParse(input);
    if (!parsed.success) {
      await this.audit(requestId, null, { type: "allow" }, "failed");
      await this.store(requestId, null, { status: "failed", error: "invalid_request" });
      return { requestId };
    }
    const req = parsed.data;
    const policy = await this.deps.getPolicy();
    const adapter = this.deps.adapterFor(req.method);

    // 3. 실제 금액 독립 파싱 + 스냅샷 → 4. 사용량 스냅샷 → 5. 정책 판정
    const verified = await adapter.verify(req.checkoutTabId);
    const usage = await this.deps.audit.usageFor(this.now());
    const decision = evaluate(req, policy, usage, verified.amount);

    const state: RequestState = {
      req,
      snapshot: verified.snapshot,
      verifiedAmount: verified.amount,
      merchantName: verified.merchantName,
      decision,
      result: { status: "pending_user_confirmation" },
    };

    if (decision.type === "deny") {
      await this.audit(requestId, state, decision, "rejected");
      await this.setResult(requestId, state, { status: "rejected", violation: decision.violation });
      await this.emit(policy, {
        kind: "rejected",
        merchant: verified.merchantName,
        amount: verified.amount,
        violation: decision.violation,
      });
      return { requestId };
    }

    if (decision.type === "confirm") {
      await this.saveState(requestId, state); // pending — 감사 미기록(비종단)
      await this.emit(policy, {
        kind: "confirm_required",
        merchant: verified.merchantName,
        amount: verified.amount,
        requestId,
      });
      return { requestId };
    }

    await this.saveState(requestId, state);
    await this.execute(requestId);
    return { requestId };
  }

  /** UI [승인]/[거절] 또는 confirm 타임아웃으로 pending을 해소. */
  async resolveConfirmation(requestId: string, approved: boolean): Promise<void> {
    const state = await this.loadState(requestId);
    if (!state || state.result.status !== "pending_user_confirmation") return;
    if (!approved) {
      await this.audit(requestId, state, state.decision, "canceled");
      await this.setResult(requestId, state, { status: "canceled", reason: "user_declined" });
      return; // 사용자가 직접 거절 — 별도 알림 불필요
    }
    await this.execute(requestId);
  }

  async getPaymentResult(requestId: string): Promise<PaymentResult> {
    const state = await this.loadState(requestId);
    return state?.result ?? { status: "failed", error: "unknown_request" };
  }

  async getPolicySummary(): Promise<PolicySummary> {
    const policy = await this.deps.getPolicy();
    const usage = await this.deps.audit.usageFor(this.now());
    return {
      remainingDailyBudget: Math.max(0, policy.limits.daily - usage.spentToday),
      remainingCountToday: Math.max(0, policy.limits.maxTransactionsPerDay - usage.countToday),
      allowedCategories: policy.categories.mode === "allowlist" ? policy.categories.values : [],
      allowedMerchants: policy.merchants.mode === "allowlist" ? policy.merchants.origins : "any",
      allowedMethods: policy.methods,
    };
  }

  // ── 내부 ──────────────────────────────────
  private async execute(requestId: string): Promise<void> {
    const state = await this.loadState(requestId);
    if (!state) return;
    const policy = await this.deps.getPolicy();
    const adapter = this.deps.adapterFor(state.req.method);

    let identity: { phone: string; birth: string } | undefined;
    if (adapter.hasExternalApproval) {
      const id = await this.deps.refstore.getIdentity();
      if (!id) {
        await this.audit(requestId, state, state.decision, "failed");
        await this.setResult(requestId, state, { status: "failed", error: "no_profile" });
        await this.emit(policy, {
          kind: "failed",
          merchant: state.merchantName,
          amount: state.verifiedAmount,
          error: "no_profile",
        });
        return;
      }
      identity = id;
      await this.emit(policy, {
        kind: "approve_on_phone",
        merchant: state.merchantName,
        amount: state.verifiedAmount,
        method: state.req.method as "kakaopay" | "tosspay",
      });
    }

    const outcome = await adapter.pay({
      tabId: state.req.checkoutTabId,
      identity,
      timeoutMs: this.payTimeoutMs,
      approvedSnapshot: state.snapshot,
    });

    if (outcome.status === "approved") {
      await this.audit(requestId, state, state.decision, "approved", outcome.orderId);
      await this.setResult(requestId, state, {
        status: "approved",
        receipt: {
          amount: outcome.amount,
          merchant: state.merchantName,
          orderId: outcome.orderId,
          at: this.now().toISOString(),
        },
      });
      await this.emit(policy, {
        kind: "completed",
        merchant: state.merchantName,
        amount: outcome.amount,
        orderId: outcome.orderId,
      });
      return;
    }

    if (outcome.status === "canceled") {
      await this.audit(requestId, state, state.decision, "canceled");
      await this.setResult(requestId, state, { status: "canceled", reason: "phone_declined" });
      await this.emit(policy, {
        kind: "failed",
        merchant: state.merchantName,
        amount: state.verifiedAmount,
        error: "canceled",
      });
      return;
    }

    const isTimeout = outcome.status === "timeout";
    await this.audit(requestId, state, state.decision, isTimeout ? "timeout" : "failed");
    await this.setResult(requestId, state, {
      status: "failed",
      error: isTimeout ? "timeout" : outcome.error,
    });
    await this.emit(policy, {
      kind: "failed",
      merchant: state.merchantName,
      amount: state.verifiedAmount,
      error: isTimeout ? "timeout" : outcome.error,
    });
  }

  private async emit(policy: PaymentPolicy, event: NotifyEvent): Promise<void> {
    await this.deps.notify.notify(event, policy.notifications.channels);
  }

  private stateKey(id: string): string {
    return `req:${id}`;
  }
  private async saveState(id: string, state: RequestState): Promise<void> {
    await this.deps.kv.set(this.stateKey(id), state);
  }
  private async loadState(id: string): Promise<RequestState | undefined> {
    return this.deps.kv.get<RequestState>(this.stateKey(id));
  }
  private async setResult(id: string, state: RequestState, result: PaymentResult): Promise<void> {
    state.result = result;
    await this.saveState(id, state);
  }
  private async store(
    id: string,
    state: RequestState | null,
    result: PaymentResult,
  ): Promise<void> {
    if (state) await this.setResult(id, state, result);
    else await this.deps.kv.set(this.stateKey(id), { result } as RequestState);
  }

  /** 종단 결과 1건을 감사에 기록. id=requestId(멱등). 비밀·PII 원문 없음. */
  private async audit(
    requestId: string,
    state: RequestState | null,
    decision: Decision,
    outcome: Terminal | "confirm_required",
    orderId?: string,
  ): Promise<void> {
    await this.deps.audit.append({
      id: requestId,
      at: this.now().toISOString(),
      merchant: state?.req.merchant ?? { origin: "https://unknown.invalid", name: "unknown" },
      amount: state?.verifiedAmount ?? 0,
      method: state?.req.method ?? "coupay",
      decision,
      outcome,
      ...(orderId ? { orderId } : {}),
    });
  }
}
