// Responses API 스트리밍 클라이언트(ChatGPT 플랜 사용) — docs/spec/assistant.md §4.
// 프리뷰 제약: store:false·stream:true 필수, temperature·metadata·previous_response_id
// 불가, 호스티드 도구 불가. 그래서 대화 상태는 매 요청에 input 배열로 통째로 보낸다.

const API = "https://api.openai.com/v1";

export type ResponseItem = { type: string } & Record<string, unknown>;

export interface FunctionCallItem extends ResponseItem {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
}

export interface ResponseResult {
  output: ResponseItem[];
  text: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export interface ModelInfo {
  slug: string;
  name: string;
}

async function errorFrom(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as {
    error?: { code?: string; type?: string };
  } | null;
  return new ApiError(res.status, body?.error?.code ?? body?.error?.type ?? `http_${res.status}`);
}

export async function listModels(fetchFn: typeof fetch, token: string): Promise<ModelInfo[]> {
  const res = await fetchFn(`${API}/models`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw await errorFrom(res);
  const body = (await res.json()) as {
    models?: { slug?: string; display_name?: string; visibility?: string }[];
  };
  return (body.models ?? [])
    .filter((m) => m.slug && (m.visibility ?? "list") === "list")
    .map((m) => ({ slug: m.slug as string, name: m.display_name ?? (m.slug as string) }));
}

/** SSE 본문을 이벤트(JSON) 단위로 읽는다. */
export async function* sseEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    buf += dec.decode(value ?? new Uint8Array(), { stream: !done });
    buf = buf.replace(/\r\n/g, "\n");
    let i = buf.indexOf("\n\n");
    while (i >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      i = buf.indexOf("\n\n");
      const data = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("");
      if (!data || data === "[DONE]") continue;
      try {
        yield JSON.parse(data) as Record<string, unknown>;
      } catch {
        // 깨진 프레임은 건너뛴다 — 성공 여부는 response.completed 수신으로만 판정한다.
      }
    }
    if (done) return;
  }
}

/** 한 턴을 실행한다. `response.completed`를 받아야만 성공이다(문서 규칙). */
export async function createResponse(
  fetchFn: typeof fetch,
  req: {
    token: string;
    model: string;
    input: unknown[];
    tools: unknown[];
    includeReasoning: boolean;
    signal?: AbortSignal;
    onTextDelta?: (delta: string) => void;
  },
): Promise<ResponseResult> {
  const res = await fetchFn(`${API}/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${req.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: req.model,
      input: req.input,
      tools: req.tools,
      store: false,
      stream: true,
      // store:false에서는 추론 항목을 다음 요청에 되돌려 보내야 이어지므로 암호화본을 받는다.
      ...(req.includeReasoning ? { include: ["reasoning.encrypted_content"] } : {}),
    }),
    signal: req.signal,
  });
  if (!res.ok || !res.body) throw await errorFrom(res);
  let text = "";
  for await (const ev of sseEvents(res.body)) {
    if (ev.type === "response.output_text.delta" && typeof ev.delta === "string") {
      text += ev.delta;
      req.onTextDelta?.(ev.delta);
    } else if (ev.type === "response.completed") {
      const output = (ev.response as { output?: ResponseItem[] } | undefined)?.output ?? [];
      return { output, text };
    } else if (ev.type === "response.failed" || ev.type === "response.incomplete") {
      const err = (ev.response as { error?: { code?: string } } | undefined)?.error;
      throw new ApiError(0, err?.code ?? String(ev.type));
    }
  }
  throw new ApiError(0, "stream_ended_without_completion");
}
