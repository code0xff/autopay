import { describe, expect, it, vi } from "vitest";
import { createResponse, listModels } from "./responses.js";
import { completed, sseResponse, textTurn } from "./testing.js";

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
