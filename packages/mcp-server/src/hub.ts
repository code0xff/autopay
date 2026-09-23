import { BridgeFrame, type BridgeToolCall, type BridgeToolResult } from "@autopay/shared";
import { type WebSocket, WebSocketServer } from "ws";

// 로컬 WS 허브(docs/spec/mcp-integration.md §2·§5) — 127.0.0.1 바인딩,
// 토큰 게이트, 단일 연결. MCP 도구 핸들러가 callTool()로 호출→응답을 기다린다.
// 인바운드는 전부 zod 검증(BridgeFrame) — 실패는 조용히 버린다(fail-closed).

export interface HubOptions {
  token: string;
  port: number;
  host?: string;
  callTimeoutMs?: number;
  authTimeoutMs?: number;
  /** 인증된 연결이 이 시간 동안 아무 프레임도 안 보내면 강제 종료(spec §4.1). */
  idleTimeoutMs?: number;
}

interface Pending {
  resolve: (r: BridgeToolResult) => void;
  timer: NodeJS.Timeout;
}

export class Hub {
  private wss: WebSocketServer | null = null;
  private conn: WebSocket | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly callTimeoutMs: number;
  private readonly authTimeoutMs: number;
  private readonly idleTimeoutMs: number;

  constructor(private readonly opts: HubOptions) {
    this.callTimeoutMs = opts.callTimeoutMs ?? 30_000;
    this.authTimeoutMs = opts.authTimeoutMs ?? 5_000;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 60_000;
  }

  get connected(): boolean {
    return this.conn !== null;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({
        host: this.opts.host ?? "127.0.0.1",
        port: this.opts.port,
      });
      this.wss = wss;
      wss.once("listening", resolve);
      wss.once("error", reject);
      wss.on("connection", (ws) => this.onConnection(ws));
    });
  }

  stop(): void {
    for (const [, p] of this.pending) clearTimeout(p.timer);
    this.pending.clear();
    this.conn?.close();
    this.conn = null;
    this.wss?.close();
    this.wss = null;
  }

  /** 익스텐션에 도구 호출을 보내고 result 프레임을 기다린다. 미접속·타임아웃도 실패로 수렴. */
  callTool(call: BridgeToolCall): Promise<BridgeToolResult> {
    if (!this.conn) {
      return Promise.resolve({ id: call.id, ok: false, error: "bridge_not_connected" });
    }
    const conn = this.conn;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(call.id);
        resolve({ id: call.id, ok: false, error: "bridge_timeout" });
      }, this.callTimeoutMs);
      this.pending.set(call.id, { resolve, timer });
      conn.send(JSON.stringify({ type: "call", call }));
    });
  }

  private onConnection(ws: WebSocket): void {
    let authed = false;
    const authTimer = setTimeout(() => {
      if (!authed) ws.close();
    }, this.authTimeoutMs);
    // 반쯤 열린 죽은 연결이 단일 연결 슬롯을 영구 점유하지 않게(spec §4.1) —
    // 인증 후 프레임이 올 때마다 갱신, 만료 시 terminate(close 핸드셰이크 없이 즉시).
    let idleTimer: NodeJS.Timeout | null = null;
    const touch = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => ws.terminate(), this.idleTimeoutMs);
    };

    ws.on("message", (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const frame = BridgeFrame.safeParse(parsed);
      if (!frame.success) return;
      const f = frame.data;
      if (authed) touch();

      if (f.type === "auth") {
        clearTimeout(authTimer);
        if (authed) return; // 재인증 무시
        const alreadyConnected = this.conn !== null;
        if (f.token !== this.opts.token || alreadyConnected) {
          ws.send(JSON.stringify({ type: "auth_result", ok: false }));
          ws.close();
          return;
        }
        authed = true;
        this.conn = ws;
        touch();
        ws.send(JSON.stringify({ type: "auth_result", ok: true }));
        return;
      }

      if (f.type === "ping" && authed) {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }

      if (f.type === "result" && authed) {
        const p = this.pending.get(f.result.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(f.result.id);
        p.resolve(f.result);
        return;
      }

      // "call"/"auth_result"/"pong"은 익스텐션→허브 방향이 아니므로 무시(인증 안 됐으면 전부 무시).
    });

    ws.on("close", () => {
      clearTimeout(authTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (this.conn === ws) {
        this.conn = null;
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.resolve({ id, ok: false, error: "bridge_disconnected" });
        }
        this.pending.clear();
      }
    });

    ws.on("error", () => {}); // 연결별 오류는 close로 수렴
  }
}
