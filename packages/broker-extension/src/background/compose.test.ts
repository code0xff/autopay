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
    const bg = new Background(new MemoryKv());
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
    expect(state.policy.limits.perTransaction).toBe(0); // deny 지향 기본값
  });

  it("잘못된 정책(스키마 위반) → 저장 거부", async () => {
    const bg = new Background(new MemoryKv());
    const res = await bg.handle({ type: "setPolicy", policy: { limits: { perTransaction: -1 } } });
    expect(res).toEqual({ ok: false, error: "invalid_request" });
  });
});
