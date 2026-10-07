// 테스트 전용 — Responses API의 SSE 응답을 만든다.
export function sseResponse(events: object[], chunkSize = 37): Response {
  const text = events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join("");
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      // 프레임 경계와 무관한 크기로 쪼개 보낸다(멀티바이트·프레임 분할 대응 검증).
      for (let i = 0; i < bytes.length; i += chunkSize) c.enqueue(bytes.slice(i, i + chunkSize));
      c.close();
    },
  });
  return new Response(stream, { status: 200 });
}

export const completed = (output: object[]) => ({
  type: "response.completed",
  response: { output },
});

export const textTurn = (text: string) => [
  { type: "response.output_text.delta", delta: text },
  completed([{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }]),
];

export const callTurn = (name: string, args: object, callId = "call_1") => [
  completed([{ type: "function_call", call_id: callId, name, arguments: JSON.stringify(args) }]),
];

/** 실제 플랜 사용 스트림의 모양 — 항목은 output_item.done으로 오고 completed의 output은 비어 있다. */
export const liveCallTurn = (name: string, args: object, callId = "call_1") => [
  { type: "response.created", response: {} },
  {
    type: "response.output_item.done",
    item: { type: "function_call", call_id: callId, name, arguments: JSON.stringify(args) },
  },
  completed([]),
];

export const liveTextTurn = (text: string) => [
  {
    type: "response.output_item.done",
    item: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
  },
  completed([]),
];
