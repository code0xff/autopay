import { describe, expect, it, vi } from "vitest";
import { createResponse, listModels, sseEvents } from "./responses.js";
import { completed, liveCallTurn, liveTextTurn, sseResponse, textTurn } from "./testing.js";

const base = { token: "at", model: "m", input: [], tools: [], includeReasoning: true };

describe("createResponse", () => {
  it("1. 프리뷰 필수 필드(store:false·stream:true)로 보내고 조각난 SSE를 이어 읽는다", async () => {
    const f = vi.fn(async () => sseResponse(textTurn("안녕하세요, 한글 조각"), 5));
    const deltas: string[] = [];
    const r = await createResponse(f as unknown as typeof fetch, {
      ...base,
      onTextDelta: (d) => deltas.push(d),
    });
    expect(r.text).toBe("안녕하세요, 한글 조각");
    expect(deltas.join("")).toBe(r.text);
    expect(r.output[0]?.type).toBe("message");
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer at");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ store: false, stream: true, model: "m" });
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("previous_response_id");
  });

  it("2. response.completed 없이 끝나면 실패다", async () => {
    const f = vi.fn(async () =>
      sseResponse([{ type: "response.output_text.delta", delta: "중간에 끊김" }]),
    );
    await expect(createResponse(f as unknown as typeof fetch, base)).rejects.toThrow(
      "stream_ended_without_completion",
    );
  });

  it("3. response.failed와 HTTP 오류는 코드와 함께 던진다", async () => {
    const failed = vi.fn(async () =>
      sseResponse([{ type: "response.failed", response: { error: { code: "server_error" } } }]),
    );
    await expect(createResponse(failed as unknown as typeof fetch, base)).rejects.toThrow(
      "server_error",
    );
    const limit = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { code: "subscription_sharing_usage_limit_exceeded" } }),
          { status: 429 },
        ),
    );
    await expect(createResponse(limit as unknown as typeof fetch, base)).rejects.toMatchObject({
      status: 429,
      code: "subscription_sharing_usage_limit_exceeded",
    });
  });

  it("4. includeReasoning=false면 include를 보내지 않는다", async () => {
    const f = vi.fn(async () => sseResponse([completed([])]));
    await createResponse(f as unknown as typeof fetch, { ...base, includeReasoning: false });
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string)).not.toHaveProperty("include");
  });
});

// 2026-10-08 실사용 버그: completed의 output이 비어 와서 "응답 []"로 읽고 도구 호출을
// 통째로 놓쳤다. 화면에는 아무 반응이 없는 것처럼 보였다.
describe("출력 항목 수집", () => {
  it("4-d. completed의 output이 비어도 output_item.done으로 온 항목을 쓴다", async () => {
    const f = vi.fn(async () => sseResponse(liveCallTurn("get_policy_summary", {})));
    const r = await createResponse(f as unknown as typeof fetch, base);
    expect(r.output).toHaveLength(1);
    expect(r.output[0]).toMatchObject({ type: "function_call", name: "get_policy_summary" });
    expect(r.eventTypes).toContain("response.output_item.done");
  });

  it("4-e. 델타 없이 message 항목만 와도 본문을 꺼낸다", async () => {
    const f = vi.fn(async () => sseResponse(liveTextTurn("건당 한도는 3만원입니다.")));
    const r = await createResponse(f as unknown as typeof fetch, base);
    expect(r.text).toBe("건당 한도는 3만원입니다.");
  });
});

describe("스트림 중단·정지", () => {
  // 열려만 있고 아무것도 보내지 않는 스트림 — 멈춘 서버를 흉내낸다.
  const stalled = () => new Response(new ReadableStream<Uint8Array>({ start() {} }));

  it("4-b. 중단 신호는 헤더 수신 뒤에도 본문 읽기를 끊는다", async () => {
    const ctrl = new AbortController();
    const f = vi.fn(async () => stalled());
    const p = createResponse(f as unknown as typeof fetch, { ...base, signal: ctrl.signal });
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("4-c. 이벤트가 한참 오지 않으면 멈춘 스트림으로 보고 끝낸다", async () => {
    const events = sseEvents(stalled().body as ReadableStream<Uint8Array>, { idleMs: 20 });
    await expect(events.next()).rejects.toThrow("network_timeout");
  });
});

describe("listModels", () => {
  it("5. 표시용(visibility:list) 모델만 서버 순서대로", async () => {
    const f = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            models: [
              { slug: "a", display_name: "A", visibility: "list" },
              { slug: "hidden", visibility: "hide" },
              { slug: "b" },
            ],
          }),
        ),
    );
    expect(await listModels(f as unknown as typeof fetch, "at")).toEqual([
      { slug: "a", name: "A" },
      { slug: "b", name: "b" },
    ]);
  });
});
