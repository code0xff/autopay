import type { AuditRecord } from "@autopay/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryKv } from "../platform/kv.js";
import { KvAuditLog } from "./audit-log.js";

const rec = (over: Partial<AuditRecord> & Pick<AuditRecord, "id" | "at">): AuditRecord => ({
  merchant: { origin: "https://shop.example", name: "Shop" },
  amount: 10_000,
  method: "kakaopay",
  decision: { type: "allow" },
  outcome: "approved",
  ...over,
});

describe("KvAuditLog", () => {
  let log: KvAuditLog;
  beforeEach(() => {
    log = new KvAuditLog(new MemoryKv());
  });

  it("1. append 후 list로 조회됨", async () => {
    await log.append(rec({ id: "a", at: "2026-09-02T10:00:00+09:00" }));
    const all = await log.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe("a");
  });

  it("2. approved 2건(20k,30k) 같은 날 → spentToday=50k, countToday=2", async () => {
    const now = new Date("2026-09-02T23:00:00+09:00");
    await log.append(rec({ id: "a", at: "2026-09-02T09:00:00+09:00", amount: 20_000 }));
    await log.append(rec({ id: "b", at: "2026-09-02T12:00:00+09:00", amount: 30_000 }));
    expect(await log.usageFor(now)).toEqual({
      spentToday: 50_000,
      spentThisMonth: 50_000,
      countToday: 2,
    });
  });

  it("3. rejected는 usage에 반영 안 됨", async () => {
    const now = new Date("2026-09-02T23:00:00+09:00");
    await log.append(rec({ id: "a", at: "2026-09-02T09:00:00+09:00", amount: 20_000 }));
    await log.append(
      rec({
        id: "b",
        at: "2026-09-02T10:00:00+09:00",
        amount: 99_000,
        outcome: "rejected",
        decision: { type: "deny", violation: "over_daily" },
      }),
    );
    expect(await log.usageFor(now)).toEqual({
      spentToday: 20_000,
      spentThisMonth: 20_000,
      countToday: 1,
    });
  });

  it("4. 지난달 건은 spentThisMonth·spentToday 미포함", async () => {
    const now = new Date("2026-09-02T12:00:00+09:00");
    await log.append(rec({ id: "a", at: "2026-08-15T12:00:00+09:00", amount: 50_000 }));
    expect(await log.usageFor(now)).toEqual({
      spentToday: 0,
      spentThisMonth: 0,
      countToday: 0,
    });
  });

  it("5. 자정 경계: 어제 vs 오늘 분리 집계", async () => {
    const now = new Date("2026-09-02T00:30:00+09:00");
    await log.append(rec({ id: "y", at: "2026-09-01T23:59:00+09:00", amount: 10_000 }));
    await log.append(rec({ id: "t", at: "2026-09-02T00:10:00+09:00", amount: 20_000 }));
    const u = await log.usageFor(now);
    expect(u.spentToday).toBe(20_000);
    expect(u.countToday).toBe(1);
    expect(u.spentThisMonth).toBe(30_000);
  });

  it("6. 동일 id 중복 append → 이중 계상 없음", async () => {
    const now = new Date("2026-09-02T12:00:00+09:00");
    const r = rec({ id: "dup", at: "2026-09-02T09:00:00+09:00", amount: 10_000 });
    await log.append(r);
    await log.append(r);
    const u = await log.usageFor(now);
    expect(u.countToday).toBe(1);
    expect(u.spentToday).toBe(10_000);
    expect(await log.list()).toHaveLength(1);
  });

  it("7. list since/limit 필터", async () => {
    await log.append(rec({ id: "a", at: "2026-09-01T09:00:00+09:00" }));
    await log.append(rec({ id: "b", at: "2026-09-02T09:00:00+09:00" }));
    await log.append(rec({ id: "c", at: "2026-09-03T09:00:00+09:00" }));
    const since = await log.list({ since: "2026-09-02T00:00:00+09:00" });
    expect(since.map((r) => r.id)).toEqual(["c", "b"]); // 최신순
    expect(await log.list({ limit: 1 })).toHaveLength(1);
  });
});
