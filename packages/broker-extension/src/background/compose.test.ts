import type { PaymentPolicy } from "@autopay/shared";
import { describe, expect, it } from "vitest";
import { MemoryKv } from "../platform/kv.js";
import { Background } from "./compose.js";
import type { UiState } from "./compose.js";

// RPC 저장 경로 검증 — chrome 없이 MemoryKv로 Background를 구동.
const policy: PaymentPolicy = {
  limits: { perTransaction: 50_000, daily: 100_000, monthly: 300_000, maxTransactionsPerDay: 3 },
  merchants: { mode: "allowlist", origins: ["https://coupang.com"] },
  categories: { mode: "allowlist", values: ["keyboard"] },
  methods: ["coupay", "kakaopay"],
  confirmation: { requireUserConfirmationAbove: 30_000, alwaysConfirm: false },
  notifications: { channels: ["chrome"], notifyOnRejection: true },
};

describe("Background RPC (compose)", () => {
  it("setPolicy → 저장되고 getState에 반영된다", async () => {
    const bg = new Background(new MemoryKv(), new MemoryKv());
    expect(await bg.handle({ type: "unlock", passphrase: "pw" })).toEqual({ ok: true });
    const res = await bg.handle({ type: "setPolicy", policy });
    expect(res).toEqual({ ok: true });

    const state = (await bg.handle({ type: "getState" })) as UiState;
    expect(state.policy.limits.perTransaction).toBe(50_000);
    expect(state.policy.limits.daily).toBe(100_000);
    expect(state.summary.remainingDailyBudget).toBe(100_000);
  });

  it("기본 상태는 잠김 + 가장 제한적 기본 정책", async () => {
    const bg = new Background(new MemoryKv());
    const state = (await bg.handle({ type: "getState" })) as UiState;
    expect(state.locked).toBe(true);
    expect(state.policy.limits.perTransaction).toBe(20_000); // 소액 기본 한도
  });

  it("기본 정책 — 머천트·카테고리는 예외로 완화, 한도만 여전히 deny", async () => {
    const bg = new Background(new MemoryKv());
    const state = (await bg.handle({ type: "getState" })) as UiState;
    expect(state.policy.merchants).toEqual({
      mode: "allowlist",
      origins: ["https://coupang.com", "https://www.coupang.com", "https://checkout.coupang.com"],
    });
    expect(state.policy.categories).toEqual({ mode: "denylist", values: [] }); // 전부 허용
    expect(state.policy.limits).toEqual({
      perTransaction: 20_000,
      daily: 50_000,
      monthly: 100_000,
      maxTransactionsPerDay: 3,
    });
    expect(state.policy.confirmation).toEqual({
      requireUserConfirmationAbove: 10_000,
      alwaysConfirm: false,
    });
  });

  it("잘못된 정책(스키마 위반) → 저장 거부", async () => {
    const bg = new Background(new MemoryKv());
    const res = await bg.handle({ type: "setPolicy", policy: { limits: { perTransaction: -1 } } });
    expect(res).toEqual({ ok: false, error: "invalid_request" });
  });

  // 잠금 = AutoPay 활성 스위치(docs/spec/ui.md §4.2)
  describe("잠금", () => {
    it("첫 해제는 패스프레이즈 설정 — 이후엔 틀린 패스프레이즈를 거부한다", async () => {
      const kv = new MemoryKv();
      const bg = new Background(kv, new MemoryKv());
      let state = (await bg.handle({ type: "getState" })) as UiState;
      expect(state.locked).toBe(true);
      expect(state.hasPassphrase).toBe(false);

      expect(await bg.handle({ type: "unlock", passphrase: "right" })).toEqual({ ok: true });
      state = (await bg.handle({ type: "getState" })) as UiState;
      expect(state.locked).toBe(false);
      expect(state.hasPassphrase).toBe(true);

      const fresh = new Background(kv, new MemoryKv()); // 브라우저 재시작(세션 비어 있음)
      expect(await fresh.handle({ type: "unlock", passphrase: "wrong" })).toEqual({
        ok: false,
        error: "wrong_passphrase",
      });
      expect(await fresh.handle({ type: "unlock", passphrase: "right" })).toEqual({ ok: true });
    });

    it("잠겨 있으면 getState·unlock 외 RPC는 locked로 거부", async () => {
      const bg = new Background(new MemoryKv(), new MemoryKv());
      expect(await bg.handle({ type: "setPolicy", policy })).toEqual({
        ok: false,
        error: "locked",
      });
      expect(
        await bg.handle({ type: "resolveConfirmation", requestId: "r1", approved: true }),
      ).toEqual({ ok: false, error: "locked" });
    });

    it("서비스워커가 재시작돼도 같은 브라우저 세션이면 풀린 상태를 유지", async () => {
      const kv = new MemoryKv();
      const session = new MemoryKv();
      await new Background(kv, session).handle({ type: "unlock", passphrase: "pw" });
      const restarted = new Background(kv, session);
      const state = (await restarted.handle({ type: "getState" })) as UiState;
      expect(state.locked).toBe(false);
    });

    it("lock → 즉시 잠기고 재시작한 워커도 잠긴 상태", async () => {
      const kv = new MemoryKv();
      const session = new MemoryKv();
      const bg = new Background(kv, session);
      await bg.handle({ type: "unlock", passphrase: "pw" });
      expect(await bg.handle({ type: "lock" })).toEqual({ ok: true });
      expect(((await bg.handle({ type: "getState" })) as UiState).locked).toBe(true);
      const restarted = new Background(kv, session);
      expect(((await restarted.handle({ type: "getState" })) as UiState).locked).toBe(true);
    });
  });
});
