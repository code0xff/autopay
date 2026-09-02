import { beforeEach, describe, expect, it } from "vitest";
import { MemoryKv } from "../platform/kv.js";
import { WebCryptoRefStore, deriveKey } from "./refstore.js";

const SALT = new Uint8Array(16).fill(7);
const keyA = () => deriveKey("passphrase-A", SALT);
const keyB = () => deriveKey("passphrase-B", SALT);

describe("WebCryptoRefStore", () => {
  let kv: MemoryKv;
  let store: WebCryptoRefStore;
  beforeEach(() => {
    kv = new MemoryKv();
    store = new WebCryptoRefStore(kv, keyA);
  });

  it("1. setProfile 후 저장소 원문에 평문 PII 없음(암호문만)", async () => {
    await store.setProfile({ phone: "01012345678", birth: "19900101" });
    const raw = JSON.stringify(await kv.get("refstore:profile"));
    expect(raw).not.toContain("01012345678");
    expect(raw).not.toContain("19900101");
    expect(raw).toContain("ct"); // sealed 구조
  });

  it("2. getIdentity 라운드트립", async () => {
    await store.setProfile({ phone: "01012345678", birth: "19900101" });
    expect(await store.getIdentity()).toEqual({ phone: "01012345678", birth: "19900101" });
  });

  it("3. 잘못된 키 → 복호화 실패(값 노출 없이)", async () => {
    await store.setProfile({ phone: "01012345678", birth: "19900101" });
    const wrong = new WebCryptoRefStore(kv, keyB);
    await expect(wrong.getIdentity()).rejects.toBeDefined();
  });

  it("4. hasProfile 은 값 노출 없이 boolean", async () => {
    expect(await store.hasProfile()).toBe(false);
    await store.setProfile({ phone: "01000000000", birth: "20000101" });
    expect(await store.hasProfile()).toBe(true);
  });

  it("5. 프로필 미설정 시 getIdentity → null", async () => {
    expect(await store.getIdentity()).toBeNull();
  });

  it("6. billing ref 라운드트립 + 평문 미노출", async () => {
    await store.setBillingRef("kakaopay", "SID-XYZ-123");
    const raw = JSON.stringify(await kv.get("refstore:billing:kakaopay"));
    expect(raw).not.toContain("SID-XYZ-123");
    expect(await store.getBillingRef("kakaopay")).toBe("SID-XYZ-123");
    expect(await store.getBillingRef("tosspay")).toBeNull();
  });
});
