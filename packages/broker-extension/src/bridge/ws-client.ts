import { BridgeFrame, type BridgeToolCall, type BridgeToolResult } from "@autopay/shared";

// mcp-server 로컬 WS 허브에 접속하는 클라이언트(익스텐션 background = WS 클라이언트,
// MV3 SW는 서버를 못 열지만 클라이언트는 가능 — docs/spec/mcp-integration.md §2).
// 인바운드는 전부 zod 검증(fail-closed) + 인증 전 call은 절대 처리하지 않는다(§10).
// 생존 확인(ping/pong)과 자동 재접속은 §4.1.

export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type WsFactory = (url: string) => WebSocketLike;

export interface BridgeClientDeps {
  url: string;
  token: string;
  onCall: (call: BridgeToolCall) => Promise<BridgeToolResult>;
  wsFactory: WsFactory;
  onStatusChange?: (connected: boolean) => void;
  /** ping 주기. 20s — MV3 SW 유휴 타이머(30s)보다 짧게(§4.1). */
  pingIntervalMs?: number;
  /** ping 후 이 시간 안에 아무 프레임도 없으면 죽은 연결로 본다. */
  pongTimeoutMs?: number;
  /** 재접속 백오프 시작값·상한. */
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
}

export class BridgeClient {
  private ws: WebSocketLike | null = null;
  private authed = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private readonly pingIntervalMs: number;
  private readonly pongTimeoutMs: number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;

  constructor(private readonly deps: BridgeClientDeps) {
    this.pingIntervalMs = deps.pingIntervalMs ?? 20_000;
    this.pongTimeoutMs = deps.pongTimeoutMs ?? 10_000;
    this.reconnectBaseMs = deps.reconnectBaseMs ?? 1_000;
    this.reconnectMaxMs = deps.reconnectMaxMs ?? 30_000;
  }

  get connected(): boolean {
    return this.authed;
  }

  /** 저장된 토큰이 바뀌었을 때(옵션에서 재등록) 다음 connect()가 쓸 토큰 갱신. */
  setToken(token: string): void {
    this.deps.token = token;
  }

  connect(): void {
    this.disconnect();
    this.open();
  }

  /** 의도적 해제 — 자동 재접속하지 않는다. */
  disconnect(): void {
    this.clearReconnect();
    this.teardown();
  }

  private open(): void {
    let ws: WebSocketLike;
    try {
      ws = this.deps.wsFactory(this.deps.url);
    } catch {
      this.scheduleReconnect(); // 잘못된 URL 등 생성 실패도 재시도로 수렴
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "auth", token: this.deps.token }));
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      void this.onMessage(ev.data);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return; // 이미 교체·해제된 소켓의 늦은 close는 무시
      this.teardown();
      this.scheduleReconnect();
    };
    ws.onerror = () => {}; // 오류는 close로 수렴
  }

  /** 현재 소켓·타이머 정리 + 상태 false 통지. 재접속 예약은 건드리지 않는다. */
  private teardown(): void {
    this.stopHeartbeat();
    const ws = this.ws;
    this.ws = null;
    const wasAuthed = this.authed;
    this.authed = false;
    ws?.close();
    if (wasAuthed) this.deps.onStatusChange?.(false);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(this.reconnectBaseMs * 2 ** this.attempt, this.reconnectMaxMs);
    this.attempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => {
      if (!this.ws || this.pongTimer) return; // 이전 ping 응답 대기 중이면 중복 전송 안 함
      this.ws.send(JSON.stringify({ type: "ping" }));
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null;
        // 응답 없음 = 죽은 연결. 소켓을 버리고 재접속한다.
        this.teardown();
        this.scheduleReconnect();
      }, this.pongTimeoutMs);
    }, this.pingIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pingTimer = null;
    this.pongTimer = null;
  }

  private async onMessage(data: string): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      return; // 파싱 실패 — 무시(fail-closed)
    }
    const parsed = BridgeFrame.safeParse(raw);
    if (!parsed.success) return;
    const frame = parsed.data;

    // 인증된 연결에서 온 유효 프레임은 무엇이든 생존 증거다.
    if (this.authed && this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }

    if (frame.type === "auth_result") {
      this.authed = frame.ok;
      if (frame.ok) {
        this.attempt = 0;
        this.startHeartbeat();
      }
      this.deps.onStatusChange?.(frame.ok);
      return;
    }

    if (frame.type === "call") {
      // 인증 전에는 어떤 call도 처리하지 않는다 — 토큰 미검증 연결은 부수효과 없음(§10).
      if (!this.authed) return;
      const ws = this.ws;
      const result = await this.deps.onCall(frame.call);
      ws?.send(JSON.stringify({ type: "result", result }));
      return;
    }

    // "pong"은 위에서 생존 확인으로 처리됨. "auth"/"result"/"ping"은 허브→클라이언트 방향이 아니므로 무시.
  }
}
