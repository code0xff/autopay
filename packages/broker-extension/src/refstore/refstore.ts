import type { Kv } from "../platform/kv.js";

// 참조 저장소 (docs/spec/refstore.md). PII(휴대폰/생년월일)·빌링키 참조를
// WebCrypto AES-GCM으로 암호화 저장. 원시 카드번호·CVV·비밀번호·로그인 자격증명
// 저장 금지. getIdentity/getBillingRef는 executor 내부 전용 — API·로그로 반환 금지.

export interface Identity {
  phone: string;
  birth: string;
}

export interface RefStore {
  setProfile(id: Identity): Promise<void>;
  getIdentity(): Promise<Identity | null>;
  hasProfile(): Promise<boolean>;
  setBillingRef(methodId: string, ref: string): Promise<void>;
  getBillingRef(methodId: string): Promise<string | null>;
}

interface Sealed {
  v: 1;
  iv: string; // base64
  ct: string; // base64
}

const PROFILE_KEY = "refstore:profile";
const BILLING_PREFIX = "refstore:billing:";

export class WebCryptoRefStore implements RefStore {
  constructor(
    private readonly kv: Kv,
    // 키는 저장소 밖(패스프레이즈 파생/OS 키체인)에서 공급. refstore는 보관 안 함.
    private readonly getKey: () => Promise<CryptoKey>,
  ) {}

  async setProfile(id: Identity): Promise<void> {
    await this.kv.set(PROFILE_KEY, await this.seal(id));
  }

  async getIdentity(): Promise<Identity | null> {
    const sealed = await this.kv.get<Sealed>(PROFILE_KEY);
    if (!sealed) return null;
    return this.open<Identity>(sealed);
  }

  async hasProfile(): Promise<boolean> {
    return (await this.kv.get<Sealed>(PROFILE_KEY)) !== undefined;
  }

  async setBillingRef(methodId: string, ref: string): Promise<void> {
    await this.kv.set(BILLING_PREFIX + methodId, await this.seal({ ref }));
  }

  async getBillingRef(methodId: string): Promise<string | null> {
    const sealed = await this.kv.get<Sealed>(BILLING_PREFIX + methodId);
    if (!sealed) return null;
    return (await this.open<{ ref: string }>(sealed)).ref;
  }

  private async seal(obj: unknown): Promise<Sealed> {
    const key = await this.getKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode(JSON.stringify(obj));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      data as BufferSource,
    );
    return { v: 1, iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
  }

  private async open<T>(sealed: Sealed): Promise<T> {
    const key = await this.getKey();
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64(sealed.iv) as BufferSource },
      key,
      fromB64(sealed.ct) as BufferSource,
    );
    return JSON.parse(new TextDecoder().decode(pt)) as T;
  }
}

/** 사용자 패스프레이즈 → PBKDF2 → AES-GCM 키. 키는 저장하지 않는다. */
export async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase) as BufferSource,
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: 210_000, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}
