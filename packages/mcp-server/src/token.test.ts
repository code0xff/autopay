import { describe, expect, it, vi } from "vitest";
import { type TokenStore, loadOrCreateToken } from "./token.js";

// docs/spec/mcp-integration.md §5 테스트 케이스

function fakeStore(initial: string | null = null): TokenStore & { written: string[] } {
  let value = initial;
  const written: string[] = [];
  return {
    written,
    read: vi.fn(async () => value),
    write: vi.fn(async (token: string) => {
      value = token;
      written.push(token);
    }),
  };
}

describe("loadOrCreateToken", () => {
  it("1. 저장된 토큰이 없으면 새로 생성해 저장 후 반환", async () => {
    const store = fakeStore(null);
    const token = await loadOrCreateToken(store);
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(store.written).toEqual([token]);
  });

  it("2. 저장된 토큰이 있으면 재사용하고 새로 쓰지 않음", async () => {
    const store = fakeStore("existing-token-abcdefghijklmnop");
    const token = await loadOrCreateToken(store);
    expect(token).toBe("existing-token-abcdefghijklmnop");
    expect(store.written).toEqual([]);
  });

  it("3. 매번 다른 토큰을 생성한다(추측 방지)", async () => {
    const a = await loadOrCreateToken(fakeStore(null));
    const b = await loadOrCreateToken(fakeStore(null));
    expect(a).not.toBe(b);
  });
});
