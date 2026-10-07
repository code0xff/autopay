import type { BridgeToolCall, BridgeToolResult } from "@autopay/shared";
import type { Kv } from "../platform/kv.js";
import type { Sealed } from "../refstore/refstore.js";
import { ASSISTANT_PROMPT } from "./prompt.js";
import {
  ApiError,
  type FunctionCallItem,
  type ModelInfo,
  type ResponseItem,
  createResponse,
  listModels,
} from "./responses.js";
import {
  type PendingLogin,
  SiwcError,
  type TokenSet,
  beginLogin,
  exchangeCode,
  isCallbackFor,
  parseCallback,
  refreshTokens,
} from "./siwc.js";
import { ASSISTANT_TOOLS, toBridgeCall } from "./tools.js";

// 내장 어시스턴트(docs/spec/assistant.md) — 사이드패널에서 받은 프롬프트를 ChatGPT 플랜
// (SIWC)으로 실행한다. 모델은 **신뢰하지 않는 에이전트**다: 할 수 있는 일은 MCP 브리지와
// 같은 BridgeTools 7개뿐이고, 토큰·정책·감사에는 손댈 수 없다. 이 클래스가 쥔 비밀은
// OAuth 토큰뿐이며 봉인 저장하고 모델·UI·로그 어디로도 내보내지 않는다.

const CLIENT_KEY = "assistant:client"; // { clientId, hostId } — 비밀 아님(공개 클라이언트)
const TOKENS_KEY = "assistant:tokens"; // Sealed<TokenSet>
const MODEL_KEY = "assistant:model";
const LOGIN_KEY = "assistant:login"; // 세션(메모리) — 진행 중인 로그인의 PKCE 상태
const CHAT_KEY = "assistant:chat"; // 세션(메모리) — 대화. 브라우저를 닫으면 사라진다

const MAX_STEPS = 40; // 한 프롬프트당 모델 호출 상한(폭주·플랜 소진 방지)
const MAX_TOOL_OUTPUT = 16_000; // 도구 결과를 모델에 넘길 때의 글자 상한
const MAX_MESSAGES = 200;
const PENDING_POLL_DELAY_MS = 5_000; // 결제 대기 중 조회 간격(모델이 연타하지 않게)
const REFRESH_MARGIN_MS = 60_000;

export interface ChatMessage {
  role: "user" | "assistant" | "tool" | "error";
  text: string;
}

export interface AssistantState {
  signedIn: boolean;
  loginPending: boolean;
  loginError: string | null;
  running: boolean;
  model: string | null;
  models: ModelInfo[];
  messages: ChatMessage[];
}

interface Chat {
  messages: ChatMessage[];
  history: unknown[]; // 모델에 다시 보낼 input(사용자·모델 출력·도구 결과)
}

interface ClientReg {
  clientId: string | null;
  hostId: string;
}

