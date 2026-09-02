import type { AuditRecord, UsageSnapshot } from "@autopay/shared";
import type { Kv } from "../platform/kv.js";

// 감사 로그 (docs/spec/audit.md). 추가 전용. usage 집계의 근거.
// 비밀·PII 원문은 AuditRecord 스키마가 애초에 담지 않는다.

export interface AuditLog {
  append(record: AuditRecord): Promise<void>;
  list(opts?: { since?: string; limit?: number }): Promise<AuditRecord[]>;
  usageFor(now: Date): Promise<UsageSnapshot>;
}

const KEY = "audit";

export class KvAuditLog implements AuditLog {
  constructor(
    private readonly kv: Kv,
    private readonly key = KEY,
  ) {}

  private async all(): Promise<AuditRecord[]> {
    return (await this.kv.get<AuditRecord[]>(this.key)) ?? [];
  }

  async append(record: AuditRecord): Promise<void> {
    const records = await this.all();
    // 같은 id 중복 append는 무시(사용량 이중 계상 방지 — 추가 전용 무결성).
    if (records.some((r) => r.id === record.id)) return;
    records.push(record);
    await this.kv.set(this.key, records);
  }

  async list(opts?: { since?: string; limit?: number }): Promise<AuditRecord[]> {
    let records = await this.all();
    if (opts?.since) {
      const since = opts.since;
      records = records.filter((r) => r.at >= since);
    }
    // 최신순
    records.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    if (opts?.limit !== undefined) records = records.slice(0, opts.limit);
    return records;
  }

  /** approved 건만 합산. 오늘/이번달/오늘 건수. 로컬 타임존 기준. */
  async usageFor(now: Date): Promise<UsageSnapshot> {
    const records = await this.all();
    let spentToday = 0;
    let spentThisMonth = 0;
    let countToday = 0;
    for (const r of records) {
      if (r.outcome !== "approved") continue;
      const at = new Date(r.at);
      if (sameMonth(at, now)) spentThisMonth += r.amount;
      if (sameDay(at, now)) {
        spentToday += r.amount;
        countToday += 1;
      }
    }
    return { spentToday, spentThisMonth, countToday };
  }
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function sameMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}
