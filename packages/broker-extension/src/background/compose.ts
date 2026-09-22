import type { AuditRecord, PaymentMethod, PaymentPolicy } from "@autopay/shared";
import { KvAuditLog } from "../audit/audit-log.js";
import { BridgeTools } from "../bridge/bridge-tools.js";
import { ChromeGenericPageBridge } from "../bridge/page-bridge.js";
import { BridgeClient } from "../bridge/ws-client.js";
import { defaultWsFactory } from "../bridge/ws-factory.js";
import { BrokerCore, type PendingConfirmation, type PolicySummary } from "../broker/broker-core.js";
import { createAdapter } from "../executor/adapters.js";
import type { SimplePayAdapter } from "../executor/types.js";
import { BrokerNotifier } from "../notify/notifier.js";
import { ChromeKv } from "../platform/chrome-kv.js";
import { chromeNotificationSender } from "../platform/chrome-notify.js";
import { ChromePageBridge } from "../platform/chrome-page-bridge.js";
import type { Kv } from "../platform/kv.js";
import { WebCryptoRefStore, deriveKey } from "../refstore/refstore.js";
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
const PROFILE_KEY = "refstore:profile"; // refstore 내부 키와 일치(패스프레이즈 검증용)
const BRIDGE_TOKEN_KEY = "bridge:token"; // mcp-server 발급 토큰(스토리지 평문 — 비밀 아님, 로컬 전용 공유키)
const BRIDGE_TAB_KEY = "bridge:tabId"; // 스킬이 open()으로 연 브리지 탭 추적(§3)
const BRIDGE_URL = "ws://127.0.0.1:8765"; // mcp-server 로컬 WS 허브(docs/spec/mcp-integration.md §2)

export interface UiState {
  policy: PaymentPolicy;
  summary: PolicySummary;
  recentAudit: AuditRecord[];
  pending: PendingConfirmation[];
  hasProfile: boolean;
  locked: boolean;
  bridgeConnected: boolean;
  hasBridgeToken: boolean;
}