export interface AssistantDeps {
  kv: Kv;
  session: Kv;
  seal: (obj: unknown) => Promise<Sealed>;
  open: <T>(sealed: Sealed) => Promise<T>;
  tools: { handle(call: BridgeToolCall): Promise<BridgeToolResult> };
  fetch: typeof fetch;
  openTab: (url: string) => Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const ERROR_TEXT: Record<string, string> = {
  not_signed_in: "ChatGPT에 로그인되어 있지 않습니다. 설정 탭에서 로그인하세요.",
  reauth_required: "ChatGPT 로그인이 만료됐습니다. 설정 탭에서 다시 로그인하세요.",
  access_denied: "ChatGPT에서 권한 요청이 거절됐습니다.",
  plan_usage_not_granted: "ChatGPT 플랜 사용 권한이 부여되지 않았습니다.",
  state_mismatch: "로그인 응답이 이 요청과 일치하지 않습니다. 다시 시도하세요.",
  subscription_sharing_usage_limit_exceeded:
    "ChatGPT 플랜 사용 한도에 도달했습니다. ChatGPT 설정에서 한도를 확인하세요.",
  subscription_sharing_user_not_eligible: "이 ChatGPT 계정은 플랜 사용 대상이 아닙니다.",
  subscription_sharing_unsupported_capability:
    "ChatGPT가 이 요청(모델 또는 도구)을 지원하지 않습니다.",
  subscription_sharing_invalid_user: "ChatGPT 계정 확인에 실패했습니다. 다시 로그인하세요.",
  max_steps: "단계 상한에 도달해 멈췄습니다. 이어서 진행하려면 다시 요청하세요.",
  stopped: "중단했습니다.",
};

function errorCode(e: unknown): string {
  if (e instanceof SiwcError) return e.code;
  if (e instanceof ApiError) return e.status === 401 ? "reauth_required" : e.code;
  if (e instanceof Error && e.name === "AbortError") return "stopped";
  return e instanceof Error ? e.message : "unknown_error";
}

const describe = (code: string) => ERROR_TEXT[code] ?? `오류: ${code}`;

export class Assistant {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private running: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private refreshing: Promise<TokenSet> | null = null;
  private includeReasoning = true;
  private models: ModelInfo[] = [];
  private loginError: string | null = null;
  private streaming = ""; // 진행 중인 답변(완료되면 messages로 옮긴다)

