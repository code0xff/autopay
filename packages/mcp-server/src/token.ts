import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// 브리지 토큰 저장(docs/spec/mcp-integration.md §5) — 0600 로컬 파일.
// 임의 로컬 프로세스·페이지가 익스텐션인 척 접속하는 것을 막는 공유키.

export interface TokenStore {
  read(): Promise<string | null>;
  write(token: string): Promise<void>;
}

export function defaultTokenPath(): string {
  return join(homedir(), ".autopay", "bridge-token");
}

export class FileTokenStore implements TokenStore {
  constructor(private readonly path: string = defaultTokenPath()) {}

  async read(): Promise<string | null> {
    try {
      const content = (await readFile(this.path, "utf8")).trim();
      return content.length >= 16 ? content : null;
    } catch {
      return null;
    }
  }

  async write(token: string): Promise<void> {
    await mkdir(join(this.path, ".."), { recursive: true, mode: 0o700 });
    await writeFile(this.path, token, { mode: 0o600 });
  }
}

/** 저장된 토큰이 있으면 재사용, 없으면 새로 생성해 저장 후 반환. */
export async function loadOrCreateToken(store: TokenStore): Promise<string> {
  const existing = await store.read();
  if (existing) return existing;
  const token = randomBytes(32).toString("hex");
  await store.write(token);
  return token;
}
