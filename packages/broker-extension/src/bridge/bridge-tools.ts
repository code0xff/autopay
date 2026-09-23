import type { BridgeToolCall, BridgeToolResult, PaymentResult } from "@autopay/shared";
import type { PolicySummary } from "../broker/broker-core.js";
import type { GenericPageBridge } from "./page-bridge.js";

// MCP 도구 → BrokerTools/broker 매핑 (docs/spec/mcp-integration.md §3·§10).
// 여기 없는 도구는 존재하지 않는다 — 스킬이 이 표면 밖으로 나갈 방법이 없다.
// request_payment의 checkoutTabId는 에이전트가 주지 않는다: 이 클래스가 추적
// 중인 "브리지 탭"(open으로 연 탭)으로 항상 채운다(탭 id 비노출, §3).

export interface BridgeBroker {
  requestPayment(input: unknown): Promise<{ requestId: string }>;
  getPaymentResult(requestId: string): Promise<PaymentResult>;
  getPolicySummary(): Promise<PolicySummary>;
  /** 결제 실행 중이면 true — 페이지 도구 잠금(executor.md §3.2). */
  hasActiveExecution(): Promise<boolean>;
}

export interface BridgeToolsDeps {
  pageBridge: GenericPageBridge;
  broker: BridgeBroker;
  /** 잠겨 있으면 true — AutoPay 비활성, 모든 도구를 autopay_locked로 거부. */
  isLocked?: () => Promise<boolean>;
  getBridgeTabId: () => Promise<number | null>;
  setBridgeTabId: (tabId: number) => Promise<void>;
}

const PAGE_TOOLS = new Set<BridgeToolCall["tool"]>(["open", "read_page", "click", "fill"]);

export class BridgeTools {
  constructor(private readonly deps: BridgeToolsDeps) {}

  /** 실패해도 예외를 던지지 않는다 — 항상 BridgeToolResult로 수렴(fail-closed). */
  async handle(call: BridgeToolCall): Promise<BridgeToolResult> {
    try {
      const result = await this.dispatch(call);
      return { id: call.id, ok: true, result };
    } catch (e) {
      return { id: call.id, ok: false, error: e instanceof Error ? e.message : "tool_failed" };
    }
  }

  private async dispatch(call: BridgeToolCall): Promise<unknown> {
    // 결제 실행 중(사용자가 비번을 직접 입력하는 핸드오프 포함)에는 페이지를 읽거나
    // 조작하는 도구를 거부한다 — 입력 중인 값 읽기·키패드 클릭·이탈을 원천 차단.
    // 잠금 해제 전에는 AutoPay 자체가 비활성 — 페이지·결제·조회 도구 모두 거부.
    if (await this.deps.isLocked?.()) throw new Error("autopay_locked");
    if (PAGE_TOOLS.has(call.tool) && (await this.deps.broker.hasActiveExecution())) {
      throw new Error("page_locked_during_payment");
    }
    switch (call.tool) {
      case "open": {
        const existing = await this.deps.getBridgeTabId();
        const tabId = await this.deps.pageBridge.openOrReuse(call.args.url, existing);
        await this.deps.setBridgeTabId(tabId);
        return { opened: true };
      }
      case "read_page":
        return this.deps.pageBridge.readPage(await this.requireTab());
      case "click":
        await this.deps.pageBridge.click(await this.requireTab(), call.args.selector);
        return { clicked: true };
      case "fill":
        await this.deps.pageBridge.fill(
          await this.requireTab(),
          call.args.selector,
          call.args.value,
        );
        return { filled: true };
      case "request_payment": {
        const checkoutTabId = await this.requireTab();
        return this.deps.broker.requestPayment({ ...call.args, checkoutTabId });
      }
      case "get_payment_result":
        return this.deps.broker.getPaymentResult(call.args.requestId);
      case "get_policy_summary":
        return this.deps.broker.getPolicySummary();
    }
  }

  private async requireTab(): Promise<number> {
    const tabId = await this.deps.getBridgeTabId();
    if (tabId === null) throw new Error("no_open_tab"); // open()을 먼저 호출해야 함
    return tabId;
  }
}
