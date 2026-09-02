import type { Kv } from "./kv.js";

// chrome.storage.local 기반 Kv 어댑터(익스텐션 런타임). 테스트는 MemoryKv 사용.
export class ChromeKv implements Kv {
  constructor(private readonly area: chrome.storage.StorageArea = chrome.storage.local) {}

  async get<T>(key: string): Promise<T | undefined> {
    const res = await this.area.get(key);
    return res[key] as T | undefined;
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.area.set({ [key]: value });
  }
}
