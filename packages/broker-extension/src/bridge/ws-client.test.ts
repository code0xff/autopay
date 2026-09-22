import type { BridgeToolCall, BridgeToolResult } from "@autopay/shared";
import { describe, expect, it, vi } from "vitest";
import { BridgeClient, type WebSocketLike } from "./ws-client.js";

// docs/spec/mcp-integration.md §5·§10 테스트 케이스

class FakeSocket implements WebSocketLike {
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.onclose?.();
  }
  // 테스트 헬퍼: 허브가 보낸 것처럼 프레임 주입
  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

describe("BridgeClient", () => {
  it("1. 접속 시 open 즉시 auth 프레임을 전송", () => {
    let sock: FakeSocket | undefined;
    const client = new BridgeClient({
      url: "ws://127.0.0.1:8765",
      token: "a".repeat(32),
      onCall: vi.fn(),
      wsFactory: (url) => {
        sock = new FakeSocket();
        return sock;
      },
    });
    client.connect();
    sock?.onopen?.();
    expect(sock?.sent).toEqual([JSON.stringify({ type: "auth", token: "a".repeat(32) })]);
  });

  it("2. auth_result(ok:true) 수신 전엔 connected=false, 수신 후 true", () => {
    let sock: FakeSocket | undefined;
    const client = new BridgeClient({
      url: "ws://x",
      token: "a".repeat(32),
      onCall: vi.fn(),
      wsFactory: (url) => {
        sock = new FakeSocket();
        return sock;
      },
    });
    client.connect();
    expect(client.connected).toBe(false);
    sock?.receive({ type: "auth_result", ok: true });
    expect(client.connected).toBe(true);
  });

  it("3. 인증 전 call 프레임은 처리하지 않는다(불변식 §10)", async () => {
    let sock: FakeSocket | undefined;
    const onCall = vi.fn(
      async (): Promise<BridgeToolResult> => ({ id: "c1", ok: true, result: 1 }),
    );
    const client = new BridgeClient({
      url: "ws://x",
      token: "a".repeat(32),
      onCall,
      wsFactory: (url) => {
        sock = new FakeSocket();
        return sock;
      },
    });
    client.connect();
    const call: BridgeToolCall = { id: "c1", tool: "get_policy_summary", args: {} };
    sock?.receive({ type: "call", call });
    await Promise.resolve();
    expect(onCall).not.toHaveBeenCalled();
  });

  it("4. 인증 후 call → onCall 실행 결과를 result 프레임으로 회신", async () => {
    let sock: FakeSocket | undefined;
    const onCall = vi.fn(
      async (): Promise<BridgeToolResult> => ({ id: "c1", ok: true, result: { budget: 100 } }),
    );
    const client = new BridgeClient({
      url: "ws://x",
      token: "a".repeat(32),
      onCall,
      wsFactory: (url) => {
        sock = new FakeSocket();
        return sock;
      },
    });
    client.connect();
    sock?.receive({ type: "auth_result", ok: true });
    const call: BridgeToolCall = { id: "c1", tool: "get_policy_summary", args: {} };
    sock?.receive({ type: "call", call });
    await Promise.resolve();
    await Promise.resolve();
    expect(onCall).toHaveBeenCalledWith(call);
    expect(sock?.sent.at(-1)).toBe(
      JSON.stringify({ type: "result", result: { id: "c1", ok: true, result: { budget: 100 } } }),
    );
  });

  it("5. 스키마 검증 실패(파싱 불가/미지 필드) 프레임은 조용히 무시", async () => {
    let sock: FakeSocket | undefined;
    const onCall = vi.fn();
    const client = new BridgeClient({
      url: "ws://x",
      token: "a".repeat(32),
      onCall,
      wsFactory: (url) => {
        sock = new FakeSocket();
        return sock;
      },
    });
    client.connect();
    sock?.onmessage?.({ data: "not json" });
    sock?.receive({ type: "unknown_type" });
    sock?.receive({ type: "call", call: { id: "c1", tool: "steal_secret", args: {} } });
    await Promise.resolve();
    expect(onCall).not.toHaveBeenCalled();
  });

  it("6. close 시 connected=false로 전환 + onStatusChange 통지", () => {
    let sock: FakeSocket | undefined;
    const onStatusChange = vi.fn();
    const client = new BridgeClient({
      url: "ws://x",
      token: "a".repeat(32),
      onCall: vi.fn(),
      onStatusChange,
      wsFactory: (url) => {
        sock = new FakeSocket();
        return sock;
      },
    });
    client.connect();
    sock?.receive({ type: "auth_result", ok: true });
    expect(client.connected).toBe(true);
    sock?.close();
    expect(client.connected).toBe(false);
    expect(onStatusChange).toHaveBeenCalledWith(false);
  });
});
