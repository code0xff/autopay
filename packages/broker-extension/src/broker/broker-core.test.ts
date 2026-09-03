import type { PaymentMethod, PaymentPolicy, PaymentRequest } from "@autopay/shared";
import { describe, expect, it, vi } from "vitest";
import { KvAuditLog } from "../audit/audit-log.js";
import type { PayOutcome, SimplePayAdapter } from "../executor/types.js";
import { BrokerNotifier, type ChannelSender } from "../notify/notifier.js";
import { MemoryKv } from "../platform/kv.js";
import type { RefStore } from "../refstore/refstore.js";
import { BrokerCore } from "./broker-core.js";

const NOW = new Date("2026-09-02T12:00:00+09:00");
const ORIGIN = "https://coupang.com";

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
  merchant: { origin: ORIGIN, name: "쿠팡" },
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
  origin?: string;
  outcome?: PayOutcome;
}): SimplePayAdapter {
  const amount = opts.amount ?? 20_000;
  return {
    method: opts.method,
    hasExternalApproval: opts.hasExternalApproval,
    verify: vi.fn(async () => ({
      amount,
      merchantName: "쿠팡",
      origin: opts.origin ?? ORIGIN,
      snapshot: "snap-1",
    })),
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
    kv: new MemoryKv(),
    now: () => NOW,
    idgen: () => `id-${++seq}`,
    payTimeoutMs: 1000,
  });
  return { broker, audit, chrome };
}

const kakaoAdapters = (outcome?: PayOutcome) => ({
  kakaopay: fakeAdapter({ method: "kakaopay", hasExternalApproval: true, outcome }),
});

