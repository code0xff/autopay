import type { PaymentMethod, PaymentPolicy, PaymentRequest } from "@autopay/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KvAuditLog } from "../audit/audit-log.js";
import type { PayOutcome, SimplePayAdapter } from "../executor/types.js";
import { BrokerNotifier, type ChannelSender } from "../notify/notifier.js";
import { MemoryKv } from "../platform/kv.js";
import type { RefStore } from "../refstore/refstore.js";
import { BrokerCore } from "./broker-core.js";

const NOW = new Date("2026-09-02T12:00:00+09:00");

const basePolicy = (over: Partial<PaymentPolicy> = {}): PaymentPolicy => ({
  limits: {
    perTransaction: 500_000,
    daily: 1_000_000,
    monthly: 3_000_000,
    maxTransactionsPerDay: 10,
  },
  merchants: { mode: "any", origins: [] },
  categories: { mode: "denylist", values: [] },
  methods: ["coupay", "kakaopay", "tosspay"],
  confirmation: { requireUserConfirmationAbove: 1_000_000, alwaysConfirm: false },
  notifications: { channels: ["chrome"], notifyOnRejection: true },
  ...over,
});

const validReq: PaymentRequest = {
  merchant: { origin: "https://coupang.com", name: "쿠팡" },
  items: [{ title: "USB 허브", category: "hub", quantity: 1, unitPrice: 20_000 }],
  totalAmount: 20_000,
  currency: "KRW",
  method: "coupay",
  checkoutTabId: 1,
};

function fakeAdapter(opts: {
  method: PaymentMethod;
  hasExternalApproval: boolean;
  amount?: number;
  outcome?: PayOutcome;
}): SimplePayAdapter {
  const amount = opts.amount ?? 20_000;
  return {
    method: opts.method,
    hasExternalApproval: opts.hasExternalApproval,
    verify: vi.fn(async () => ({ amount, merchantName: "쿠팡", snapshot: "snap-1" })),
    pay: vi.fn(
      async (): Promise<PayOutcome> =>
        opts.outcome ?? { status: "approved", orderId: "#8842", amount },
    ),
  };
}

function fakeRefStore(identity: { phone: string; birth: string } | null): RefStore {
  return {
    setProfile: vi.fn(async () => {}),
    getIdentity: vi.fn(async () => identity),
    hasProfile: vi.fn(async () => identity !== null),
    setBillingRef: vi.fn(async () => {}),
    getBillingRef: vi.fn(async () => null),
  };
}

function setup(opts: {
  policy?: PaymentPolicy;
  adapters?: Partial<Record<PaymentMethod, SimplePayAdapter>>;
  identity?: { phone: string; birth: string } | null;
}) {
  const kv = new MemoryKv();
  const audit = new KvAuditLog(new MemoryKv());
  const chrome = vi.fn<ChannelSender>(async () => {});
  const notify = new BrokerNotifier({ senders: { chrome }, notifyOnRejection: true });
  const adapters = opts.adapters ?? {
    coupay: fakeAdapter({ method: "coupay", hasExternalApproval: false }),
  };
  let seq = 0;
  const broker = new BrokerCore({
    getPolicy: async () => opts.policy ?? basePolicy(),
    adapterFor: (m) => {
      const a = adapters[m];
      if (!a) throw new Error(`no adapter ${m}`);
      return a;
    },
    audit,
    notify,
    refstore: fakeRefStore(opts.identity ?? null),
    kv,
    now: () => NOW,
    idgen: () => `id-${++seq}`,
    payTimeoutMs: 1000,
  });
  return { broker, audit, chrome, adapters };
}