  constructor(private readonly deps: AssistantDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  // ── 로그인 ──────────────────────────────────────────────────────────────

  /** 인가 URL을 만들어 새 탭으로 연다. 콜백은 handleCallbackUrl이 받는다. */
  async startLogin(): Promise<void> {
    const reg = await this.clientReg();
    const { url, pending } = await beginLogin({ clientId: reg.clientId, hostId: reg.hostId });
    await this.deps.session.set(LOGIN_KEY, pending);
    this.loginError = null;
    await this.deps.openTab(url);
  }

  /** 탭 URL이 진행 중인 로그인의 콜백이면 처리하고 true(호출부가 탭을 닫는다). */
  async handleCallbackUrl(url: string): Promise<boolean> {
    const pending = await this.deps.session.get<PendingLogin | null>(LOGIN_KEY);
    if (!pending || !isCallbackFor(url, pending)) return false;
    await this.deps.session.set(LOGIN_KEY, null); // code는 1회용 — 재처리 방지
    try {
      const cb = parseCallback(url, pending);
      const tokens = await exchangeCode(this.deps.fetch, pending, cb, this.now());
      const reg = await this.clientReg();
      await this.deps.kv.set(CLIENT_KEY, { ...reg, clientId: cb.clientId });
      await this.saveTokens(tokens);
      this.loginError = null;
      this.models = [];
    } catch (e) {
      this.loginError = describe(errorCode(e));
    }
    return true;
  }

  async logout(): Promise<void> {
    this.stop();
    await this.deps.kv.set(TOKENS_KEY, null);
    await this.deps.session.set(LOGIN_KEY, null);
    await this.deps.session.set(CHAT_KEY, null);
    this.models = [];
    this.loginError = null;
  }

  private async clientReg(): Promise<ClientReg> {
    const saved = await this.deps.kv.get<ClientReg>(CLIENT_KEY);
    if (saved) return saved;
    // ext_agent_host_id는 이 설치본을 가리키는 고정 식별자 — 첫 로그인 전에 정해 보존한다.
    const reg: ClientReg = { clientId: null, hostId: `urn:uuid:${crypto.randomUUID()}` };
    await this.deps.kv.set(CLIENT_KEY, reg);
    return reg;
  }

  private async saveTokens(tokens: TokenSet): Promise<void> {
    await this.deps.kv.set(TOKENS_KEY, await this.deps.seal(tokens));
  }

  private async loadTokens(): Promise<TokenSet | null> {
    const sealed = await this.deps.kv.get<Sealed | null>(TOKENS_KEY);
    return sealed ? this.deps.open<TokenSet>(sealed) : null;
  }

  /** 유효한 액세스 토큰. 만료가 가까우면 리프레시(회전 토큰이라 동시 요청은 하나로 합친다). */
  private async accessToken(): Promise<string> {
    const tokens = await this.loadTokens();
    if (!tokens) throw new SiwcError("not_signed_in");
    const now = this.now();
    if (tokens.expiresAt - now > REFRESH_MARGIN_MS || now < tokens.earliestRefreshAt) {
      return tokens.accessToken;
    }
    this.refreshing ??= this.doRefresh(tokens).finally(() => {
      this.refreshing = null;
    });
    return (await this.refreshing).accessToken;
  }

  private async doRefresh(tokens: TokenSet): Promise<TokenSet> {
    const { clientId } = await this.clientReg();
    if (!clientId) throw new SiwcError("not_signed_in");
    try {
      const next = await refreshTokens(this.deps.fetch, clientId, tokens.refreshToken, this.now());
      await this.saveTokens(next);
      return next;
    } catch (e) {
      // 리프레시 토큰이 죽었으면 지운다 — 다시 로그인해야 한다.
      if (errorCode(e) === "reauth_required") await this.deps.kv.set(TOKENS_KEY, null);
      throw e;
    }
  }

  // ── 상태 ────────────────────────────────────────────────────────────────

  async state(): Promise<AssistantState> {
    const signedIn = Boolean(await this.deps.kv.get<Sealed | null>(TOKENS_KEY));
    const chat = await this.chat();
    const messages = this.streaming
      ? [...chat.messages, { role: "assistant" as const, text: this.streaming }]
      : chat.messages;
    return {
      signedIn,
      loginPending: Boolean(await this.deps.session.get<PendingLogin | null>(LOGIN_KEY)),
      loginError: this.loginError,
      running: this.running !== null,
      model: (await this.deps.kv.get<string>(MODEL_KEY)) ?? null,
      models: this.models,
      messages,
    };
  }

  /** 계정이 쓸 수 있는 모델 목록을 불러온다(설정 화면용). 실패는 목록 없음으로 둔다. */
  async loadModels(): Promise<void> {
    try {
      this.models = await listModels(this.deps.fetch, await this.accessToken());
    } catch {
      this.models = [];
    }
  }

  async setModel(slug: string): Promise<void> {
    await this.deps.kv.set(MODEL_KEY, slug);
  }

  private async model(token: string): Promise<string> {
    const saved = await this.deps.kv.get<string>(MODEL_KEY);
    if (saved) return saved;
    if (this.models.length === 0) this.models = await listModels(this.deps.fetch, token);
    const first = this.models[0];
    if (!first) throw new ApiError(0, "no_model_available");
    return first.slug;
  }

  private async chat(): Promise<Chat> {
    return (await this.deps.session.get<Chat | null>(CHAT_KEY)) ?? { messages: [], history: [] };
  }

  private async saveChat(chat: Chat): Promise<void> {
    chat.messages = chat.messages.slice(-MAX_MESSAGES);
    await this.deps.session.set(CHAT_KEY, chat);
  }

  async reset(): Promise<void> {
    this.stop();
    await this.deps.session.set(CHAT_KEY, null);
  }

  // ── 실행 ────────────────────────────────────────────────────────────────

  /** 프롬프트를 접수하고 즉시 돌아온다. 진행 상황은 state()로 본다. */
  async send(text: string): Promise<void> {
    if (this.running) throw new Error("assistant_busy");
    const chat = await this.chat();
    chat.messages.push({ role: "user", text });
    chat.history.push({ role: "user", content: text });
    await this.saveChat(chat);
    this.abort = new AbortController();
    this.running = this.run(chat, this.abort.signal).finally(() => {
      this.running = null;
      this.abort = null;
      this.streaming = "";
    });
  }

  stop(): void {
    this.abort?.abort();
  }

  /** 테스트용 — 진행 중인 실행이 끝날 때까지 기다린다. */
  async idle(): Promise<void> {
    await this.running;
  }

  private async run(chat: Chat, signal: AbortSignal): Promise<void> {
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        const token = await this.accessToken();
        const model = await this.model(token);
        const result = await this.respond(token, model, chat.history, signal);
        this.streaming = "";
        chat.history.push(...result.output);
        if (result.text.trim()) chat.messages.push({ role: "assistant", text: result.text.trim() });
        const calls = result.output.filter(isFunctionCall);
        if (calls.length === 0) {
          await this.saveChat(chat);
          return;
        }
        for (const call of calls) {
          if (signal.aborted) throw new DOMException("stopped", "AbortError");
          chat.messages.push({ role: "tool", text: toolLabel(call) });
          await this.saveChat(chat);
          const output = await this.execute(call);
          chat.history.push({ type: "function_call_output", call_id: call.call_id, output });
        }
        await this.saveChat(chat);
      }
      throw new Error("max_steps");
    } catch (e) {
      chat.messages.push({ role: "error", text: describe(errorCode(e)) });
      await this.saveChat(chat);
    }
  }

