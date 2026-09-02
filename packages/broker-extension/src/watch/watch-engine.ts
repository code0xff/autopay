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
      w.status = paused ? "paused" : "watching";
    });
  }

  /** 한 항목의 현재가·재고 확인 → 조건 평가 → 충족 시 트리거. */
  async check(id: string): Promise<void> {
    const list = await this.all();
    const watch = list.find((w) => w.id === id);
    if (!watch || watch.status === "paused" || watch.status === "purchased") return;

    const observed = await this.reader.read(watch.productRef);
    watch.lastCheckedAt = this.now().toISOString();
    watch.lastPrice = observed.price;

    if (meetsCondition(watch, observed)) {
      watch.status = "condition_met";
      await this.save(list);
      let purchased = false;
      try {
        purchased = await this.onConditionMet({ ...watch }, observed);
      } catch {
        purchased = false;
      }
      // 저장 상태 재로딩(트리거 중 다른 변경 가능성 최소화)
      await this.update(id, (w) => {
        w.status = purchased ? "purchased" : "watching";
      });
    } else {
      watch.status = watch.status === "condition_met" ? "watching" : watch.status;
      await this.save(list);
    }
  }

  private async update(id: string, mut: (w: WatchSpec) => void): Promise<void> {
    const list = await this.all();
    const w = list.find((x) => x.id === id);
    if (!w) return;
    mut(w);
    await this.save(list);
  }
}

/** 조건: 재고 있음(또는 buyOnRestock 무관) + 현재가 ≤ maxPrice + (무료배송 요구 시 충족). */
export function meetsCondition(watch: WatchSpec, o: Observed): boolean {
  if (!o.inStock) return false; // 품절이면 미충족(재입고 대기)
  if (o.price > watch.maxPrice) return false;
  if (watch.freeShippingOnly && !o.freeShipping) return false;
  return true;
}
