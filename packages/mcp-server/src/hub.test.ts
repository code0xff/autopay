import type { BridgeToolCall } from "@autopay/shared";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Hub } from "./hub.js";

// docs/spec/mcp-integration.md §5·§10 테스트 케이스 — 실제 ws 서버/클라이언트로
// 검증(127.0.0.1 임시 포트, 외부 노출 없음).

const TOKEN = "a".repeat(32);
let hub: Hub | undefined;
let client: WebSocket | undefined;
const clients: WebSocket[] = [];

afterEach(() => {
  for (const c of clients) c.close();
  clients.length = 0;
  hub?.stop();
  hub = undefined;
  client = undefined;
});

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    clients.push(ws);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function once(ws: WebSocket, event: "message"): Promise<unknown> {
  return new Promise((resolve) => {
    ws.once(event, (data: Buffer) => resolve(JSON.parse(data.toString())));
  });
}

async function startHub(): Promise<{ hub: Hub; port: number }> {
  const h = new Hub({ token: TOKEN, port: 0, authTimeoutMs: 200, callTimeoutMs: 300 });
  await h.start();
  hub = h;
  // ws는 port:0으로 os가 실제 포트를 배정 — wss 내부 서버 주소에서 읽는다.
  const addr = (h as unknown as { wss: { address(): { port: number } } }).wss.address();
  return { hub: h, port: addr.port };
}

describe("Hub", () => {
  it("1. 올바른 토큰으로 인증하면 auth_result ok:true", async () => {
    const { port } = await startHub();
    client = await connect(port);
    const resultP = once(client, "message");
    client.send(JSON.stringify({ type: "auth", token: TOKEN }));
    expect(await resultP).toEqual({ type: "auth_result", ok: true });
  });

  it("2. 잘못된 토큰이면 auth_result ok:false + 연결 종료", async () => {
    const { port } = await startHub();
    client = await connect(port);
    const resultP = once(client, "message");
    client.send(JSON.stringify({ type: "auth", token: "b".repeat(32) }));
    expect(await resultP).toEqual({ type: "auth_result", ok: false });
  });

  it("3. 이미 연결된 상태에서 두 번째 연결의 인증은 거부(단일 연결, spec §5)", async () => {
    const { hub: h, port } = await startHub();
    const first = await connect(port);
    const firstAuthed = once(first, "message");
    first.send(JSON.stringify({ type: "auth", token: TOKEN }));
    await firstAuthed;
    expect(h.connected).toBe(true);

    const second = await connect(port);
    const secondResult = once(second, "message");
    second.send(JSON.stringify({ type: "auth", token: TOKEN }));
    expect(await secondResult).toEqual({ type: "auth_result", ok: false });
  });

  it("4. 인증되지 않은 연결에서 온 result 프레임은 무시된다", async () => {
    const { hub: h, port } = await startHub();
    client = await connect(port);
    // 인증 없이 바로 call을 시도(허브 입장에선 call도 익스텐션→허브 방향이 아니라 무시되지만,
    // 여기선 미인증 상태에서의 아무 프레임도 허브 상태를 바꾸지 않음을 확인).
    client.send(JSON.stringify({ type: "result", result: { id: "x", ok: true, result: 1 } }));
    await new Promise((r) => setTimeout(r, 50));
    expect(h.connected).toBe(false);
  });

  it("5. callTool — 미접속이면 즉시 bridge_not_connected", async () => {
    const { hub: h } = await startHub();
    const call: BridgeToolCall = { id: "c1", tool: "get_policy_summary", args: {} };
    await expect(h.callTool(call)).resolves.toEqual({
      id: "c1",
      ok: false,
      error: "bridge_not_connected",
    });
  });

  it("6. callTool — 접속 후 call 프레임 전송 + result로 해소", async () => {
    const { hub: h, port } = await startHub();
    client = await connect(port);
    const authed = once(client, "message");
    client.send(JSON.stringify({ type: "auth", token: TOKEN }));
    await authed;

    const call: BridgeToolCall = { id: "c1", tool: "get_policy_summary", args: {} };
    const received = once(client, "message"); // 허브가 보낼 call 프레임
    const callP = h.callTool(call);
    const frame = (await received) as { type: string; call: BridgeToolCall };
    expect(frame).toEqual({ type: "call", call });

    client.send(
      JSON.stringify({ type: "result", result: { id: "c1", ok: true, result: { budget: 1 } } }),
    );
    await expect(callP).resolves.toEqual({ id: "c1", ok: true, result: { budget: 1 } });
  });

  it("7. callTool — 타임아웃 시 bridge_timeout으로 수렴", async () => {
    const { hub: h, port } = await startHub();
    client = await connect(port);
    const authed = once(client, "message");
    client.send(JSON.stringify({ type: "auth", token: TOKEN }));
    await authed;

    const call: BridgeToolCall = { id: "c1", tool: "get_policy_summary", args: {} };
    await expect(h.callTool(call)).resolves.toEqual({
      id: "c1",
      ok: false,
      error: "bridge_timeout",
    });
  });

  it("8. 연결 종료 시 미해소 호출은 bridge_disconnected로 실패", async () => {
    const { hub: h, port } = await startHub();
    client = await connect(port);
    const authed = once(client, "message");
    client.send(JSON.stringify({ type: "auth", token: TOKEN }));
    await authed;

    const call: BridgeToolCall = { id: "c1", tool: "get_policy_summary", args: {} };
    const callP = h.callTool(call);
    client.close();
    await expect(callP).resolves.toEqual({ id: "c1", ok: false, error: "bridge_disconnected" });
  });

  it("9. 스키마 검증 실패(미지 필드·잘못된 tool) 프레임은 무시하고 상태를 바꾸지 않는다", async () => {
    const { hub: h, port } = await startHub();
    client = await connect(port);
    client.send("not json");
    client.send(JSON.stringify({ type: "auth", token: TOKEN, extra: "x" })); // strict 위반
    await new Promise((r) => setTimeout(r, 50));
    expect(h.connected).toBe(false);
  });
});
