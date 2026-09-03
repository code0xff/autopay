import type {
  Decision,
  PaymentMethod,
  PaymentPolicy,
  PaymentRequest,
  PaymentResult,
  PolicyViolation,
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

export interface PendingConfirmation {
  requestId: string;
  merchant: string;
  amount: number;
  method: PaymentMethod;
  at: string; // ISO8601 — confirm 생성 시각(타임아웃 판정용)
}

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
  executing?: boolean; // 영속 idempotency — 워커 재시작 후 중복 실행 방지
}

export class BrokerCore {
  private readonly now: () => Date;
  private readonly idgen: () => string;
  private readonly payTimeoutMs: number;
  private readonly inFlight = new Set<string>(); // 같은 워커 내 중복 실행 방지

  constructor(private readonly deps: BrokerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.idgen = deps.idgen ?? (() => crypto.randomUUID());
    this.payTimeoutMs = deps.payTimeoutMs ?? 180_000;
  }

  async requestPayment(input: unknown): Promise<{ requestId: string }> {
    const requestId = this.idgen();
    try {
      return await this.doRequestPayment(requestId, input);
    } catch {
      // 어떤 예외든 종단 실패로 수렴(fail-closed, coding-guide §5).
      await this.store(requestId, null, { status: "failed", error: "internal_error" });
      return { requestId };
    }
  }

