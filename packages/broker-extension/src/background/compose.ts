import type { PaymentMethod, PaymentPolicy } from "@autopay/shared";
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
import { type Kv, MemoryKv } from "../platform/kv.js";
import {
  type Sealed,
  WebCryptoRefStore,
  checkVerifier,
  deriveKeyBytes,
  importAesKey,
  makeVerifier,
} from "../refstore/refstore.js";
import { RpcRequest } from "./rpc.js";

// 합성 루트 — 코어 모듈을 chrome 어댑터로 조립하고 UI RPC를 처리한다.
// 기본 정책은 가장 제한적(coding-guide: 기본값 deny 지향) — 단, 머천트·카테고리는
// 예외로 완화한다: 빈 allowlist는 "설치만 하면 아무것도 안 되는" 마찰이 커서
// (2026-09-23 실사용 중 직접 겪음 — 데모하기도 어려움), 지금 실제로 지원되는
// 경로(쿠팡 상품·체크아웃 도메인 + coupay)는 미리 열어두고 카테고리는 통째로
// 허용한다. 한도도 2026-09-23 사용자 결정으로 소액 기본값(건당 2만·일 5만·월 10만·일 3회,
// 1만 원 초과 시 승인)을 둔다.
const DEFAULT_POLICY: PaymentPolicy = {
  limits: { perTransaction: 20_000, daily: 50_000, monthly: 100_000, maxTransactionsPerDay: 3 },
  merchants: {
    mode: "allowlist",
    origins: ["https://coupang.com", "https://www.coupang.com", "https://checkout.coupang.com"],
  },
  categories: { mode: "denylist", values: [] }, // denylist + 빈 값 = 전부 허용
  methods: ["coupay"],
  confirmation: { requireUserConfirmationAbove: 10_000, alwaysConfirm: false },
  notifications: { channels: ["chrome"], notifyOnRejection: true },
};

const POLICY_KEY = "policy";
const SALT_KEY = "refstore:salt";
const PROFILE_KEY = "refstore:profile"; // refstore 내부 키와 일치(패스프레이즈 검증용)
const BRIDGE_TOKEN_KEY = "bridge:token"; // mcp-server 발급 토큰(스토리지 평문 — 비밀 아님, 로컬 전용 공유키)
const BRIDGE_TAB_KEY = "bridge:tabId"; // 스킬이 open()으로 연 브리지 탭 추적(§3)
const VERIFIER_KEY = "lock:verifier"; // 패스프레이즈 검증용 봉인값(평문 비밀 아님)
const SESSION_KEY = "lock:key"; // 잠금 해제 키 원본 — chrome.storage.session(메모리 전용)에만
const BRIDGE_URL = "ws://127.0.0.1:8765"; // mcp-server 로컬 WS 허브(docs/spec/mcp-integration.md §2)

export interface UiState {
  policy: PaymentPolicy;
  summary: PolicySummary;
  pending: PendingConfirmation[];
  hasProfile: boolean;
  locked: boolean;
  hasPassphrase: boolean; // false면 첫 실행 — 잠금 화면이 "패스프레이즈 설정"으로 뜬다
  bridgeConnected: boolean;
  hasBridgeToken: boolean;
}

export class Background {
  // 잠금 해제 키. 잠겨 있으면 AutoPay는 비활성 — UI는 잠금 화면만, 브리지 도구는 전부 거부.
  // 서비스워커가 재시작돼도 브라우저를 닫기 전까진 풀린 상태를 유지하도록 키 원본을
  // chrome.storage.session(디스크에 쓰지 않는 메모리 저장소)에 둔다.
  private key: CryptoKey | null = null;
  private readonly kv: Kv;
  private readonly session: Kv;
  private readonly audit: KvAuditLog;
  private readonly refstore: WebCryptoRefStore;
  private readonly broker: BrokerCore;
  private readonly deps_adapter: (m: PaymentMethod) => SimplePayAdapter;
  private readonly bridgeTools: BridgeTools;
  private readonly bridgeClient: BridgeClient;
  private bridgeConnected = false;

  constructor(kv: Kv = new ChromeKv(), session?: Kv) {
    this.kv = kv;
    this.session = session ?? defaultSessionKv();
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
      isLocked: async () => !(await this.restoreKey()),
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
    // 잠겨 있으면 상태 조회와 잠금 해제만 허용 — 정책 변경·승인·설정은 해제 후에.
    const unlocked = await this.restoreKey();
    if (!unlocked && req.type !== "getState" && req.type !== "unlock") {
      return { ok: false, error: "locked" };
    }
    switch (req.type) {
      case "getState":
        return this.state();
      case "setPolicy":
        await this.kv.set(POLICY_KEY, req.policy);
        return { ok: true };
      case "unlock":
        return this.unlock(req.passphrase);
      case "lock":
        this.key = null;
        await this.session.set(SESSION_KEY, null);
        return { ok: true };
      case "getAudit":
        return this.audit.page({ offset: req.offset, limit: req.limit });
      case "setProfile":
        await this.refstore.setProfile(req.identity);
        return { ok: true };
      case "resolveConfirmation":
        await this.broker.resolveConfirmation(req.requestId, req.approved);
        return { ok: true };
      case "setBridgeToken":
        await this.kv.set(BRIDGE_TOKEN_KEY, req.token);
        await this.connectBridge();
        return { ok: true };
    }
  }

  private async state(): Promise<UiState> {
    return {
      policy: await this.getPolicy(),
      summary: await this.broker.getPolicySummary(),
      pending: await this.broker.listPending(),
      hasProfile: await this.safeHasProfile(),
      locked: !(await this.restoreKey()),
      hasPassphrase:
        (await this.kv.get(VERIFIER_KEY)) !== undefined ||
        (await this.kv.get(PROFILE_KEY)) !== undefined,
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

  /** 패스프레이즈 검증 후 잠금 해제. 검증값이 없으면 첫 실행(=설정)으로 보고 만든다.
   *  검증값 도입 전 설치본은 저장된 프로필 복호화로 검증한 뒤 검증값을 만든다. */
  private async unlock(passphrase: string): Promise<unknown> {
    const raw = await deriveKeyBytes(passphrase, await this.salt());
    const key = await importAesKey(raw);
    const verifier = await this.kv.get<Sealed>(VERIFIER_KEY);
    if (verifier) {
      if (!(await checkVerifier(key, verifier))) return { ok: false, error: "wrong_passphrase" };
    } else {
      if ((await this.kv.get(PROFILE_KEY)) !== undefined) {
        const probe = new WebCryptoRefStore(this.kv, async () => key);
        try {
          await probe.getIdentity();
        } catch {
          return { ok: false, error: "wrong_passphrase" };
        }
      }
      await this.kv.set(VERIFIER_KEY, await makeVerifier(key));
    }
    this.key = key;
    await this.session.set(SESSION_KEY, [...raw]);
    return { ok: true };
  }

  /** 메모리에 키가 없으면 세션 저장소에서 복원(서비스워커 재시작 대비). 풀려 있으면 true. */
  private async restoreKey(): Promise<boolean> {
    if (this.key) return true;
    const raw = await this.session.get<number[] | null>(SESSION_KEY).catch(() => null);
    if (!raw) return false;
    this.key = await importAesKey(new Uint8Array(raw));
    return true;
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

/** 익스텐션 런타임은 chrome.storage.session(메모리 전용), 그 밖(테스트)은 메모리 Kv. */
function defaultSessionKv(): Kv {
  if (typeof chrome !== "undefined" && chrome.storage?.session) {
    return new ChromeKv(chrome.storage.session);
  }
  return new MemoryKv();
}
