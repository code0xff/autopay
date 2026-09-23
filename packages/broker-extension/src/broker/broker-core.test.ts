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
    await broker.idle(); // 실행은 백그라운드 — 완료 대기
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
    await broker.idle(); // 실행은 백그라운드 — 완료 대기
    expect(await broker.getPaymentResult(requestId)).toEqual({
      status: "rejected",
      violation: "over_per_transaction",
    });
    expect(chrome).toHaveBeenCalled();
  });

  it("3. 패턴 C(쿠팡) + 정책이 확인을 요구 → pending → 승인 시 approved", async () => {
    // coupay 전용 하드코딩이 아니라 다른 결제수단과 동일한 정책 규칙(alwaysConfirm)
    // 으로 confirm이 걸림을 검증.
    const { broker, audit } = setup({
      policy: basePolicy({
        confirmation: { requireUserConfirmationAbove: 1_000_000, alwaysConfirm: true },
      }),
    });
    const { requestId } = await broker.requestPayment(validReq);
    await broker.idle(); // 실행은 백그라운드 — 완료 대기
    expect((await broker.getPaymentResult(requestId)).status).toBe("pending_user_confirmation");
    await broker.resolveConfirmation(requestId, true);
    await broker.idle(); // 실행은 백그라운드 — 완료 대기
    expect((await broker.getPaymentResult(requestId)).status).toBe("approved");
    expect((await audit.usageFor(NOW)).spentToday).toBe(20_000);
  });

  it("3b. [2026-09-23] 패턴 C(쿠팡) + 정책이 확인 불필요 → 확인 없이 즉시 approved", async () => {
    // coupay는 더 이상 무조건 confirm을 강제하지 않는다(사용자 결정) — 정책이
    // 허용하면(alwaysConfirm:false + 임계값 이하) 클릭 하나 없이 바로 실행된다.
    const { broker, audit } = setup({
      policy: basePolicy({
        confirmation: { requireUserConfirmationAbove: 1_000_000, alwaysConfirm: false },
      }),
    });
    const { requestId } = await broker.requestPayment(validReq);
    await broker.idle(); // 실행은 백그라운드 — 완료 대기
    expect((await broker.getPaymentResult(requestId)).status).toBe("approved");
    expect((await audit.usageFor(NOW)).spentToday).toBe(20_000);
  });

  it("4. confirm 거절 → canceled(user_declined)", async () => {
    const { broker } = setup({
      policy: basePolicy({
        confirmation: { requireUserConfirmationAbove: 1_000_000, alwaysConfirm: true },
      }),
    });
    const { requestId } = await broker.requestPayment(validReq);
    await broker.idle(); // 실행은 백그라운드 — 완료 대기
    await broker.resolveConfirmation(requestId, false);
    await broker.idle(); // 실행은 백그라운드 — 완료 대기
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
    await broker.idle(); // 실행은 백그라운드 — 완료 대기
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
    await broker.idle(); // 실행은 백그라운드 — 완료 대기
    expect((await broker.getPaymentResult(requestId)).status).toBe("approved");
    const bodies = chrome.mock.calls.map((c) => c[0].body).join(" ");
    expect(bodies).toContain("폰에서");
  });

  it("7. 패턴 B 프로필 없음 → failed(no_profile)", async () => {
    const { broker } = setup({ adapters: kakaoAdapters(), identity: null });
    const { requestId } = await broker.requestPayment({ ...validReq, method: "kakaopay" });
    await broker.idle(); // 실행은 백그라운드 — 완료 대기
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
    await broker.idle(); // 실행은 백그라운드 — 완료 대기
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
    await broker.idle(); // 실행은 백그라운드 — 완료 대기
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
    await broker.idle(); // 실행은 백그라운드 — 완료 대기
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
    const { broker } = setup({
      policy: basePolicy({
        confirmation: { requireUserConfirmationAbove: 1_000_000, alwaysConfirm: true },
      }),
    });
    const { requestId } = await broker.requestPayment(validReq);
    await broker.idle(); // 실행은 백그라운드 — 완료 대기
    const pending = await broker.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ requestId, merchant: "쿠팡", amount: 20_000 });
    await broker.resolveConfirmation(requestId, true);
    await broker.idle(); // 실행은 백그라운드 — 완료 대기
    expect(await broker.listPending()).toHaveLength(0);
  });

  it("14. confirm 타임아웃 → canceled(confirm_timeout), pending 제거", async () => {
    const { broker } = setup({
      policy: basePolicy({
        confirmation: { requireUserConfirmationAbove: 1_000_000, alwaysConfirm: true },
      }),
    });
    const { requestId } = await broker.requestPayment(validReq);
    await broker.idle(); // 실행은 백그라운드 — 완료 대기
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
    await broker.idle(); // 실행은 백그라운드 — 완료 대기
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
    await broker.idle(); // 실행은 백그라운드 — 완료 대기
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
        getPolicy: async () =>
          basePolicy({
            confirmation: { requireUserConfirmationAbove: 1_000_000, alwaysConfirm: true },
          }),
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
    await worker1.idle(); // 실행은 백그라운드 — 완료 대기
    const p1 = worker1.resolveConfirmation(requestId, true); // executing=true 저장 후 pay1(hang)
    await new Promise((r) => setTimeout(r, 0)); // executing 저장 완료 대기
    await worker2.resolveConfirmation(requestId, true); // 재시작된 워커가 재실행 시도
    await worker2.idle(); // 실행은 백그라운드 — 완료 대기

    expect(pay2).not.toHaveBeenCalled(); // 두 번째 결제는 일어나지 않음
    release();
    await p1;
    await worker1.idle();
    expect(pay1).toHaveBeenCalledTimes(1);
  });

  it("17. [High] recoverStaleExecutions — 실행 도중 워커가 죽은 요청을 failed(interrupted)로 안전 수렴, 재시도(중복결제)하지 않음", async () => {
    const kv = new MemoryKv();
    const audit = new KvAuditLog(new MemoryKv());
    let hangRelease!: () => void;
    const hang = new Promise<void>((r) => {
      hangRelease = r;
    });
    const pay = vi.fn(async (): Promise<PayOutcome> => {
      await hang; // 워커1이 실행 도중 죽은 상태를 흉내(영원히 미완)
      return { status: "approved", orderId: "#1", amount: 20_000 };
    });
    const adapter: SimplePayAdapter = {
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
    const mkAt = (now: Date) =>
      new BrokerCore({
        getPolicy: async () =>
          basePolicy({
            confirmation: { requireUserConfirmationAbove: 1_000_000, alwaysConfirm: true },
          }),
        adapterFor: () => adapter,
        audit,
        notify: new BrokerNotifier({ senders: {}, notifyOnRejection: true }),
        refstore: fakeRefStore(null),
        kv,
        now: () => now,
        idgen: () => "shared-1",
        payTimeoutMs: 1000,
      });
    const worker1 = mkAt(NOW);
    const { requestId } = await worker1.requestPayment(validReq); // confirm(pending)
    await worker1.idle(); // 실행은 백그라운드 — 완료 대기
    void worker1.resolveConfirmation(requestId, true); // executing=true 저장 후 pay(hang) — 워커1 "사망"
    await new Promise((r) => setTimeout(r, 0)); // executing 저장 완료 대기

    // 재시작된 워커가 한참 뒤(staleAfterMs 이상 경과) 스윕 실행.
    const worker2 = mkAt(new Date(NOW.getTime() + 5000));
    await worker2.recoverStaleExecutions(1000); // 1초 이상 지났으면 stale로 간주

    expect(await worker2.getPaymentResult(requestId)).toEqual({
      status: "failed",
      error: "interrupted",
    });
    // 재시도(pay 재호출)는 절대 하지 않는다 — 중복 결제 방지가 목적이므로.
    expect(pay).toHaveBeenCalledTimes(1); // 워커1이 최초에 호출한 것 뿐, 재호출 없음
    hangRelease();
  });

  it("18. recoverStaleExecutions — staleAfterMs 미경과면 건드리지 않는다(정상 진행 중 오판 방지)", async () => {
    const kv = new MemoryKv();
    const audit = new KvAuditLog(new MemoryKv());
    const hang = new Promise<void>(() => {}); // 영원히 대기 — 아직 "진행 중"
    const adapter: SimplePayAdapter = {
      method: "coupay",
      hasExternalApproval: false,
      verify: vi.fn(async () => ({
        amount: 20_000,
        merchantName: "쿠팡",
        origin: ORIGIN,
        snapshot: "s",
      })),
      pay: vi.fn(async (): Promise<PayOutcome> => {
        await hang;
        return { status: "approved", orderId: "#1", amount: 20_000 };
      }),
    };
    const mkAt = (now: Date) =>
      new BrokerCore({
        getPolicy: async () =>
          basePolicy({
            confirmation: { requireUserConfirmationAbove: 1_000_000, alwaysConfirm: true },
          }),
        adapterFor: () => adapter,
        audit,
        notify: new BrokerNotifier({ senders: {}, notifyOnRejection: true }),
        refstore: fakeRefStore(null),
        kv,
        now: () => now,
        idgen: () => "shared-2",
        payTimeoutMs: 1000,
      });
    const worker1 = mkAt(NOW);
    const { requestId } = await worker1.requestPayment(validReq);
    await worker1.idle(); // 실행은 백그라운드 — 완료 대기
    void worker1.resolveConfirmation(requestId, true);
    await new Promise((r) => setTimeout(r, 0));

    const worker2 = mkAt(new Date(NOW.getTime() + 500)); // 500ms만 경과
    await worker2.recoverStaleExecutions(1000); // staleAfterMs=1000 > 경과 500ms

    expect(await worker2.getPaymentResult(requestId)).toEqual({
      status: "pending_user_confirmation",
    }); // 아직 손대지 않음
  });

  // executor.md §3.2 — 비번 핸드오프: 통지만 하고 결제는 pending 유지, 실행 중 잠금
  it("19. 비번 핸드오프 → enter_password_on_page 통지 + 실행 중 hasActiveExecution=true → approved", async () => {
    let lockedDuringHandoff: boolean | undefined;
    const adapter = fakeAdapter({ method: "coupay", hasExternalApproval: false });
    const { broker, chrome } = setup({ adapters: { coupay: adapter } });
    adapter.pay = vi.fn(async (input): Promise<PayOutcome> => {
      await input.onPasswordHandoff?.();
      lockedDuringHandoff = await broker.hasActiveExecution();
      return { status: "approved", orderId: "#9001", amount: 20_000 };
    });
    const { requestId } = await broker.requestPayment(validReq);
    await broker.idle(); // 실행은 백그라운드 — 완료 대기
    expect(await broker.getPaymentResult(requestId)).toMatchObject({ status: "approved" });
    expect(lockedDuringHandoff).toBe(true);
    expect(await broker.hasActiveExecution()).toBe(false); // 종료 후 잠금 해제
    const kinds = chrome.mock.calls.map((c) => c[1].kind);
    expect(kinds).toEqual(["enter_password_on_page", "completed"]);
  });

  // 셀프 리뷰(2026-09-23): 실행을 기다리면 MCP 허브 30s 타임아웃에 걸려 에이전트가
  // requestId를 잃는다(비번 핸드오프는 사람 입력만큼 걸림) — 즉시 반환해야 한다.
  it("20. allow 경로도 결제 완료를 기다리지 않고 requestId를 즉시 반환(pending 폴링)", async () => {
    let release!: () => void;
    const hang = new Promise<void>((r) => {
      release = r;
    });
    const adapter = fakeAdapter({ method: "coupay", hasExternalApproval: false });
    adapter.pay = vi.fn(async (): Promise<PayOutcome> => {
      await hang; // 사용자가 비번을 입력하는 중
      return { status: "approved", orderId: "#7", amount: 20_000 };
    });
    const { broker } = setup({ adapters: { coupay: adapter } });
    const { requestId } = await broker.requestPayment(validReq); // hang 중에도 반환돼야 함
    expect((await broker.getPaymentResult(requestId)).status).toBe("pending_user_confirmation");
    release();
    await broker.idle();
    expect((await broker.getPaymentResult(requestId)).status).toBe("approved");
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
    await broker.idle(); // 실행은 백그라운드 — 완료 대기
    expect(chrome).not.toHaveBeenCalled();
  });
});
