import type { PaymentMethod } from "@autopay/shared";
import type { Kv } from "../platform/kv.js";

// 감시 엔진 (docs/spec/watch.md). 지정가 모니터링 → 조건 충족 시 트리거.
// 감시는 "타이밍"만 실행한다 — 스스로 결제를 완료하지 않고, 트리거된 결제는
// 반드시 정책 게이트를 거친다. maxPrice는 정책 위에 얹는 사용자 상한.

export type WatchStatus = "watching" | "condition_met" | "purchased" | "paused" | "failed";

export interface WatchSpec {
  id: string;
  productRef: string;
  title: string;
  maxPrice: number;
  freeShippingOnly: boolean;
  buyOnRestock: boolean;
  method: PaymentMethod;
  status: WatchStatus;
  lastCheckedAt?: string;
  lastPrice?: number;
}

export interface Observed {
  price: number;
  inStock: boolean;
  freeShipping: boolean;
}

export interface PriceReader {
  read(productRef: string): Promise<Observed>;
}

// 조건 충족 시 호출되는 핸드오프(브로커/에이전트가 결제로 이어감).
// true 반환 = 구매 성공(감시 종료), false/throw = 미구매(watching 유지).
export type OnConditionMet = (watch: WatchSpec, observed: Observed) => Promise<boolean>;

const KEY = "watches";

export class WatchEngine {
  constructor(
    private readonly kv: Kv,
    private readonly reader: PriceReader,
    private readonly onConditionMet: OnConditionMet,
    private readonly now: () => Date = () => new Date(),
    private readonly idgen: () => string = () => crypto.randomUUID(),
  ) {}

  private async all(): Promise<WatchSpec[]> {
    return (await this.kv.get<WatchSpec[]>(KEY)) ?? [];
  }
  private async save(list: WatchSpec[]): Promise<void> {
    await this.kv.set(KEY, list);
  }

  async add(spec: Omit<WatchSpec, "id" | "status">): Promise<WatchSpec> {
    const watch: WatchSpec = { ...spec, id: this.idgen(), status: "watching" };
    const list = await this.all();
    list.push(watch);
    await this.save(list);
    return watch;
  }

  async list(): Promise<WatchSpec[]> {
    return this.all();
  }

  async remove(id: string): Promise<void> {
    await this.save((await this.all()).filter((w) => w.id !== id));
  }

  async pause(id: string, paused: boolean): Promise<void> {
    await this.update(id, (w) => {
      if (w.status === "purchased") return; // 1회성 구매 완료는 되살리지 않음
      w.status = paused ? "paused" : "watching";
    });
  }

  private readonly checking = new Set<string>(); // 동시 check 중복 트리거 방지

  /** 한 항목의 현재가·재고 확인 → 조건 평가 → 충족 시 트리거. */
  async check(id: string): Promise<void> {
    if (this.checking.has(id)) return;
    this.checking.add(id);
    try {
      await this.checkInner(id);
    } finally {
      this.checking.delete(id);
    }
  }

  private async checkInner(id: string): Promise<void> {
    const start = (await this.all()).find((w) => w.id === id);
    if (!start || start.status === "paused" || start.status === "purchased") return;

    const observed = await this.reader.read(start.productRef);
    const met = meetsCondition(start, observed);
    const now = this.now().toISOString();

    // 상태 쓰기는 항상 최신 목록에 대해 개별 항목만 갱신(실행 중 pause/remove가
    // stale 목록에 덮어써지지 않게).
    await this.update(id, (w) => {
      w.lastCheckedAt = now;
      w.lastPrice = observed.price;
      if (met && w.status !== "purchased") w.status = "condition_met";
    });
    if (!met) {
      await this.update(id, (w) => {
        if (w.status === "condition_met") w.status = "watching";
      });
      return;
    }

    let purchased = false;
    try {
      purchased = await this.onConditionMet({ ...start }, observed);
    } catch {
      purchased = false;
    }
    await this.update(id, (w) => {
      // 트리거 중 제거/일시정지됐다면 존중(재개하지 않음).
      if (w.status === "paused" || w.status === "purchased") return;
      w.status = purchased ? "purchased" : "watching";
    });
  }

  private async update(id: string, mut: (w: WatchSpec) => void): Promise<void> {
    const list = await this.all();
    const w = list.find((x) => x.id === id);
    if (!w) return;
    mut(w);
    await this.save(list);
  }
}

/** 조건: 유효 가격 + 재고 있음 + 현재가 ≤ maxPrice + (무료배송 요구 시 충족).
 *  가격이 NaN/음수/비유한이면 fail-closed(미충족) — 파싱 실패로 결제 유발 금지. */
export function meetsCondition(watch: WatchSpec, o: Observed): boolean {
  if (!Number.isFinite(o.price) || o.price < 0) return false;
  if (!o.inStock) return false; // 품절이면 미충족(재입고 대기)
  if (o.price > watch.maxPrice) return false;
  if (watch.freeShippingOnly && !o.freeShipping) return false;
  return true;
}
