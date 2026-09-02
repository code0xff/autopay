import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryKv } from "../platform/kv.js";
import { type Observed, WatchEngine, type WatchSpec } from "./watch-engine.js";

const baseSpec = {
  productRef: "https://coupang.com/p/1",
  title: "USB-C 허브",
  maxPrice: 25_000,
  freeShippingOnly: true,
  buyOnRestock: false,
  method: "coupay" as const,
};

const reader = (o: Observed) => ({ read: vi.fn().mockResolvedValue(o) });
const okObserved: Observed = { price: 23_500, inStock: true, freeShipping: true };

let idn = 0;
const idgen = () => `w${++idn}`;
const now = () => new Date("2026-09-02T12:00:00+09:00");

describe("WatchEngine", () => {
  beforeEach(() => {
    idn = 0;
  });

  it("1. 조건 충족 → onConditionMet 호출, 구매 성공 시 purchased", async () => {
    const met = vi.fn().mockResolvedValue(true);
    const eng = new WatchEngine(new MemoryKv(), reader(okObserved), met, now, idgen);
    const w = await eng.add(baseSpec);
    await eng.check(w.id);
    expect(met).toHaveBeenCalledOnce();
    expect((await eng.list())[0]?.status).toBe("purchased");
  });

  it("2. 현재가 > maxPrice → 트리거 없음, watching 유지", async () => {
    const met = vi.fn();
    const eng = new WatchEngine(
      new MemoryKv(),
      reader({ price: 30_000, inStock: true, freeShipping: true }),
      met,
      now,
      idgen,
    );
    const w = await eng.add(baseSpec);
    await eng.check(w.id);
    expect(met).not.toHaveBeenCalled();
    const saved = (await eng.list())[0] as WatchSpec;
    expect(saved.status).toBe("watching");
    expect(saved.lastPrice).toBe(30_000);
  });

  it("3. freeShippingOnly=true, 유료배송 → 미충족", async () => {
    const met = vi.fn();
    const eng = new WatchEngine(
      new MemoryKv(),
      reader({ price: 20_000, inStock: true, freeShipping: false }),
      met,
      now,
      idgen,
    );
    const w = await eng.add(baseSpec);
    await eng.check(w.id);
    expect(met).not.toHaveBeenCalled();
  });

  it("4. 재고 없음 + buyOnRestock=false → 대기(미충족)", async () => {
    const met = vi.fn();
    const eng = new WatchEngine(
      new MemoryKv(),
      reader({ price: 10_000, inStock: false, freeShipping: true }),
      met,
      now,
      idgen,
    );
    const w = await eng.add(baseSpec);
    await eng.check(w.id);
    expect(met).not.toHaveBeenCalled();
  });

  it("5. 조건 충족이나 트리거 실패(정책 deny 등) → watching 복귀", async () => {
    const met = vi.fn().mockResolvedValue(false);
    const eng = new WatchEngine(new MemoryKv(), reader(okObserved), met, now, idgen);
    const w = await eng.add(baseSpec);
    await eng.check(w.id);
    expect((await eng.list())[0]?.status).toBe("watching");
  });

  it("6. pause 후 check → 트리거 없음", async () => {
    const met = vi.fn();
    const eng = new WatchEngine(new MemoryKv(), reader(okObserved), met, now, idgen);
    const w = await eng.add(baseSpec);
    await eng.pause(w.id, true);
    await eng.check(w.id);
    expect(met).not.toHaveBeenCalled();
    expect((await eng.list())[0]?.status).toBe("paused");
  });

  it("8. 가격 파싱 실패(NaN)·음수 → fail-closed(미충족)", async () => {
    const metNaN = vi.fn();
    const engNaN = new WatchEngine(
      new MemoryKv(),
      reader({ price: Number.NaN, inStock: true, freeShipping: true }),
      metNaN,
      now,
      idgen,
    );
    const wa = await engNaN.add(baseSpec);
    await engNaN.check(wa.id);
    expect(metNaN).not.toHaveBeenCalled();

    const metNeg = vi.fn();
    const engNeg = new WatchEngine(
      new MemoryKv(),
      reader({ price: -1, inStock: true, freeShipping: true }),
      metNeg,
      now,
      idgen,
    );
    const wb = await engNeg.add(baseSpec);
    await engNeg.check(wb.id);
    expect(metNeg).not.toHaveBeenCalled();
  });

  it("7. add/list/remove", async () => {
    const eng = new WatchEngine(new MemoryKv(), reader(okObserved), vi.fn(), now, idgen);
    const w = await eng.add(baseSpec);
    expect(await eng.list()).toHaveLength(1);
    await eng.remove(w.id);
    expect(await eng.list()).toHaveLength(0);
  });
});
