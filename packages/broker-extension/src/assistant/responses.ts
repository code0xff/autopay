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
  /** 받은 이벤트 종류(진단용). */
  eventTypes: string[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    /** 서버가 준 오류 설명(진단 로그용, 잘라서 보관). 사용자 화면 문구로는 쓰지 않는다. */
    readonly detail = "",
  ) {
    super(code);
  }
}

export interface ModelInfo {
  slug: string;
  name: string;
}

async function errorFrom(res: Response): Promise<ApiError> {
  const raw = await res.text().catch(() => "");
  let err: { code?: string; type?: string; message?: string } | undefined;
  try {
    err = (JSON.parse(raw) as { error?: typeof err }).error;
  } catch {}
  return new ApiError(
    res.status,
    err?.code ?? err?.type ?? `http_${res.status}`,
    (err?.message ?? raw).slice(0, 300),
  );
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

/** 이벤트 사이 무응답 상한 — 넘으면 멈춘 스트림으로 보고 끊는다. */
export const STREAM_IDLE_MS = 90_000;

/** SSE 본문을 이벤트(JSON) 단위로 읽는다. signal이 중단되면 읽기를 즉시 끊고,
 *  idleMs 동안 아무 바이트도 오지 않으면 network_timeout으로 끝낸다 — fetch의
 *  signal은 응답 헤더까지만 유효해서, 본문 읽기는 여기서 직접 끊어야 한다. */
export async function* sseEvents(
  body: ReadableStream<Uint8Array>,
  opts: { signal?: AbortSignal; idleMs?: number } = {},
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  const idleMs = opts.idleMs ?? STREAM_IDLE_MS;
  let buf = "";
  const interrupted = new Promise<never>((_, reject) => {
    const onAbort = () => reject(new DOMException("stopped", "AbortError"));
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
  });
  interrupted.catch(() => undefined); // 읽기가 먼저 끝난 경우의 미처리 거부 방지
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("network_timeout")), idleMs);
      });
      const { done, value } = await Promise.race([reader.read(), interrupted, idle]).finally(() =>
        clearTimeout(timer),
      );
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
  } finally {
    reader.cancel().catch(() => undefined); // 중단·타임아웃·조기 반환 모두 연결을 놓는다
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
  // 출력 항목은 스트림 도중 response.output_item.done으로 하나씩 온다. 마지막
  // response.completed의 output은 비어 올 수 있다(store:false 플랜 사용에서 실제로
  // 비어 왔고, 그걸 그대로 믿어 도구 호출을 통째로 놓친 적이 있다 — 2026-10-08).
  const items: ResponseItem[] = [];
  const seen = new Set<string>();
  for await (const ev of sseEvents(res.body, { signal: req.signal })) {
    if (typeof ev.type === "string") seen.add(ev.type);
    if (ev.type === "response.output_text.delta" && typeof ev.delta === "string") {
      text += ev.delta;
      req.onTextDelta?.(ev.delta);
    } else if (ev.type === "response.output_item.done" && isItem(ev.item)) {
      items.push(ev.item);
    } else if (ev.type === "response.completed") {
      const final = (ev.response as { output?: ResponseItem[] } | undefined)?.output ?? [];
      const output = items.length > 0 ? items : final;
      return { output, text: text || textOf(output), eventTypes: [...seen] };
    } else if (ev.type === "response.failed" || ev.type === "response.incomplete") {
      const err = (ev.response as { error?: { code?: string; message?: string } } | undefined)
        ?.error;
      throw new ApiError(0, err?.code ?? String(ev.type), (err?.message ?? "").slice(0, 300));
    }
  }
  throw new ApiError(0, "stream_ended_without_completion");
}

function isItem(v: unknown): v is ResponseItem {
  return typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";
}

/** 델타를 못 받았을 때의 대비 — message 항목의 output_text를 이어 붙인다. */
function textOf(output: ResponseItem[]): string {
  return output
    .filter((o) => o.type === "message" && Array.isArray(o.content))
    .flatMap((o) => o.content as { type?: string; text?: string }[])
    .filter((c) => c.type === "output_text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("");
}