  private async respond(token: string, model: string, history: unknown[], signal: AbortSignal) {
    const req = {
      token,
      model,
      input: [{ role: "developer", content: ASSISTANT_PROMPT }, ...history],
      tools: ASSISTANT_TOOLS,
      signal,
      onTextDelta: (d: string) => {
        this.streaming += d;
      },
    };
    try {
      return await createResponse(this.deps.fetch, {
        ...req,
        includeReasoning: this.includeReasoning,
      });
    } catch (e) {
      // 프리뷰가 include를 거절하면 한 번만 빼고 다시 보낸다(이후로는 계속 뺀다).
      const unsupported =
        e instanceof ApiError &&
        e.status === 400 &&
        e.code === "subscription_sharing_unsupported_capability";
      if (!unsupported || !this.includeReasoning) throw e;
      this.includeReasoning = false;
      this.streaming = "";
      return createResponse(this.deps.fetch, { ...req, includeReasoning: false });
    }
  }

  /** 도구 한 건 실행 → 모델에 돌려줄 문자열. 예외를 던지지 않는다. */
  private async execute(call: FunctionCallItem): Promise<string> {
    const bridgeCall = toBridgeCall(call.call_id, call.name, call.arguments);
    if (!bridgeCall) return JSON.stringify({ error: "invalid_tool_call" });
    const res = await this.deps.tools.handle(bridgeCall);
    if (!res.ok) return JSON.stringify({ error: res.error });
    // 결제 대기 중이면 잠깐 쉰 뒤 돌려준다 — 모델이 조회를 연타해 플랜을 태우지 않게.
    const pending =
      bridgeCall.tool === "get_payment_result" &&
      (res.result as { status?: string } | null)?.status === "pending_user_confirmation";
    if (pending) await this.sleep(PENDING_POLL_DELAY_MS);
    return JSON.stringify(res.result ?? null).slice(0, MAX_TOOL_OUTPUT);
  }
}

function isFunctionCall(item: ResponseItem): item is FunctionCallItem {
  return (
    item.type === "function_call" &&
    typeof item.call_id === "string" &&
    typeof item.name === "string" &&
    typeof item.arguments === "string"
  );
}

/** 대화창에 보여줄 도구 한 줄 요약(인자 원문 전체는 싣지 않는다). */
function toolLabel(call: FunctionCallItem): string {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
  } catch {}
  const short = (v: unknown) => String(v ?? "").slice(0, 80);
  switch (call.name) {
    case "open":
      return `페이지 열기 · ${short(args.url)}`;
    case "read_page":
      return "페이지 읽기";
    case "click":
      return `클릭 · ${short(args.selector)}`;
    case "fill":
      return `입력 · ${short(args.selector)}`;
    case "request_payment":
      return `결제 요청 · ₩${Number(args.totalAmount ?? 0).toLocaleString("ko-KR")}`;
    case "get_payment_result":
      return "결제 상태 확인";
    case "get_policy_summary":
      return "정책 확인";
    default:
      return call.name;
  }
}
