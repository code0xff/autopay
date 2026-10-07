#!/usr/bin/env node
import { spawn } from "node:child_process";
// SIWC(Sign in with ChatGPT) 스파이크 — 익스텐션 내장 프롬프트 기능의 전제 검증.
// 확인 대상: (1) 오픈소스 동적 등록 + PKCE 로그인이 되는가, (2) 그 토큰으로
// /v1/responses에서 **커스텀 함수 도구 왕복**이 되는가, (3) chrome-extension Origin
// 헤더가 붙어도 거절되지 않는가. 토큰은 메모리에만 두고 출력·저장하지 않는다.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";

const AUTH = "https://auth.openai.com/api/accounts/authorize";
const TOKEN = "https://auth.openai.com/api/accounts/oauth/token";
const API = "https://api.openai.com/v1";
const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

const b64url = (buf) => buf.toString("base64url");
const log = (...a) => console.log(...a);

async function login() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(16));
  const nonce = b64url(randomBytes(16));

  const { port, waitForCallback, close } = await listen();
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const url = new URL(AUTH);
  url.search = new URLSearchParams({
    client_id: "dynamic_agent_client",
    agent_name_hint: "AutoPay",
    ext_agent_host_id: `urn:uuid:${randomUUID()}`,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPE,
    resource: API,
    state,
    nonce,
    code_challenge_method: "S256",
    code_challenge: challenge,
  }).toString();

  log("[1] 브라우저에서 로그인하세요(자동으로 열립니다). 안 열리면 아래 주소를 여세요:");
  log(url.toString());
  spawn("open", [url.toString()], { stdio: "ignore", detached: true }).unref();

  const q = await waitForCallback;
  close();
  if (q.get("error"))
    throw new Error(`authorize error: ${q.get("error")} ${q.get("error_description") ?? ""}`);
  if (q.get("state") !== state) throw new Error("state mismatch");
  const clientId = q.get("client_id");
  const code = q.get("code");
  if (!clientId || !code) throw new Error(`callback missing fields: ${[...q.keys()].join(",")}`);
  log(
    `[1] 콜백 수신 OK — 파라미터: ${[...q.keys()].join(", ")} / client_id 접두사: ${clientId.slice(0, 7)}…`,
  );

  const res = await fetch(TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource: API,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`token exchange ${res.status}: ${JSON.stringify(body)}`);
  log(`[2] 토큰 교환 OK — 필드: ${Object.keys(body).join(", ")}`);
  log(
    `    scope: ${body.scope} / expires_in: ${body.expires_in} / refresh_token: ${body.refresh_token ? "있음" : "없음"}`,
  );
  if (!String(body.scope ?? "").includes("chatgpt.tokens.use.direct")) {
    throw new Error("chatgpt.tokens.use.direct 스코프가 부여되지 않음(플랜 사용 불가)");
  }
  return body.access_token;
}

function listen() {
  return new Promise((resolve) => {
    let done;
    const waitForCallback = new Promise((r) => {
      done = r;
    });
    const server = createServer((req, res) => {
      const u = new URL(req.url, "http://127.0.0.1");
      if (u.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("AutoPay 스파이크: 로그인 완료. 이 탭은 닫아도 됩니다.");
      done(u.searchParams);
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({ port: server.address().port, waitForCallback, close: () => server.close() }),
    );
  });
}

async function pickModel(token) {
  const res = await fetch(`${API}/models`, {
    // 익스텐션 서비스워커가 보낼 Origin을 흉내 — 이 헤더 때문에 거절되는지 확인.
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`models ${res.status}: ${JSON.stringify(body)}`);
  const list = (body.models ?? body.data ?? []).filter((m) => (m.visibility ?? "list") === "list");
  log(`[3] 모델 목록 OK(Origin 헤더 포함 요청) — ${list.map((m) => m.slug ?? m.id).join(", ")}`);
  if (list.length === 0)
    throw new Error(`표시 가능한 모델 없음: ${JSON.stringify(body).slice(0, 300)}`);
  return list[0].slug ?? list[0].id;
}

const TOOLS = [
  {
    type: "function",
    name: "get_policy_summary",
    description: "결제 전에 호출: 잔여 예산과 건당 한도를 조회한다.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
];

async function respond(token, model, input, extra = {}) {
  const res = await fetch(`${API}/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, input, tools: TOOLS, store: false, stream: true, ...extra }),
  });
  if (!res.ok) throw new Error(`responses ${res.status}: ${await res.text()}`);
  const events = new Set();
  let final = null;
  let text = "";
  let buf = "";
  const dec = new TextDecoder();
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
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
      const ev = JSON.parse(data);
      events.add(ev.type);
      if (ev.type === "response.output_text.delta") text += ev.delta;
      if (ev.type === "response.completed") final = ev.response;
      if (ev.type === "response.failed" || ev.type === "response.incomplete") {
        throw new Error(
          `${ev.type}: ${JSON.stringify(ev.response?.error ?? ev.response?.incomplete_details)}`,
        );
      }
    }
  }
  if (!final) throw new Error(`response.completed 미수신 — 이벤트: ${[...events].join(", ")}`);
  return { events: [...events], output: final.output ?? [], text };
}

async function toolRoundTrip(token, model) {
  const input = [
    {
      role: "user",
      content: "get_policy_summary 도구를 호출해서 건당 한도가 얼마인지 한 문장으로 알려줘.",
    },
  ];
  // store:false에서 추론 모델은 암호화된 추론 항목을 되돌려줘야 할 수 있다 — 거절되면 빼고 재시도.
  let extra = { include: ["reasoning.encrypted_content"] };
  let first;
  try {
    first = await respond(token, model, input, extra);
  } catch (e) {
    log(`    (include 포함 요청 실패 → 제외하고 재시도: ${String(e.message).slice(0, 200)})`);
    extra = {};
    first = await respond(token, model, input, extra);
  }
  log(`[4] 1차 응답 이벤트: ${first.events.join(", ")}`);
  log(`    출력 항목 타입: ${first.output.map((o) => o.type).join(", ")}`);
  const call = first.output.find((o) => o.type === "function_call");
  if (!call) throw new Error(`function_call 없음 — 텍스트: ${first.text.slice(0, 200)}`);
  log(`[4] 함수 호출 OK — name=${call.name} arguments=${call.arguments}`);

  const second = await respond(
    token,
    model,
    [
      ...input,
      ...first.output,
      {
        type: "function_call_output",
        call_id: call.call_id,
        output: JSON.stringify({ perTransactionLimit: 30000 }),
      },
    ],
    extra,
  );
  log(`[5] 도구 결과 반영 응답 OK — "${second.text.trim().slice(0, 200)}"`);
}

try {
  const token = await login();
  const model = await pickModel(token);
  log(`    사용 모델: ${model}`);
  await toolRoundTrip(token, model);
  log("\n결과: 통과 — 로그인·플랜 사용·함수 도구 왕복 모두 동작.");
  process.exit(0);
} catch (e) {
  log(`\n결과: 실패 — ${e.message}`);
  process.exit(1);
}
