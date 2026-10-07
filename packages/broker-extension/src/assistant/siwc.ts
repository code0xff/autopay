// Sign in with ChatGPT(SIWC) 오픈소스 흐름 — docs/spec/assistant.md §3.
// 클라이언트 시크릿이 없는 공개 클라이언트: 첫 로그인에서 동적 등록으로 client_id를
// 발급받고(PKCE S256), 이후엔 발급된 id로 재인가·리프레시한다.
// 여기 함수들은 토큰을 받아 돌려줄 뿐 저장·로그하지 않는다(보관은 assistant.ts).

export const SIWC_AUTHORIZE = "https://auth.openai.com/api/accounts/authorize";
export const SIWC_TOKEN = "https://auth.openai.com/api/accounts/oauth/token";
export const SIWC_RESOURCE = "https://api.openai.com/v1";
export const SIWC_SCOPE =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const DYNAMIC_CLIENT = "dynamic_agent_client";
const APP_NAME = "AutoPay";

export interface PendingLogin {
  verifier: string;
  state: string;
  nonce: string;
  redirectUri: string;
  clientId: string | null; // 재인가면 발급된 id, 첫 로그인이면 null
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
  earliestRefreshAt: number; // epoch ms — 이 시각 전에는 리프레시하지 않는다
}

export class SiwcError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

/** 리프레시 토큰을 더 쓸 수 없다는 뜻의 코드 — 토큰을 지우고 다시 로그인해야 한다. */
const DEAD_REFRESH = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomToken(len: number): string {
  return b64url(crypto.getRandomValues(new Uint8Array(len)));
}

/** 인가 요청을 만든다. 리다이렉트는 문서 규칙대로 `http://127.0.0.1:<PORT>/callback`
 *  (localhost 불가, 경로 고정, 포트만 가변). 익스텐션은 포트를 열 수 없으므로 그
 *  주소로의 탭 이동을 가로채 code를 읽는다 — 아무도 듣지 않는 임의 고포트를 쓴다. */
export async function beginLogin(opts: {
  clientId: string | null;
  hostId: string;
  port?: number;
}): Promise<{ url: string; pending: PendingLogin }> {
  const verifier = randomToken(32);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const port = opts.port ?? 49152 + ((crypto.getRandomValues(new Uint16Array(1))[0] ?? 0) % 16000);
  const pending: PendingLogin = {
    verifier,
    state: randomToken(16),
    nonce: randomToken(16),
    redirectUri: `http://127.0.0.1:${port}/callback`,
    clientId: opts.clientId,
  };
  const params = new URLSearchParams({
    client_id: opts.clientId ?? DYNAMIC_CLIENT,
    ext_agent_host_id: opts.hostId,
    response_type: "code",
    redirect_uri: pending.redirectUri,
    scope: SIWC_SCOPE,
    resource: SIWC_RESOURCE,
    state: pending.state,
    nonce: pending.nonce,
    code_challenge_method: "S256",
    code_challenge: b64url(new Uint8Array(digest)),
  });
  // agent_name_hint는 최초 동적 등록 요청에만 넣는다(재인가에선 생략).
  if (!opts.clientId) params.set("agent_name_hint", APP_NAME);
  return { url: `${SIWC_AUTHORIZE}?${params.toString()}`, pending };
}

/** 콜백 URL이 이 로그인 시도의 것인지. */
export function isCallbackFor(url: string, pending: PendingLogin): boolean {
  return url.startsWith(`${pending.redirectUri}?`) || url === pending.redirectUri;
}

/** 콜백 URL에서 code·client_id를 꺼낸다. state 불일치·거절은 throw. */
export function parseCallback(
  url: string,
  pending: PendingLogin,
): { code: string; clientId: string } {
  const q = new URL(url).searchParams;
  const error = q.get("error");
  if (error) throw new SiwcError(error === "access_denied" ? "access_denied" : "authorize_failed");
  if (q.get("state") !== pending.state) throw new SiwcError("state_mismatch");
  const code = q.get("code");
  const clientId = q.get("client_id") ?? pending.clientId;
  if (!code || !clientId) throw new SiwcError("callback_incomplete");
  return { code, clientId };
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  scope?: string;
  earliest_refresh_at?: number | string;
  error?: string;
}

async function tokenRequest(
  fetchFn: typeof fetch,
  form: Record<string, string>,
): Promise<TokenResponse> {
  const res = await fetchFn(SIWC_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok) {
    const code = typeof body.error === "string" ? body.error : `token_http_${res.status}`;
    throw new SiwcError(DEAD_REFRESH.has(code) ? "reauth_required" : code);
  }
  return body;
}

function toTokenSet(body: TokenResponse, now: number, prevRefresh?: string): TokenSet {
  const refreshToken = body.refresh_token ?? prevRefresh;
  if (!body.access_token || !refreshToken) throw new SiwcError("token_response_incomplete");
  const expiresAt = now + (body.expires_in ?? 3600) * 1000;
  return {
    accessToken: body.access_token,
    refreshToken,
    expiresAt,
    earliestRefreshAt: parseEpochMs(body.earliest_refresh_at) ?? 0,
  };
}

/** earliest_refresh_at은 형식이 문서에 명시돼 있지 않다 — 초/밀리초/ISO 모두 받는다. */
function parseEpochMs(v: number | string | undefined): number | null {
  if (v === undefined) return null;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/** ID 토큰의 nonce가 이 로그인 시도의 것인지 확인한다. 서명(JWKS) 검증은 하지 않는다 —
 *  토큰을 TLS로 토큰 엔드포인트에서 직접 받았고, 신원 클레임을 어떤 판단에도 쓰지
 *  않기 때문이다(플랜 사용 토큰만 쓴다). */
function checkNonce(idToken: string | undefined, nonce: string): void {
  if (!idToken) return;
  const part = idToken.split(".")[1];
  if (!part) throw new SiwcError("id_token_malformed");
  let claims: { nonce?: string };
  try {
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    claims = JSON.parse(json) as { nonce?: string };
  } catch {
    throw new SiwcError("id_token_malformed");
  }
  if (claims.nonce !== nonce) throw new SiwcError("nonce_mismatch");
}

export async function exchangeCode(
  fetchFn: typeof fetch,
  pending: PendingLogin,
  cb: { code: string; clientId: string },
  now: number,
): Promise<TokenSet> {
  const body = await tokenRequest(fetchFn, {
    grant_type: "authorization_code",
    client_id: cb.clientId,
    code: cb.code,
    code_verifier: pending.verifier,
    redirect_uri: pending.redirectUri,
    resource: SIWC_RESOURCE,
  });
  // 플랜 사용 권한이 없으면 이 토큰으로는 모델을 못 부른다 — 로그인 실패로 취급.
  if (!(body.scope ?? "").split(" ").includes(PLAN_SCOPE)) {
    throw new SiwcError("plan_usage_not_granted");
  }
  checkNonce(body.id_token, pending.nonce);
  return toTokenSet(body, now);
}

export async function refreshTokens(
  fetchFn: typeof fetch,
  clientId: string,
  refreshToken: string,
  now: number,
): Promise<TokenSet> {
  const body = await tokenRequest(fetchFn, {
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
    resource: SIWC_RESOURCE,
  });
  return toTokenSet(body, now, refreshToken); // 회전되면 새 리프레시 토큰으로 교체
}
