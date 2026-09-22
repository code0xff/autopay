import { BridgeRequestPaymentArgs, type BridgeToolCall, SafeHttpUrl } from "@autopay/shared";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Hub } from "./hub.js";

// MCP 도구 표면 = docs/spec/mcp-integration.md §3 전체이자 전부. 여기 없는
// 도구는 존재하지 않는다(§10 불변식) — 비밀·빌링키·세션을 반환하는 도구는 없다.

export interface McpServerLike {
  tool<Args extends z.ZodRawShape>(
    name: string,
    description: string,
    paramsSchema: Args,
    cb: (args: z.objectOutputType<Args, z.ZodTypeAny>) => Promise<CallToolResult>,
  ): unknown;
}

const Selector = z.string().min(1).max(300);
let seq = 0;
function nextId(): string {
  seq += 1;
  return `mcp-${Date.now()}-${seq}`;
}

async function callHub(hub: Hub, call: BridgeToolCall): Promise<CallToolResult> {
  const result = await hub.callTool(call);
  if (!result.ok) {
    return { content: [{ type: "text", text: `오류: ${result.error}` }], isError: true };
  }
  return { content: [{ type: "text", text: JSON.stringify(result.result) }] };
}

export function registerTools(server: McpServerLike, hub: Hub): void {
  server.tool(
    "open",
    "쇼핑몰 URL(검색 결과 페이지 등)을 브리지 탭에서 연다. 승인 없이는 결제로 이어지지 않는다.",
    { url: SafeHttpUrl },
    async (args) => callHub(hub, { id: nextId(), tool: "open", args: { url: args.url } }),
  );

  server.tool(
    "read_page",
    "현재 브리지 탭의 요소 목록(텍스트·셀렉터·링크)을 읽는다. 스크린샷이 아니다. open()을 먼저 호출해야 한다.",
    {},
    async () => callHub(hub, { id: nextId(), tool: "read_page", args: {} }),
  );

  server.tool(
    "click",
    "브리지 탭에서 selector가 가리키는 요소를 클릭한다(read_page가 준 selector 사용).",
    { selector: Selector },
    async (args) =>
      callHub(hub, { id: nextId(), tool: "click", args: { selector: args.selector } }),
  );

  server.tool(
    "fill",
    "브리지 탭에서 selector가 가리키는 입력 필드에 value를 채운다. 결제 비밀번호·카드번호는 절대 넣지 않는다.",
    { selector: Selector, value: z.string().max(500) },
    async (args) =>
      callHub(hub, {
        id: nextId(),
        tool: "fill",
        args: { selector: args.selector, value: args.value },
      }),
  );

  server.tool(
    "request_payment",
    "체크아웃 화면에서 결제를 '요청'한다. 항상 브로커 정책 검증을 거치고, 최종 승인은 사용자 폰이나 확인 게이트(out-of-band)에서 이뤄진다 — 이 도구는 승인을 대신하지 않는다.",
    BridgeRequestPaymentArgs.shape,
    async (args) =>
      callHub(hub, {
        id: nextId(),
        tool: "request_payment",
        args: {
          merchant: args.merchant,
          items: args.items,
          totalAmount: args.totalAmount,
          currency: args.currency,
          method: args.method,
        },
      }),
  );

  server.tool(
    "get_payment_result",
    "request_payment가 반환한 requestId로 결제 결과 요약(승인/거절/대기/취소/실패)을 조회한다. 비밀은 포함되지 않는다.",
    { requestId: z.string().min(1) },
    async (args) =>
      callHub(hub, {
        id: nextId(),
        tool: "get_payment_result",
        args: { requestId: args.requestId },
      }),
  );

  server.tool(
    "get_policy_summary",
    "결제를 시도하기 전에 먼저 호출: 잔여 예산·잔여 횟수·허용 카테고리/머천트/결제수단을 조회한다.",
    {},
    async () => callHub(hub, { id: nextId(), tool: "get_policy_summary", args: {} }),
  );
}
