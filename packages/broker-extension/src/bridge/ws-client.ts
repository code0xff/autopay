import { BridgeFrame, type BridgeToolCall, type BridgeToolResult } from "@autopay/shared";

// mcp-server 로컬 WS 허브에 접속하는 클라이언트(익스텐션 background = WS 클라이언트,
// MV3 SW는 서버를 못 열지만 클라이언트는 가능 — docs/spec/mcp-integration.md §2).
// 인바운드는 전부 zod 검증(fail-closed) + 인증 전 call은 절대 처리하지 않는다(§10).

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
}

export class BridgeClient {
  private ws: WebSocketLike | null = null;
  private authed = false;

  constructor(private readonly deps: BridgeClientDeps) {}

  get connected(): boolean {
    return this.authed;
  }

  /** 저장된 토큰이 바뀌었을 때(옵션에서 재등록) 다음 connect()가 쓸 토큰 갱신. */
  setToken(token: string): void {
    this.deps.token = token;
  }

  connect(): void {
    this.disconnect();
    const ws = this.deps.wsFactory(this.deps.url);
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "auth", token: this.deps.token }));
    };
    ws.onmessage = (ev) => {
      void this.onMessage(ev.data);
    };
    ws.onclose = () => {
      this.authed = false;
      this.deps.onStatusChange?.(false);
    };
    ws.onerror = () => {};
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
    this.authed = false;
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

    if (frame.type === "auth_result") {
      this.authed = frame.ok;
      this.deps.onStatusChange?.(frame.ok);
      return;
    }

    if (frame.type === "call") {
      // 인증 전에는 어떤 call도 처리하지 않는다 — 토큰 미검증 연결은 부수효과 없음(§10).
      if (!this.authed) return;
      const result = await this.deps.onCall(frame.call);
      this.ws?.send(JSON.stringify({ type: "result", result }));
      return;
    }

    // "auth"/"result"는 서버(허브)→클라이언트 방향이 아니므로 무시.
  }
}
