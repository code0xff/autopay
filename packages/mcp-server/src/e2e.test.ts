import type { BridgeFrame, BridgeToolCall } from "@autopay/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Hub } from "./hub.js";
import { registerTools } from "./tools.js";

// docs/spec/mcp-integration.md 전체 경로 E2E — "Claude Code(MCP Client) → 실제
// McpServer → 실제 Hub(WS) → 익스텐션(여기선 실제 ws 클라이언트로 흉내)"까지
// 전부 실물(SDK Client/Server, ws)로 왕복 검증한다. 유일하게 실물이 아닌 것은
// 익스텐션 background(BridgeTools) 응답 로직 — 그건 broker-extension 쪽
// bridge-tools.test.ts가 주입식으로 이미 검증했으므로, 여기서는 그 응답을
// 그대로 흉내내는 최소 페이크로 프로토콜 왕복만 확인한다.
// (이 환경엔 브라우저·실제 Claude Code 프로세스가 없어 이보다 더 "라이브"로는
// 검증할 수 없다 — docs/status.md "M2 잔여" 참조.)

const TOKEN = "e2e-token-".padEnd(32, "0");

interface FakeExtension {
  ws: WebSocket;
  close(): void;
}

/** 실제 익스텐션 background를 흉내: 인증 후 call을 받으면 canned 응답을 돌려준다. */
function connectFakeExtension(
  port: number,
  responder: (call: BridgeToolCall) => unknown,
): Promise<FakeExtension> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once("open", () => {
      ws.send(JSON.stringify({ type: "auth", token: TOKEN }));
    });
    ws.once("error", reject);
    ws.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as BridgeFrame;
      if (frame.type === "auth_result") {
        if (!frame.ok) reject(new Error("fake extension auth failed"));
        else resolve({ ws, close: () => ws.close() });
        return;
      }
      if (frame.type === "call") {
        const result = responder(frame.call);
        ws.send(
          JSON.stringify({ type: "result", result: { id: frame.call.id, ok: true, result } }),
        );
      }
    });
  });
}

let hub: Hub | undefined;
let ext: FakeExtension | undefined;
let client: Client | undefined;

afterEach(async () => {
  await client?.close();
  ext?.close();
  hub?.stop();
  hub = undefined;
  ext = undefined;
  client = undefined;
});

async function setup(responder?: (call: BridgeToolCall) => unknown) {
  const h = new Hub({ token: TOKEN, port: 0, callTimeoutMs: 1000 });
  await h.start();
  hub = h;
  const port = (h as unknown as { wss: { address(): { port: number } } }).wss.address().port;

  if (responder) {
    ext = await connectFakeExtension(port, responder);
  }

  const server = new McpServer({ name: "autopay", version: "0.1.0" });
  registerTools(server, h);

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "test-client", version: "0.0.0" });
  client = c;
  await Promise.all([server.connect(serverTransport), c.connect(clientTransport)]);
  return { hub: h, client: c };
}

describe("MCP 브리지 E2E (Client → McpServer → Hub → WS → 가짜 익스텐션)", () => {
  it("1. tools/list — 스펙 §3의 7개 도구만 노출된다(그 이상도 이하도 아님)", async () => {
    const { client: c } = await setup();
    const { tools } = await c.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "click",
        "fill",
        "get_payment_result",
        "get_policy_summary",
        "open",
        "read_page",
        "request_payment",
      ].sort(),
    );
  });

  it("2. get_policy_summary — MCP 클라이언트 호출이 실제 WS를 타고 가짜 익스텐션까지 왕복한다", async () => {
    const { client: c } = await setup((call) => {
      expect(call.tool).toBe("get_policy_summary");
      return { remainingDailyBudget: 50000, remainingCountToday: 2 };
    });
    const res = await c.callTool({ name: "get_policy_summary", arguments: {} });
    const text = (res.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
    expect(JSON.parse(text)).toEqual({ remainingDailyBudget: 50000, remainingCountToday: 2 });
    expect(res.isError).toBeFalsy();
  });

  it("3. request_payment — 에이전트 인자가 그대로 BridgeToolCall.args로 전달된다(checkoutTabId 없이)", async () => {
    let received: BridgeToolCall | null = null;
    const { client: c } = await setup((call) => {
      received = call;
      return { requestId: "req-1" };
    });
    const args = {
      merchant: { origin: "https://shop.example", name: "Shop" },
      items: [{ title: "키보드", quantity: 1, unitPrice: 20000 }],
      totalAmount: 20000,
      currency: "KRW",
      method: "coupay",
    };
    const res = await c.callTool({ name: "request_payment", arguments: args });
    expect(received?.tool).toBe("request_payment");
    expect(received?.args).toEqual(args); // checkoutTabId는 익스텐션 몫 — 여기 없음
    const text = (res.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
    expect(JSON.parse(text)).toEqual({ requestId: "req-1" });
  });

  it("4. 익스텐션 미접속 상태 — bridge_not_connected가 isError로 그대로 올라온다(비밀 노출 없이 실패)", async () => {
    const { client: c } = await setup(); // responder 없음 = 익스텐션 미접속
    const res = await c.callTool({ name: "get_policy_summary", arguments: {} });
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
    expect(text).toContain("bridge_not_connected");
  });

  it("5. open — 자격증명이 포함된 URL은 MCP 입력 스키마 단계에서 거절된다(허브까지 가지 않음)", async () => {
    const { client: c } = await setup((call) => {
      throw new Error(`허브까지 도달하면 안 됨: ${JSON.stringify(call)}`);
    });
    await expect(
      c.callTool({ name: "open", arguments: { url: "https://user:pass@shop.example" } }),
    ).rejects.toThrow();
  });

  it("6. 존재하지 않는 도구 호출 — MCP 표준 오류로 거절(스킬이 표면 밖으로 못 나간다, §10)", async () => {
    const { client: c } = await setup();
    await expect(c.callTool({ name: "get_secret", arguments: {} })).rejects.toThrow();
  });
});
