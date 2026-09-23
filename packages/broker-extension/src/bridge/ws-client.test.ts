import type { BridgeToolCall, BridgeToolResult } from "@autopay/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeClient, type WebSocketLike } from "./ws-client.js";

// docs/spec/mcp-integration.md §4.1·§5·§10 테스트 케이스

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

// 생존 확인·자동 재접속(spec §4.1) — 가짜 타이머로 주기·백오프를 결정적으로 검증.
describe("BridgeClient heartbeat & reconnect", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    vi.useFakeTimers();
    const socks: FakeSocket[] = [];
    const onStatusChange = vi.fn();
    const client = new BridgeClient({
      url: "ws://x",
      token: "a".repeat(32),
      onCall: vi.fn(),
      onStatusChange,
      pingIntervalMs: 20_000,
      pongTimeoutMs: 10_000,
      reconnectBaseMs: 1_000,
      reconnectMaxMs: 30_000,
      wsFactory: () => {
        const s = new FakeSocket();
        socks.push(s);
        return s;
      },
    });
    const last = () => socks[socks.length - 1] as FakeSocket;
    const authOk = () => last().receive({ type: "auth_result", ok: true });
    return { client, socks, last, authOk, onStatusChange };
  }

  const pings = (s: FakeSocket) => s.sent.filter((d) => d === JSON.stringify({ type: "ping" }));

  it("7. 인증 후 주기마다 ping 전송, 인증 전엔 보내지 않음", () => {
    const { client, last, authOk } = setup();
    client.connect();
    vi.advanceTimersByTime(60_000);
    expect(pings(last())).toHaveLength(0);
    authOk();
    vi.advanceTimersByTime(20_000);
    expect(pings(last())).toHaveLength(1);
    last().receive({ type: "pong" });
    vi.advanceTimersByTime(20_000);
    expect(pings(last())).toHaveLength(2);
    client.disconnect();
  });

  it("8. pong이 제때 오면 연결 유지", () => {
    const { client, socks, last, authOk } = setup();
    client.connect();
    authOk();
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(20_000);
      last().receive({ type: "pong" });
    }
    expect(client.connected).toBe(true);
    expect(socks).toHaveLength(1);
    client.disconnect();
  });

  it("9. pong 미수신 → 소켓 종료·connected=false → 백오프 후 새 소켓으로 재접속", () => {
    const { client, socks, last, authOk, onStatusChange } = setup();
    client.connect();
    authOk();
    vi.advanceTimersByTime(20_000 + 10_000); // ping 후 응답 없음
    expect(socks[0]?.closed).toBe(true);
    expect(client.connected).toBe(false);
    expect(onStatusChange).toHaveBeenLastCalledWith(false);
    vi.advanceTimersByTime(1_000);
    expect(socks).toHaveLength(2);
    last().onopen?.();
    expect(last().sent[0]).toBe(JSON.stringify({ type: "auth", token: "a".repeat(32) }));
    authOk();
    expect(client.connected).toBe(true);
    client.disconnect();
  });

  it("10. 허브 측 종료(close) → 자동 재접속, 실패가 이어지면 지수 백오프(상한 30s)", () => {
    const { client, socks, last } = setup();
    client.connect();
    const delays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
    for (const d of delays) {
      const before = socks.length;
      last().close(); // 접속 실패/끊김
      vi.advanceTimersByTime(d - 1);
      expect(socks.length).toBe(before);
      vi.advanceTimersByTime(1);
      expect(socks.length).toBe(before + 1);
    }
    client.disconnect();
  });

  it("11. 인증 성공 시 백오프 초기화", () => {
    const { client, socks, last, authOk } = setup();
    client.connect();
    last().close();
    vi.advanceTimersByTime(1_000);
    last().close();
    vi.advanceTimersByTime(2_000);
    authOk();
    last().close();
    const before = socks.length;
    vi.advanceTimersByTime(1_000);
    expect(socks.length).toBe(before + 1);
    client.disconnect();
  });

  it("12. 의도적 disconnect()는 재접속하지 않는다", () => {
    const { client, socks, authOk } = setup();
    client.connect();
    authOk();
    client.disconnect();
    vi.advanceTimersByTime(120_000);
    expect(socks).toHaveLength(1);
    expect(pings(socks[0] as FakeSocket)).toHaveLength(0);
  });

  it("13. 재접속 대기 중 connect()를 다시 부르면 중복 소켓 없이 즉시 1개만 연다", () => {
    const { client, socks, last } = setup();
    client.connect();
    last().close();
    client.connect(); // 예: 토큰 재등록
    expect(socks).toHaveLength(2);
    vi.advanceTimersByTime(60_000);
    expect(socks).toHaveLength(2);
    client.disconnect();
  });
});