  private async doRequestPayment(
    requestId: string,
    input: unknown,
  ): Promise<{ requestId: string }> {
    // 1. 경계 검증 — 스키마 실패면 신뢰 영역 진입 금지(fail-closed). 결제 시도가
    //    아니므로 감사에 기록하지 않고 실패만 반환.
    const parsed = PaymentRequestSchema.safeParse(input);
    if (!parsed.success) {
      await this.store(requestId, null, { status: "failed", error: "invalid_request" });
      return { requestId };
    }
    const req = parsed.data;
    const policy = await this.deps.getPolicy();
    const adapter = this.deps.adapterFor(req.method);

    // 3. 실제 금액·origin 독립 파싱 + 스냅샷
    const verified = await adapter.verify(req.checkoutTabId);

    // 금액 파싱 실패(NaN/비유한) → 결제 시도 아님. audit에 NaN 유입 방지.
    if (!Number.isFinite(verified.amount)) {
      await this.store(requestId, null, { status: "failed", error: "amount_parse_failed" });
      return { requestId };
    }

    const state: RequestState = {
      req,
      snapshot: verified.snapshot,
      verifiedAmount: verified.amount,
      merchantName: verified.merchantName,
      decision: { type: "allow" },
      result: { status: "pending_user_confirmation" },
    };

    // 2. origin 바인딩 — 실제 결제 탭 origin이 요청 머천트와 다르면 거절.
    //    (탭 바꿔치기·엉뚱한 페이지 방어. AGENTS §2.6/§4)
    if (!sameOrigin(verified.origin, req.merchant.origin)) {
      state.decision = { type: "deny", violation: "merchant_not_allowed" };
      return this.reject(requestId, state, policy, "merchant_not_allowed");
    }

    // 4. 사용량 스냅샷 → 5. 정책 판정
    const usage = await this.deps.audit.usageFor(this.now());
    let decision = evaluate(req, policy, usage, verified.amount);

    // 패턴 C(외부 게이트 없음, 예: 쿠팡 원터치)는 allow라도 우리 확인을 강제한다
    // (AGENTS §2.5). 정책 confirm/deny는 그대로 존중.
    if (decision.type === "allow" && !adapter.hasExternalApproval) {
      decision = { type: "confirm", reason: "always" };
    }
    state.decision = decision;

    if (decision.type === "deny") {
      return this.reject(requestId, state, policy, decision.violation);
    }

    if (decision.type === "confirm") {
      await this.saveState(requestId, state); // pending — 감사 미기록(비종단)
      await this.addPending(requestId, verified.merchantName, verified.amount, req.method);
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

  private async reject(
    requestId: string,
    state: RequestState,
    policy: PaymentPolicy,
    violation: PolicyViolation,
  ): Promise<{ requestId: string }> {
    await this.audit(requestId, state, state.decision, "rejected");
    await this.setResult(requestId, state, { status: "rejected", violation });
    await this.emit(policy, {
      kind: "rejected",
      merchant: state.merchantName,
      amount: state.verifiedAmount,
      violation,
    });
    return { requestId };
  }

  /** UI [승인]/[거절] 또는 confirm 타임아웃으로 pending을 해소. */
  async resolveConfirmation(requestId: string, approved: boolean): Promise<void> {
    const state = await this.loadState(requestId);
    if (!state || state.result.status !== "pending_user_confirmation") return;
    await this.removePending(requestId);
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

  /** confirm 승인 대기 목록(UI 표시용). 비밀 없음 — 금액·가맹점·id만. */
  async listPending(): Promise<PendingConfirmation[]> {
    return (await this.deps.kv.get<PendingConfirmation[]>("pending")) ?? [];
  }

  private async addPending(
    requestId: string,
    merchant: string,
    amount: number,
    method: PaymentMethod,
  ): Promise<void> {
    const list = await this.listPending();
    list.push({ requestId, merchant, amount, method, at: this.now().toISOString() });
    await this.deps.kv.set("pending", list);
  }
  private async removePending(requestId: string): Promise<void> {
    const list = (await this.listPending()).filter((p) => p.requestId !== requestId);
    await this.deps.kv.set("pending", list);
  }

  /** confirm 타임아웃 스윕(spec/broker-api §2.2.1). ttl 초과 pending을
   *  content 무관 취소(confirm_timeout)한다. 배경 알람에서 주기 호출. */
  async expireStaleConfirmations(ttlMs: number): Promise<void> {
    const nowMs = this.now().getTime();
    for (const p of await this.listPending()) {
      if (nowMs - new Date(p.at).getTime() < ttlMs) continue;
      const state = await this.loadState(p.requestId);
      await this.removePending(p.requestId);
      if (!state || state.result.status !== "pending_user_confirmation") continue;
      await this.audit(p.requestId, state, state.decision, "canceled");
      await this.setResult(p.requestId, state, { status: "canceled", reason: "confirm_timeout" });
    }
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
    // 동시/중복 실행 방지: in-flight 가드 + 종단 상태 가드(멱등).
    if (this.inFlight.has(requestId)) return;
    this.inFlight.add(requestId);
    try {
      const state = await this.loadState(requestId);
      if (!state || state.result.status !== "pending_user_confirmation") return;
      // 영속 idempotency: 이미 실행 착수한 요청은 재실행하지 않음(워커 재시작 대비).
      if (state.executing) return;
      state.executing = true;
      await this.saveState(requestId, state);

      const policy = await this.deps.getPolicy();
      const adapter = this.deps.adapterFor(state.req.method);

      // confirm 대기 사이 정책·사용량이 변했을 수 있으므로 실행 직전 재평가.
      const usage = await this.deps.audit.usageFor(this.now());
      const recheck = evaluate(state.req, policy, usage, state.verifiedAmount);
      if (recheck.type === "deny") {
        await this.audit(requestId, state, recheck, "rejected");
        await this.setResult(requestId, state, {
          status: "rejected",
          violation: recheck.violation,
        });
        await this.emit(policy, {
          kind: "rejected",
          merchant: state.merchantName,
          amount: state.verifiedAmount,
          violation: recheck.violation,
        });
        return;
      }

      let identity: { phone: string; birth: string } | undefined;
      if (adapter.hasExternalApproval) {
        let id: { phone: string; birth: string } | null = null;
        try {
          id = await this.deps.refstore.getIdentity();
        } catch {
          id = null; // 잠금/복호화 실패 → 프로필 없음과 동일 처리
        }
        if (!id) {
          await this.fail(requestId, state, policy, "no_profile", "failed");
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
        const reason =
          outcome.reason === "content_changed"
            ? "content_changed"
            : adapter.hasExternalApproval
              ? "phone_declined"
              : "user_declined";
        await this.audit(requestId, state, state.decision, "canceled");
        await this.setResult(requestId, state, { status: "canceled", reason });
        await this.emit(policy, {
          kind: "failed",
          merchant: state.merchantName,
          amount: state.verifiedAmount,
          error: reason,
        });
        return;
      }

      const isTimeout = outcome.status === "timeout";
      await this.fail(
        requestId,
        state,
        policy,
        isTimeout ? "timeout" : outcome.error,
        isTimeout ? "timeout" : "failed",
      );
    } catch {
      // 결제 실행 중 예외 → 종단 실패로 수렴(미결제 상태로 안전 수렴).
      const state = await this.loadState(requestId);
      if (state && state.result.status === "pending_user_confirmation") {
        await this.audit(requestId, state, state.decision, "failed");
        await this.setResult(requestId, state, { status: "failed", error: "internal_error" });
      }
    } finally {
      this.inFlight.delete(requestId);
    }
  }

  private async fail(
    requestId: string,
    state: RequestState,
    policy: PaymentPolicy,
    error: string,
    outcome: "failed" | "timeout",
  ): Promise<void> {
    await this.audit(requestId, state, state.decision, outcome);
    await this.setResult(requestId, state, { status: "failed", error });
    await this.emit(policy, {
      kind: "failed",
      merchant: state.merchantName,
      amount: state.verifiedAmount,
      error,
    });
  }

  private async emit(policy: PaymentPolicy, event: NotifyEvent): Promise<void> {
    // 정책의 notifyOnRejection이 false면 거절 알림은 발송하지 않는다(spec/notify §3).
    if (event.kind === "rejected" && !policy.notifications.notifyOnRejection) return;
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

/** 두 URL의 origin이 같은지. 파싱 실패는 불일치(fail-closed). */
function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}
