// 저장소 추상화 — 테스트는 MemoryKv, 익스텐션 런타임은 chrome.storage 어댑터.
// 코어 모듈이 chrome API에 직접 의존하지 않게 해 순수 유닛 테스트를 가능케 한다.

export interface Kv {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
}

export class MemoryKv implements Kv {
  private store = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    const v = this.store.get(key);
    // 저장 시 구조를 복제해 외부 변형이 내부 상태에 새지 않게 한다.
    return v === undefined ? undefined : (structuredClone(v) as T);
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.store.set(key, structuredClone(value));
  }
}