describe("BrokerCore", () => {
  it("1. 잘못된 요청(스키마 위반) → failed(invalid_request)", async () => {
    const { broker } = setup({});
    const { requestId } = await broker.requestPayment({ bogus: true });
    expect(await broker.getPaymentResult(requestId)).toEqual({
      status: "failed",
      error: "invalid_request",
    });
  });

  it("2. deny(over_per_transaction) → rejected + notify(rejected)", async () => {
    const { broker, chrome } = setup({
      policy: basePolicy({
        limits: {
          perTransaction: 10_000,
          daily: 1_000_000,
          monthly: 3_000_000,
          maxTransactionsPerDay: 10,
        },
      }),
    });
    const { requestId } = await broker.requestPayment(validReq);
    expect(await broker.getPaymentResult(requestId)).toEqual({
      status: "rejected",
      violation: "over_per_transaction",
    });
    expect(chrome).toHaveBeenCalled();
  });

  it("3. confirm → pending → resolveConfirmation(true) → approved", async () => {
    const { broker } = setup({
      policy: basePolicy({
        confirmation: { requireUserConfirmationAbove: 10_000, alwaysConfirm: false },
      }),
    });
    const { requestId } = await broker.requestPayment(validReq);
    expect((await broker.getPaymentResult(requestId)).status).toBe("pending_user_confirmation");
    await broker.resolveConfirmation(requestId, true);
    expect((await broker.getPaymentResult(requestId)).status).toBe("approved");
  });

  it("4. confirm → resolveConfirmation(false) → canceled(user_declined)", async () => {
    const { broker } = setup({
      policy: basePolicy({
        confirmation: { requireUserConfirmationAbove: 10_000, alwaysConfirm: false },
      }),
    });
    const { requestId } = await broker.requestPayment(validReq);
    await broker.resolveConfirmation(requestId, false);
    expect(await broker.getPaymentResult(requestId)).toEqual({
      status: "canceled",
      reason: "user_declined",
    });
  });

  it("5. allow(쿠팡) → approved + audit + usage 증가", async () => {
    const { broker, audit } = setup({});
    const { requestId } = await broker.requestPayment(validReq);
    const result = await broker.getPaymentResult(requestId);
    expect(result.status).toBe("approved");
    if (result.status === "approved") expect(result.receipt.orderId).toBe("#8842");
    const usage = await audit.usageFor(NOW);
    expect(usage.spentToday).toBe(20_000);
    expect(usage.countToday).toBe(1);
  });

  it("6. executor timeout → failed(timeout)", async () => {
    const { broker } = setup({
      adapters: {
        coupay: fakeAdapter({
          method: "coupay",
          hasExternalApproval: false,
          outcome: { status: "timeout" },
        }),
      },
    });
    const { requestId } = await broker.requestPayment(validReq);
    expect(await broker.getPaymentResult(requestId)).toEqual({
      status: "failed",
      error: "timeout",
    });
  });

  it("7. executor canceled(TOCTOU/폰 거절) → canceled(phone_declined)", async () => {
    const { broker } = setup({
      adapters: {
        coupay: fakeAdapter({
          method: "coupay",
          hasExternalApproval: false,
          outcome: { status: "canceled" },
        }),
      },
    });
    const { requestId } = await broker.requestPayment(validReq);
    expect(await broker.getPaymentResult(requestId)).toEqual({
      status: "canceled",
      reason: "phone_declined",
    });
  });

  it("8. 패턴 B(kakaopay) 프로필 없음 → failed(no_profile)", async () => {
    const { broker } = setup({
      adapters: { kakaopay: fakeAdapter({ method: "kakaopay", hasExternalApproval: true }) },
      identity: null,
    });
    const { requestId } = await broker.requestPayment({ ...validReq, method: "kakaopay" });
    expect(await broker.getPaymentResult(requestId)).toEqual({
      status: "failed",
      error: "no_profile",
    });
  });

  it("9. 패턴 B(kakaopay) 프로필 있음 → approve_on_phone 통지 + approved", async () => {
    const { broker, chrome } = setup({
      adapters: { kakaopay: fakeAdapter({ method: "kakaopay", hasExternalApproval: true }) },
      identity: { phone: "01012345678", birth: "19900101" },
    });
    const { requestId } = await broker.requestPayment({ ...validReq, method: "kakaopay" });
    expect((await broker.getPaymentResult(requestId)).status).toBe("approved");
    const bodies = chrome.mock.calls.map((c) => c[0].body).join(" ");
    expect(bodies).toContain("폰에서");
  });

  it("10. getPolicySummary → coupay 포함, 잔여 예산 반영", async () => {
    const { broker } = setup({});
    const s = await broker.getPolicySummary();
    expect(s.allowedMethods).toContain("coupay");
    expect(s.remainingDailyBudget).toBe(1_000_000);
    expect(s.allowedMerchants).toBe("any");
  });
});
