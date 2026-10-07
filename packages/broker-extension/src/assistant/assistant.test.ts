import type { BridgeToolCall, BridgeToolResult } from "@autopay/shared";
import { describe, expect, it, vi } from "vitest";
import { MemoryKv } from "../platform/kv.js";
import { importAesKey, openJson, sealJson } from "../refstore/refstore.js";
import { Assistant } from "./assistant.js";
import { callTurn, sseResponse, textTurn } from "./testing.js";

// 내장 어시스턴트(docs/spec/assistant.md). OpenAI 쪽은 주입한 fetch로 대체한다.
// 핵심 불변식: 모델이 할 수 있는 일은 BridgeTools 7개뿐이고(스키마 재검증),
// OAuth 토큰은 봉인 저장되며 모델·UI 어디에도 나가지 않는다.

type Turn = object[] | Response;

async function setup(opts: { turns?: Turn[]; tokenBodies?: (object | Response)[] } = {}) {
  const key = await importAesKey(crypto.getRandomValues(new Uint8Array(32)));
  const kv = new MemoryKv();
  const session = new MemoryKv();
  const turns = [...(opts.turns ?? [])];
  const tokenBodies = [
    ...(opts.tokenBodies ?? [
      {
        access_token: "ACCESS-1",
        refresh_token: "REFRESH-1",
        expires_in: 3600,
        scope: "openid chatgpt.tokens.use.direct",
      },
    ]),
  ];
  const requests: { url: string; body: string; auth: string }[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
    requests.push({ url, body: String(init?.body ?? ""), auth });
    if (url.endsWith("/oauth/token")) {
      const body = tokenBodies.shift();
      return body instanceof Response ? body : new Response(JSON.stringify(body));
    }
    if (url.endsWith("/models")) {
      return new Response(JSON.stringify({ models: [{ slug: "gpt-test", display_name: "Test" }] }));
    }
    const turn = turns.shift();
    if (!turn) throw new Error("no more turns");
    return turn instanceof Response ? turn : sseResponse(turn);
  });
  const handle = vi.fn(
    async (call: BridgeToolCall): Promise<BridgeToolResult> => ({
      id: call.id,
      ok: true,
      result: { tool: call.tool },
    }),
  );
  const opened: string[] = [];
  let now = 1_000_000;
  const sleep = vi.fn(async () => {});
  const assistant = new Assistant({
    kv,
    session,
    seal: (obj) => sealJson(key, obj),
    open: (sealed) => openJson(key, sealed),
    tools: { handle },
    fetch: fetchFn as unknown as typeof fetch,
    openTab: async (url) => {
      opened.push(url);
    },
    now: () => now,
    sleep,
  });
  const login = async () => {
    await assistant.startLogin();
    const auth = new URL(opened.at(-1) as string).searchParams;
    const cb = `${auth.get("redirect_uri")}?code=CODE&client_id=oaiapp_issued&state=${auth.get("state")}`;
    expect(await assistant.handleCallbackUrl(cb)).toBe(true);
  };
  const responsesBodies = () =>
    requests.filter((r) => r.url.endsWith("/responses")).map((r) => JSON.parse(r.body));
  return {
    assistant,
    kv,
    session,
    handle,
    sleep,
    requests,
    opened,
    login,
    responsesBodies,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("로그인", () => {
  it("1. 콜백 처리 후 토큰은 봉인 저장되고 client_id가 보존된다", async () => {
    const t = await setup();
    await t.login();
    const state = await t.assistant.state();
    expect(state).toMatchObject({ signedIn: true, loginPending: false, loginError: null });
    expect(JSON.stringify(await t.kv.get("assistant:tokens"))).not.toContain("ACCESS-1");
    expect(JSON.stringify(await t.kv.get("assistant:tokens"))).not.toContain("REFRESH-1");
    expect(await t.kv.get("assistant:client")).toMatchObject({ clientId: "oaiapp_issued" });
    expect(JSON.stringify(state)).not.toContain("ACCESS-1"); // UI 상태에 토큰 없음
  });

  it("2. 진행 중인 로그인과 무관한 127.0.0.1 주소는 건드리지 않는다", async () => {
    const t = await setup();
    expect(await t.assistant.handleCallbackUrl("http://127.0.0.1:3000/callback?code=x")).toBe(
      false,
    );
    await t.assistant.startLogin();
    expect(await t.assistant.handleCallbackUrl("http://127.0.0.1:3000/callback?code=x")).toBe(
      false,
    );
    expect((await t.assistant.state()).signedIn).toBe(false);
  });

  it("3. state가 다른 콜백은 실패로 끝나고 재사용되지 않는다", async () => {
    const t = await setup();
    await t.assistant.startLogin();
    const redirect = new URL(t.opened[0] as string).searchParams.get("redirect_uri");
    const forged = `${redirect}?code=CODE&client_id=oaiapp_evil&state=forged`;
    expect(await t.assistant.handleCallbackUrl(forged)).toBe(true);
    const state = await t.assistant.state();
    expect(state.signedIn).toBe(false);
    expect(state.loginError).toContain("일치하지");
    expect(t.requests.some((r) => r.url.endsWith("/oauth/token"))).toBe(false); // 교환 시도 없음
  });

  it("4. 재로그인은 발급된 client_id로 요청한다", async () => {
    const t = await setup();
    await t.login();
    await t.assistant.logout();
    await t.assistant.startLogin();
    const q = new URL(t.opened.at(-1) as string).searchParams;
    expect(q.get("client_id")).toBe("oaiapp_issued");
    expect(q.has("agent_name_hint")).toBe(false);
  });
});

describe("실행 루프", () => {
  it("5. 도구 호출 → 결과 반환 → 최종 답변, 그리고 매 요청에 전체 맥락을 보낸다", async () => {
    const t = await setup({
      turns: [callTurn("get_policy_summary", {}), textTurn("건당 한도는 3만원입니다.")],
    });
    await t.login();
    await t.assistant.send("한도 알려줘");
    await t.assistant.idle();

    expect(t.handle).toHaveBeenCalledTimes(1);
    expect(t.handle.mock.calls[0]?.[0]).toMatchObject({ tool: "get_policy_summary", args: {} });
    const state = await t.assistant.state();
    expect(state.running).toBe(false);
    expect(state.messages.map((m) => m.role)).toEqual(["user", "tool", "assistant"]);
    expect(state.messages.at(-1)?.text).toBe("건당 한도는 3만원입니다.");

    const [first, second] = t.responsesBodies();
    expect(first.model).toBe("gpt-test");
    expect(first.input[0].role).toBe("developer"); // 지침은 매 요청 맨 앞
    expect(first.tools.map((x: { name: string }) => x.name)).toEqual([
      "open",
      "read_page",
      "click",
      "fill",
      "request_payment",
      "get_payment_result",
      "get_policy_summary",
    ]);
    // store:false라 서버가 기억하지 않는다 — 함수 호출과 그 결과를 다시 실어 보낸다.
    const types = second.input.map((i: { type?: string; role?: string }) => i.type ?? i.role);
    expect(types).toEqual(["developer", "user", "function_call", "function_call_output"]);
    expect(t.requests.every((r) => !r.body.includes("ACCESS-1"))).toBe(true); // 토큰은 헤더로만
  });

  it("6. 스키마에 안 맞는 호출·없는 도구는 실행하지 않고 오류만 돌려준다", async () => {
    const t = await setup({
      turns: [
        callTurn("open", { url: "http://insecure.example/" }, "c1"), // https 아님
        callTurn("get_secret", {}, "c2"), // 표면 밖
        callTurn("request_payment", { totalAmount: 1, checkoutTabId: 7 }, "c3"), // 탭 id 주입 시도
        textTurn("끝"),
      ],
    });
    await t.login();
    await t.assistant.send("x");
    await t.assistant.idle();
    expect(t.handle).not.toHaveBeenCalled();
    const last = t.responsesBodies().at(-1);
    const outputs = last.input.filter((i: { type?: string }) => i.type === "function_call_output");
    expect(outputs.map((o: { output: string }) => o.output)).toEqual([
      '{"error":"invalid_tool_call"}',
      '{"error":"invalid_tool_call"}',
      '{"error":"invalid_tool_call"}',
    ]);
  });

  it("7. 도구 실패(잠금 등)는 사유를 모델에 그대로 전한다", async () => {
    const t = await setup({ turns: [callTurn("read_page", {}), textTurn("확인")] });
    t.handle.mockResolvedValueOnce({ id: "x", ok: false, error: "page_locked_during_payment" });
    await t.login();
    await t.assistant.send("x");
    await t.assistant.idle();
    const out = t.responsesBodies()[1].input.at(-1);
    expect(out.output).toBe('{"error":"page_locked_during_payment"}');
  });

  it("8. 결제 대기 중 조회는 간격을 두고 돌려준다(연타 방지)", async () => {
    const t = await setup({
      turns: [callTurn("get_payment_result", { requestId: "r1" }), textTurn("대기 중입니다")],
    });
    t.handle.mockResolvedValueOnce({
      id: "x",
      ok: true,
      result: { status: "pending_user_confirmation" },
    });
    await t.login();
    await t.assistant.send("x");
    await t.assistant.idle();
    expect(t.sleep).toHaveBeenCalledWith(5000);
  });

  it("9. 만료가 가까우면 리프레시하고 회전된 토큰으로 호출한다", async () => {
    const t = await setup({
      turns: [textTurn("ok")],
      tokenBodies: [
        {
          access_token: "ACCESS-1",
          refresh_token: "REFRESH-1",
          expires_in: 3600,
          scope: "chatgpt.tokens.use.direct",
        },
        { access_token: "ACCESS-2", refresh_token: "REFRESH-2", expires_in: 3600 },
      ],
    });
    await t.login();
    t.advance(3_590_000); // 만료 10초 전
    await t.assistant.send("x");
    await t.assistant.idle();
    const refresh = t.requests.filter((r) => r.url.endsWith("/oauth/token"))[1];
    expect(new URLSearchParams(refresh?.body).get("refresh_token")).toBe("REFRESH-1");
    expect(t.requests.find((r) => r.url.endsWith("/responses"))?.auth).toBe("Bearer ACCESS-2");
  });

  it("10. 리프레시 토큰이 죽었으면 토큰을 지우고 재로그인을 안내한다", async () => {
    const t = await setup({
      turns: [textTurn("ok")],
      tokenBodies: [
        {
          access_token: "ACCESS-1",
          refresh_token: "REFRESH-1",
          expires_in: 3600,
          scope: "chatgpt.tokens.use.direct",
        },
        new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
      ],
    });
    await t.login();
    t.advance(3_600_000);
    await t.assistant.send("x");
    await t.assistant.idle();
    const state = await t.assistant.state();
    expect(state.signedIn).toBe(false); // 죽은 토큰은 남겨두지 않는다
    expect(state.messages.at(-1)).toMatchObject({ role: "error" });
    expect(state.messages.at(-1)?.text).toContain("다시 로그인");
    expect(t.responsesBodies()).toHaveLength(0); // 모델 호출까지 가지 않음
  });

  it("11. include가 거절되면 한 번만 빼고 다시 보낸다", async () => {
    const reject = new Response(
      JSON.stringify({ error: { code: "subscription_sharing_unsupported_capability" } }),
      { status: 400 },
    );
    const t = await setup({ turns: [reject, textTurn("ok"), textTurn("ok2")] });
    await t.login();
    await t.assistant.send("a");
    await t.assistant.idle();
    await t.assistant.send("b");
    await t.assistant.idle();
    const bodies = t.responsesBodies();
    expect(bodies.map((b) => "include" in b)).toEqual([true, false, false]);
    expect((await t.assistant.state()).messages.filter((m) => m.role === "error")).toEqual([]);
  });

  it("12. 플랜 한도 초과는 사람이 읽을 수 있는 오류로 대화에 남는다", async () => {
    const limit = new Response(
      JSON.stringify({ error: { code: "subscription_sharing_usage_limit_exceeded" } }),
      { status: 429 },
    );
    const t = await setup({ turns: [limit] });
    await t.login();
    await t.assistant.send("x");
    await t.assistant.idle();
    const last = (await t.assistant.state()).messages.at(-1);
    expect(last).toMatchObject({ role: "error" });
    expect(last?.text).toContain("한도");
  });

  it("13. 실행 중에는 새 프롬프트를 거부하고, 로그인 전에는 안내 오류로 끝난다", async () => {
    const t = await setup();
    await t.assistant.send("x"); // 로그인 안 함
    await expect(t.assistant.send("y")).rejects.toThrow("assistant_busy");
    await t.assistant.idle();
    expect((await t.assistant.state()).messages.at(-1)?.text).toContain("로그인");
  });

  it("14. 모델이 도구만 계속 부르면 단계 상한에서 멈춘다", async () => {
    const turns = Array.from({ length: 45 }, (_, i) => callTurn("read_page", {}, `c${i}`));
    const t = await setup({ turns });
    await t.login();
    await t.assistant.send("x");
    await t.assistant.idle();
    expect(t.responsesBodies()).toHaveLength(40);
    expect((await t.assistant.state()).messages.at(-1)?.text).toContain("상한");
  });

  it("15. 새 대화는 기록을 비우고, 연결 해제는 토큰까지 지운다", async () => {
    const t = await setup({ turns: [textTurn("ok")] });
    await t.login();
    await t.assistant.send("x");
    await t.assistant.idle();
    await t.assistant.reset();
    expect((await t.assistant.state()).messages).toEqual([]);
    await t.assistant.logout();
    expect((await t.assistant.state()).signedIn).toBe(false);
    expect(await t.kv.get("assistant:tokens")).toBeNull();
  });
});