describe("BrokerCore", () => {
  it("1. 스키마 위반 → failed(invalid_request), 결제 시도 아님", async () => {
    const { broker } = setup({});
    const { requestId } = await broker.requestPayment({ bogus: true });
    expect(await broker.getPaymentResult(requestId)).toEqual({
      status: "failed",
      error: "invalid_request",
    });
  });

  it("2. deny(over_per_transaction) → rejected + notify", async () => {
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

  it("3. 패턴 C(쿠팡) allow → 우리 확인 게이트 강제(pending) → 승인 시 approved", async () => {
    const { broker, audit } = setup({});
    const { requestId } = await broker.requestPayment(validReq);
    expect((await broker.getPaymentResult(requestId)).status).toBe("pending_user_confirmation");
    await broker.resolveConfirmation(requestId, true);
    expect((await broker.getPaymentResult(requestId)).status).toBe("approved");
    expect((await audit.usageFor(NOW)).spentToday).toBe(20_000);
  });

  it("4. confirm 거절 → canceled(user_declined)", async () => {
    const { broker } = setup({});
    const { requestId } = await broker.requestPayment(validReq);
    await broker.resolveConfirmation(requestId, false);
    expect(await broker.getPaymentResult(requestId)).toEqual({
      status: "canceled",
      reason: "user_declined",
    });
  });

  it("5. origin 불일치(탭 바꿔치기) → rejected(merchant_not_allowed)", async () => {
    const { broker } = setup({
      adapters: {
        coupay: fakeAdapter({
          method: "coupay",
          hasExternalApproval: false,
          origin: "https://evil.example",
        }),
      },
    });
    const { requestId } = await broker.requestPayment(validReq);
    expect(await broker.getPaymentResult(requestId)).toEqual({
      status: "rejected",
      violation: "merchant_not_allowed",
    });
  });

  it("6. 패턴 B(kakaopay)+프로필 allow → approve_on_phone + approved", async () => {
    const { broker, chrome } = setup({
      adapters: kakaoAdapters(),
      identity: { phone: "01012345678", birth: "19900101" },
    });
    const { requestId } = await broker.requestPayment({ ...validReq, method: "kakaopay" });
    expect((await broker.getPaymentResult(requestId)).status).toBe("approved");
    const bodies = chrome.mock.calls.map((c) => c[0].body).join(" ");
    expect(bodies).toContain("폰에서");
  });

  it("7. 패턴 B 프로필 없음 → failed(no_profile)", async () => {
    const { broker } = setup({ adapters: kakaoAdapters(), identity: null });
    const { requestId } = await broker.requestPayment({ ...validReq, method: "kakaopay" });
    expect(await broker.getPaymentResult(requestId)).toEqual({
      status: "failed",
      error: "no_profile",
    });
  });

  it("8. executor timeout → failed(timeout)", async () => {
    const { broker } = setup({
      adapters: kakaoAdapters({ status: "timeout" }),
      identity: { phone: "01012345678", birth: "19900101" },
    });
    const { requestId } = await broker.requestPayment({ ...validReq, method: "kakaopay" });
    expect(await broker.getPaymentResult(requestId)).toEqual({
      status: "failed",
      error: "timeout",
    });
  });

  it("9. executor canceled(폰 거절) → canceled(phone_declined)", async () => {
    const { broker } = setup({
      adapters: kakaoAdapters({ status: "canceled", reason: "user" }),
      identity: { phone: "01012345678", birth: "19900101" },
    });
    const { requestId } = await broker.requestPayment({ ...validReq, method: "kakaopay" });
    expect(await broker.getPaymentResult(requestId)).toEqual({
      status: "canceled",
      reason: "phone_declined",
    });
  });

  it("10. TOCTOU: executor canceled(content_changed) → canceled(content_changed)", async () => {
    const { broker } = setup({
      adapters: kakaoAdapters({ status: "canceled", reason: "content_changed" }),
      identity: { phone: "01012345678", birth: "19900101" },
    });
    const { requestId } = await broker.requestPayment({ ...validReq, method: "kakaopay" });
    expect(await broker.getPaymentResult(requestId)).toEqual({
      status: "canceled",
      reason: "content_changed",
    });
  });

  it("11. getPolicySummary → coupay 포함, 잔여 예산", async () => {
    const { broker } = setup({});
    const s = await broker.getPolicySummary();
    expect(s.allowedMethods).toContain("coupay");
    expect(s.remainingDailyBudget).toBe(1_000_000);
    expect(s.allowedMerchants).toBe("any");
  });

  it("12. confirm → listPending 항목, 해소 후 비워짐", async () => {
    const { broker } = setup({});
    const { requestId } = await broker.requestPayment(validReq);
    const pending = await broker.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ requestId, merchant: "쿠팡", amount: 20_000 });
    await broker.resolveConfirmation(requestId, true);
    expect(await broker.listPending()).toHaveLength(0);
  });

  it("14. confirm 타임아웃 → canceled(confirm_timeout), pending 제거", async () => {
    const { broker } = setup({});
    const { requestId } = await broker.requestPayment(validReq);
    expect((await broker.getPaymentResult(requestId)).status).toBe("pending_user_confirmation");
    await broker.expireStaleConfirmations(0); // ttl 0 → 즉시 만료
    expect(await broker.getPaymentResult(requestId)).toEqual({
      status: "canceled",
      reason: "confirm_timeout",
    });
    expect(await broker.listPending()).toHaveLength(0);
  });

  it("15. [High] confirm 후 한도 소진 → 실행 직전 재평가로 rejected(over_daily)", async () => {
    const { broker, audit } = setup({
      policy: basePolicy({
        limits: {
          perTransaction: 50_000,
          daily: 30_000,
          monthly: 3_000_000,
          maxTransactionsPerDay: 10,
        },
        confirmation: { requireUserConfirmationAbove: 10_000, alwaysConfirm: false },
      }),
    });
    const { requestId } = await broker.requestPayment(validReq); // 20,000 → confirm(pending)
    expect((await broker.getPaymentResult(requestId)).status).toBe("pending_user_confirmation");
    // confirm 대기 사이 다른 결제로 오늘 사용액이 20,000 소진됨
    await audit.append({
      id: "other",
      at: NOW.toISOString(),
      merchant: { origin: ORIGIN, name: "쿠팡" },
      amount: 20_000,
      method: "coupay",
      decision: { type: "allow" },
      outcome: "approved",
    });
    await broker.resolveConfirmation(requestId, true); // 20k+20k=40k > daily 30k
    expect(await broker.getPaymentResult(requestId)).toEqual({
      status: "rejected",
      violation: "over_daily",
    });
  });

  it("16. [High] 워커 재시작(다른 인스턴스, 저장소 공유) 중복 실행 방지", async () => {
    const kv = new MemoryKv();
    const audit = new KvAuditLog(new MemoryKv());
    let release!: () => void;
    const hang = new Promise<void>((r) => {
      release = r;
    });
    const pay1 = vi.fn(async (): Promise<PayOutcome> => {
      await hang; // 워커1의 결제가 진행 중(미완)인 상태를 흉내
      return { status: "approved", orderId: "#1", amount: 20_000 };
    });
    const pay2 = vi.fn(
      async (): Promise<PayOutcome> => ({ status: "approved", orderId: "#2", amount: 20_000 }),
    );
    const mk = (pay: typeof pay1) => {
      const a: SimplePayAdapter = {
        method: "coupay",
        hasExternalApproval: false,
        verify: vi.fn(async () => ({
          amount: 20_000,
          merchantName: "쿠팡",
          origin: ORIGIN,
          snapshot: "s",
        })),
        pay,
      };
      return new BrokerCore({
        getPolicy: async () => basePolicy(),
        adapterFor: () => a,
        audit,
        notify: new BrokerNotifier({ senders: {}, notifyOnRejection: true }),
        refstore: fakeRefStore(null),
        kv, // 저장소 공유 = 같은 요청 상태를 두 인스턴스가 봄
        now: () => NOW,
        idgen: () => "shared-1",
        payTimeoutMs: 1000,
      });
    };
    const worker1 = mk(pay1);
    const worker2 = mk(pay2);

    const { requestId } = await worker1.requestPayment(validReq); // coupay → confirm(pending)
    const p1 = worker1.resolveConfirmation(requestId, true); // executing=true 저장 후 pay1(hang)
    await new Promise((r) => setTimeout(r, 0)); // executing 저장 완료 대기
    await worker2.resolveConfirmation(requestId, true); // 재시작된 워커가 재실행 시도

    expect(pay2).not.toHaveBeenCalled(); // 두 번째 결제는 일어나지 않음
    release();
    await p1;
    expect(pay1).toHaveBeenCalledTimes(1);
  });

  it("13. notifyOnRejection=false → 거절 알림 미발송", async () => {
    const { broker, chrome } = setup({
      policy: basePolicy({
        limits: {
          perTransaction: 10_000,
          daily: 1_000_000,
          monthly: 3_000_000,
          maxTransactionsPerDay: 10,
        },
        notifications: { channels: ["chrome"], notifyOnRejection: false },
      }),
    });
    await broker.requestPayment(validReq);
    expect(chrome).not.toHaveBeenCalled();
  });
});
