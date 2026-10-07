import { afterEach, describe, expect, it, vi } from "vitest";
import { withTimeout } from "./timeout-fetch.js";

// signal이 abort되면 reject하는 멈춘 fetch
const hanging: typeof fetch = (_i, init) =>
  new Promise((_res, rej) => {
    init?.signal?.addEventListener("abort", () => rej(new Error("aborted")));
  });

describe("withTimeout", () => {
  afterEach(() => vi.useRealTimers());

  it("멈춘 fetch는 상한 시각에 network_timeout으로 끝난다", async () => {
    vi.useFakeTimers();
    const p = withTimeout(hanging, 1000)("https://x.test");
    const assertion = expect(p).rejects.toThrow("network_timeout");
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it("제때 응답하면 그대로 돌려주고 타이머를 정리한다", async () => {
    const ok: typeof fetch = async () => new Response("hi");
    const res = await withTimeout(ok, 1000)("https://x.test");
    expect(await res.text()).toBe("hi");
  });

  it("호출자의 signal 중지는 timeout이 아니라 원래 abort로 전달된다", async () => {
    const outer = new AbortController();
    const p = withTimeout(hanging, 60_000)("https://x.test", { signal: outer.signal });
    outer.abort();
    await expect(p).rejects.toThrow("aborted");
  });
});
