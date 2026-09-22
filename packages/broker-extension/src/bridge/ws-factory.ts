import type { WebSocketLike } from "./ws-client.js";

// 실제 브라우저(MV3 SW) WebSocket을 WebSocketLike로 감싼다 — ws-client.ts는
// 이 파일을 몰라도 되게 주입식으로 유지(테스트는 FakeSocket으로 대체).
export function defaultWsFactory(url: string): WebSocketLike {
  const ws = new WebSocket(url);
  const wrapper: WebSocketLike = {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  ws.onopen = () => wrapper.onopen?.();
  ws.onmessage = (ev) => wrapper.onmessage?.({ data: String(ev.data) });
  ws.onclose = () => wrapper.onclose?.();
  ws.onerror = (ev) => wrapper.onerror?.(ev);
  return wrapper;
}
