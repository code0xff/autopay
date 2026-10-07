import { describe, expect, it, vi } from "vitest";
import {
  type PendingLogin,
  beginLogin,
  exchangeCode,
  isCallbackFor,
  parseCallback,
  refreshTokens,
} from "./siwc.js";

// SIWC 오픈소스 흐름(docs/spec/assistant.md §3). 네트워크는 주입한 fetch로 대체한다.

const HOST = "urn:uuid:00000000-0000-4000-8000-000000000000";
const jwt = (claims: object) => `h.${btoa(JSON.stringify(claims))}.s`;
const tokenFetch = (status: number, body: object) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const formOf = (f: typeof fetch) =>
  new URLSearchParams((vi.mocked(f).mock.calls[0]?.[1] as RequestInit).body as string);

async function sha256b64url(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return btoa(String.fromCharCode(...d))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

describe("beginLogin", () => {
  it("1. 첫 로그인은 동적 등록 + PKCE S256 + 127.0.0.1 콜백", async () => {
    const { url, pending } = await beginLogin({ clientId: null, hostId: HOST, port: 50123 });
    const q = new URL(url).searchParams;
    expect(url.startsWith("https://auth.openai.com/api/accounts/authorize?")).toBe(true);
    expect(q.get("client_id")).toBe("dynamic_agent_client");
    expect(q.get("agent_name_hint")).toBe("NightPay");
    expect(q.get("ext_agent_host_id")).toBe(HOST);
    expect(q.get("redirect_uri")).toBe("http://127.0.0.1:50123/callback");
    expect(q.get("resource")).toBe("https://api.openai.com/v1");
    expect(q.get("scope")).toContain("chatgpt.tokens.use.direct");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toBe(await sha256b64url(pending.verifier));
    expect(q.get("state")).toBe(pending.state);
    expect(url).not.toContain(pending.verifier); // 검증자는 URL에 실리지 않는다
  });

  it("2. 재인가는 발급된 client_id를 쓰고 agent_name_hint를 뺀다", async () => {
    const { url } = await beginLogin({ clientId: "oaiapp_x", hostId: HOST });
    const q = new URL(url).searchParams;
    expect(q.get("client_id")).toBe("oaiapp_x");
    expect(q.has("agent_name_hint")).toBe(false);
    expect(q.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  });
});

describe("콜백", () => {
  const pending: PendingLogin = {
    verifier: "v",
    state: "st",
    nonce: "n",
    redirectUri: "http://127.0.0.1:50123/callback",
    clientId: null,
  };

  it("3. 이 로그인의 주소만 콜백으로 본다(포트·경로가 다르면 아님)", () => {
    expect(isCallbackFor("http://127.0.0.1:50123/callback?code=c&state=st", pending)).toBe(true);
    expect(isCallbackFor("http://127.0.0.1:50124/callback?code=c", pending)).toBe(false);
    expect(isCallbackFor("http://127.0.0.1:50123/callback-evil?code=c", pending)).toBe(false);
  });

  it("4. code와 발급된 client_id를 꺼낸다", () => {
    const url = "http://127.0.0.1:50123/callback?code=c1&client_id=oaiapp_new&state=st";
    expect(parseCallback(url, pending)).toEqual({ code: "c1", clientId: "oaiapp_new" });
  });

  it("5. state 불일치·사용자 거절은 거부한다", () => {
    const base = "http://127.0.0.1:50123/callback";
    expect(() => parseCallback(`${base}?code=c&client_id=x&state=other`, pending)).toThrow(
      "state_mismatch",
    );
    expect(() => parseCallback(`${base}?error=access_denied&state=st`, pending)).toThrow(
      "access_denied",
    );
  });

  it("6. 토큰 교환: 플랜 스코프와 nonce를 확인한다", async () => {
    const ok = {
      access_token: "at",
      refresh_token: "rt",
      expires_in: 3600,
      scope: "openid chatgpt.tokens.use.direct",
      id_token: jwt({ nonce: "n" }),
    };
    const f = tokenFetch(200, ok);
    const t = await exchangeCode(f, pending, { code: "c1", clientId: "oaiapp_new" }, 1_000);
    expect(t).toMatchObject({ accessToken: "at", refreshToken: "rt", expiresAt: 3_601_000 });
    const form = formOf(f);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code_verifier")).toBe("v");
    expect(form.get("redirect_uri")).toBe(pending.redirectUri);

    const cb = { code: "c1", clientId: "oaiapp_new" };
    await expect(
      exchangeCode(tokenFetch(200, { ...ok, scope: "openid profile" }), pending, cb, 0),
    ).rejects.toThrow("plan_usage_not_granted");
    await expect(
      exchangeCode(tokenFetch(200, { ...ok, id_token: jwt({ nonce: "other" }) }), pending, cb, 0),
    ).rejects.toThrow("nonce_mismatch");
  });
});

describe("refreshTokens", () => {
  it("7. 회전된 토큰으로 교체하고, 새 리프레시 토큰이 없으면 기존 것을 유지한다", async () => {
    const f = tokenFetch(200, { access_token: "at2", expires_in: 60 });
    const t = await refreshTokens(f, "oaiapp_x", "rt1", 0);
    expect(t).toMatchObject({ accessToken: "at2", refreshToken: "rt1", expiresAt: 60_000 });
    expect(formOf(f).get("grant_type")).toBe("refresh_token");
    expect(formOf(f).get("client_id")).toBe("oaiapp_x");
    const rotated = await refreshTokens(
      tokenFetch(200, { access_token: "at3", refresh_token: "rt2" }),
      "oaiapp_x",
      "rt1",
      0,
    );
    expect(rotated.refreshToken).toBe("rt2");
  });

  it("8. 죽은 리프레시 토큰은 reauth_required로 수렴한다", async () => {
    for (const error of ["invalid_grant", "refresh_token_reused", "refresh_token_expired"]) {
      await expect(refreshTokens(tokenFetch(400, { error }), "c", "rt", 0)).rejects.toThrow(
        "reauth_required",
      );
    }
    await expect(
      refreshTokens(tokenFetch(503, { error: "temporarily_unavailable" }), "c", "rt", 0),
    ).rejects.toThrow("temporarily_unavailable");
  });
});
