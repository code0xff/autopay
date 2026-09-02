import type { AuditRecord, PaymentMethod, PaymentPolicy } from "@autopay/shared";
import { KvAuditLog } from "../audit/audit-log.js";
import { BrokerCore, type PendingConfirmation, type PolicySummary } from "../broker/broker-core.js";
import { createAdapter } from "../executor/adapters.js";
import type { SimplePayAdapter } from "../executor/types.js";
import { BrokerNotifier } from "../notify/notifier.js";
import { ChromeKv } from "../platform/chrome-kv.js";
import { chromeNotificationSender } from "../platform/chrome-notify.js";
import { ChromePageBridge } from "../platform/chrome-page-bridge.js";
import type { Kv } from "../platform/kv.js";
import { WebCryptoRefStore, deriveKey } from "../refstore/refstore.js";
import { type Observed, WatchEngine, type WatchSpec } from "../watch/watch-engine.js";
import { RpcRequest } from "./rpc.js";

// 합성 루트 — 코어 모듈을 chrome 어댑터로 조립하고 UI RPC를 처리한다.
// 기본 정책은 가장 제한적(coding-guide: 기본값 deny 지향).

const DEFAULT_POLICY: PaymentPolicy = {
  limits: { perTransaction: 0, daily: 0, monthly: 0, maxTransactionsPerDay: 0 },
  merchants: { mode: "allowlist", origins: [] },
  categories: { mode: "allowlist", values: [] },
  methods: ["coupay"],
  confirmation: { requireUserConfirmationAbove: 0, alwaysConfirm: true },
  notifications: { channels: ["chrome"], notifyOnRejection: true },
};

const POLICY_KEY = "policy";
const SALT_KEY = "refstore:salt";

export interface UiState {
  policy: PaymentPolicy;
  summary: PolicySummary;
  watches: WatchSpec[];
  recentAudit: AuditRecord[];
  pending: PendingConfirmation[];
  hasProfile: boolean;
  locked: boolean;
}

export class Background {
  private key: CryptoKey | null = null; // 세션 메모리에만 보관(스토리지 밖)
  private readonly kv: Kv;
  private readonly audit: KvAuditLog;
  private readonly refstore: WebCryptoRefStore;
  private readonly broker: BrokerCore;
  private readonly watches: WatchEngine;

  constructor(kv: Kv = new ChromeKv()) {
    this.kv = kv;
    this.audit = new KvAuditLog(kv);
    this.refstore = new WebCryptoRefStore(kv, async () => this.requireKey());
    const notify = new BrokerNotifier({
      senders: { chrome: chromeNotificationSender },
      notifyOnRejection: true,
    });
    const bridge = new ChromePageBridge();
    const adapters = new Map<PaymentMethod, SimplePayAdapter>();
    const adapterFor = (m: PaymentMethod): SimplePayAdapter => {
      let a = adapters.get(m);
      if (!a) {
        a = createAdapter(m, bridge);
        adapters.set(m, a);
      }
      return a;
    };
    this.broker = new BrokerCore({
      getPolicy: () => this.getPolicy(),
      adapterFor,
      audit: this.audit,
      notify,
      refstore: this.refstore,
      kv,
    });
    this.watches = new WatchEngine(kv, this.priceReader(), (w) => this.onConditionMet(w));
  }

  get brokerCore(): BrokerCore {
    return this.broker;
  }
  get watchEngine(): WatchEngine {
    return this.watches;
  }

  async getPolicy(): Promise<PaymentPolicy> {
    return (await this.kv.get<PaymentPolicy>(POLICY_KEY)) ?? DEFAULT_POLICY;
  }

  /** UI RPC 처리. 반환값은 요청별 상이(직렬화 가능 객체). */
  async handle(raw: unknown): Promise<unknown> {
    const parsed = RpcRequest.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "invalid_request" };
    const req = parsed.data;
    switch (req.type) {
      case "getState":
        return this.state();
      case "setPolicy":
        await this.kv.set(POLICY_KEY, req.policy);
        return { ok: true };
      case "unlock":
        this.key = await deriveKey(req.passphrase, await this.salt());
        return { ok: true };
      case "setProfile":
        await this.refstore.setProfile(req.identity);
        return { ok: true };
      case "addWatch":
        await this.watches.add({ ...req.spec });
        return { ok: true };
      case "removeWatch":
        await this.watches.remove(req.id);
        return { ok: true };
      case "pauseWatch":
        await this.watches.pause(req.id, req.paused);
        return { ok: true };
      case "resolveConfirmation":
        await this.broker.resolveConfirmation(req.requestId, req.approved);
        return { ok: true };
    }
  }

  private async state(): Promise<UiState> {
    return {
      policy: await this.getPolicy(),
      summary: await this.broker.getPolicySummary(),
      watches: await this.watches.list(),
      recentAudit: await this.audit.list({ limit: 20 }),
      pending: await this.broker.listPending(),
      hasProfile: await this.safeHasProfile(),
      locked: this.key === null,
    };
  }

  private async safeHasProfile(): Promise<boolean> {
    try {
      return await this.refstore.hasProfile();
    } catch {
      return false;
    }
  }

  private requireKey(): CryptoKey {
    if (!this.key) throw new Error("locked");
    return this.key;
  }

  private async salt(): Promise<Uint8Array> {
    const stored = await this.kv.get<number[]>(SALT_KEY);
    if (stored) return new Uint8Array(stored);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    await this.kv.set(SALT_KEY, [...salt]);
    return salt;
  }

  private priceReader() {
    // "손"으로 상품 페이지의 가격/재고를 파싱. MVP는 미구현 셀렉터 → 보수적 미충족.
    return {
      read: async (_productRef: string): Promise<Observed> => ({
        price: Number.POSITIVE_INFINITY,
        inStock: false,
        freeShipping: false,
      }),
    };
  }

  private async onConditionMet(watch: WatchSpec): Promise<boolean> {
    // 조건 충족 → 상품 페이지를 열고 사용자에게 알림. 실제 구매는 에이전트가
    // 체크아웃까지 진행 후 requestPayment로 이어감(M2). 여기서는 트리거만.
    try {
      await chrome.tabs.create({ url: watch.productRef, active: false });
      await chromeNotificationSender(
        { title: "지정가 조건 충족", body: `${watch.title} — 구매를 검토하세요` },
        {
          kind: "confirm_required",
          merchant: watch.title,
          amount: watch.maxPrice,
          requestId: watch.id,
        },
      );
    } catch {
      // 무시
    }
    return false; // 구매 완료 아님 — watching 유지
  }
}