export class Background {
  private key: CryptoKey | null = null; // 세션 메모리에만 보관(스토리지 밖)
  private readonly kv: Kv;
  private readonly audit: KvAuditLog;
  private readonly refstore: WebCryptoRefStore;
  private readonly broker: BrokerCore;
  private readonly deps_adapter: (m: PaymentMethod) => SimplePayAdapter;
  private readonly bridgeTools: BridgeTools;
  private readonly bridgeClient: BridgeClient;
  private bridgeConnected = false;

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
    this.deps_adapter = (m: PaymentMethod): SimplePayAdapter => {
      let a = adapters.get(m);
      if (!a) {
        a = createAdapter(m, bridge);
        adapters.set(m, a);
      }
      return a;
    };
    this.broker = new BrokerCore({
      getPolicy: () => this.getPolicy(),
      adapterFor: this.deps_adapter,
      audit: this.audit,
      notify,
      refstore: this.refstore,
      kv,
    });
    // MCP 브리지(M2, docs/spec/mcp-integration.md) — 스킬은 이 표면(§3) 밖으로
    // 나가지 못한다. broker/pageBridge는 여기서만 노출된다.
    this.bridgeTools = new BridgeTools({
      pageBridge: new ChromeGenericPageBridge(),
      broker: this.broker,
      getBridgeTabId: async () => (await this.kv.get<number>(BRIDGE_TAB_KEY)) ?? null,
      setBridgeTabId: async (tabId) => {
        await this.kv.set(BRIDGE_TAB_KEY, tabId);
      },
    });
    this.bridgeClient = new BridgeClient({
      url: BRIDGE_URL,
      token: "", // connectBridge()가 저장된 토큰으로 채운 뒤 connect()
      onCall: (call) => this.bridgeTools.handle(call),
      wsFactory: defaultWsFactory,
      onStatusChange: (connected) => {
        this.bridgeConnected = connected;
      },
    });
  }

  get brokerCore(): BrokerCore {
    return this.broker;
  }

  get isBridgeConnected(): boolean {
    return this.bridgeConnected;
  }

  /** 저장된 브리지 토큰이 있으면 mcp-server 허브에 접속 시도(부팅 시 1회, 토큰 변경 시). */
  async connectBridge(): Promise<void> {
    const token = await this.kv.get<string>(BRIDGE_TOKEN_KEY);
    if (!token) return;
    this.bridgeClient.setToken(token);
    this.bridgeClient.connect();
  }

  async getPolicy(): Promise<PaymentPolicy> {
    return (await this.kv.get<PaymentPolicy>(POLICY_KEY)) ?? DEFAULT_POLICY;
  }

  /** UI RPC 처리. 반환값은 요청별 상이(직렬화 가능 객체). */
  // RPC를 워커 내에서 직렬 처리(동시 read-modify-write 경쟁 완화).
  private queue: Promise<unknown> = Promise.resolve();
  async handle(raw: unknown): Promise<unknown> {
    const run = this.queue.then(() => this.dispatch(raw));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async dispatch(raw: unknown): Promise<unknown> {
    const parsed = RpcRequest.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "invalid_request" };
    const req = parsed.data;
    switch (req.type) {
      case "getState":
        return this.state();
      case "setPolicy":
        await this.kv.set(POLICY_KEY, req.policy);
        return { ok: true };
      case "unlock": {
        const key = await deriveKey(req.passphrase, await this.salt());
        // 기존 프로필이 있으면 복호화로 패스프레이즈를 검증(오입력 시 unlock 거부
        // → 기존 PII 덮어쓰기 방지).
        if ((await this.kv.get(PROFILE_KEY)) !== undefined) {
          const probe = new WebCryptoRefStore(this.kv, async () => key);
          try {
            await probe.getIdentity();
          } catch {
            return { ok: false, error: "wrong_passphrase" };
          }
        }
        this.key = key;
        return { ok: true };
      }
      case "setProfile":
        await this.refstore.setProfile(req.identity);
        return { ok: true };
      case "resolveConfirmation":
        await this.broker.resolveConfirmation(req.requestId, req.approved);
        return { ok: true };
      case "payActiveTab":
        return this.payActiveTab(req.method);
      case "setBridgeToken":
        await this.kv.set(BRIDGE_TOKEN_KEY, req.token);
        await this.connectBridge();
        return { ok: true };
    }
  }

  /** 현재 활성 탭(체크아웃 화면)에서 수동 결제 요청. 에이전트 없이 실사용 진입점.
   *  탭에서 금액·origin을 파싱해 요청을 구성 → 정책 게이트 → (패턴 C) 확인 대기. */
  private async payActiveTab(method: PaymentMethod): Promise<unknown> {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) return { ok: false, error: "no_active_tab" };
    let origin: string;
    try {
      origin = new URL(tab.url).origin;
    } catch {
      return { ok: false, error: "bad_tab_url" };
    }
    // 탭에서 실제 금액을 먼저 파싱(요청 totalAmount 구성용). 실패 시 중단.
    const verified = await this.deps_adapter(method).verify(tab.id);
    if (!Number.isFinite(verified.amount)) return { ok: false, error: "amount_parse_failed" };
    const { requestId } = await this.broker.requestPayment({
      merchant: { origin, name: verified.merchantName || origin },
      items: [{ title: "수동 결제", quantity: 1, unitPrice: verified.amount }],
      totalAmount: verified.amount,
      currency: "KRW",
      method,
      checkoutTabId: tab.id,
    });
    return { ok: true, requestId };
  }

  private async state(): Promise<UiState> {
    return {
      policy: await this.getPolicy(),
      summary: await this.broker.getPolicySummary(),
      recentAudit: await this.audit.list({ limit: 20 }),
      pending: await this.broker.listPending(),
      hasProfile: await this.safeHasProfile(),
      locked: this.key === null,
      bridgeConnected: this.bridgeConnected,
      hasBridgeToken: (await this.kv.get<string>(BRIDGE_TOKEN_KEY)) !== undefined,
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
}
