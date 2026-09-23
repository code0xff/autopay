#!/usr/bin/env node
// AutoPay 원커맨드 준비: 의존성 설치 → MCP 서버·익스텐션 빌드 → 브리지 토큰 준비
// (클립보드 복사) → 남은 수동 단계 안내. `pnpm bootstrap`으로 실행.
//
// 토큰은 화면·로그에 절대 출력하지 않는다 — 클립보드로만 넘기고, 클립보드 도구가
// 없으면 파일 경로만 알려준다. 형식·위치는 mcp-server/src/token.ts와 동일해야 한다
// (mcp-server가 같은 파일을 재사용).

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extDir = join(root, "packages/broker-extension/.output/chrome-mv3");
const tokenPath = join(homedir(), ".autopay", "bridge-token");

function step(n, total, title) {
  console.log(`\n[${n}/${total}] ${title}`);
}

function run(args) {
  const r = spawnSync("pnpm", args, { cwd: root, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`\n✖ 실패: pnpm ${args.join(" ")}`);
    process.exit(r.status ?? 1);
  }
}

function ensureToken() {
  try {
    const existing = readFileSync(tokenPath, "utf8").trim();
    if (existing.length >= 16) return { token: existing, created: false };
  } catch {}
  const token = randomBytes(32).toString("hex");
  mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 });
  writeFileSync(tokenPath, token, { mode: 0o600 });
  return { token, created: true };
}

function copyToClipboard(text) {
  const candidates =
    platform() === "darwin"
      ? [["pbcopy", []]]
      : platform() === "win32"
        ? [["clip", []]]
        : [
            ["wl-copy", []],
            ["xclip", ["-selection", "clipboard"]],
            ["xsel", ["--clipboard", "--input"]],
          ];
  for (const [cmd, args] of candidates) {
    const r = spawnSync(cmd, args, { input: text, stdio: ["pipe", "ignore", "ignore"] });
    if (r.status === 0) return true;
  }
  return false;
}

const TOTAL = 4;
step(1, TOTAL, "의존성 설치");
run(["install"]);

step(2, TOTAL, "MCP 서버 빌드");
run(["--filter", "@autopay/mcp-server", "build"]);

step(3, TOTAL, "브로커 익스텐션 빌드");
run(["--filter", "@autopay/broker-extension", "build"]);
if (!existsSync(join(extDir, "manifest.json"))) {
  console.error(`✖ 빌드 산출물이 없습니다: ${extDir}`);
  process.exit(1);
}

step(4, TOTAL, "브리지 토큰 준비");
const { token, created } = ensureToken();
const copied = copyToClipboard(token);
console.log(`  ${created ? "새로 생성" : "기존 토큰 재사용"} (${tokenPath}, 0600)`);
console.log(
  copied
    ? "  ✔ 토큰을 클립보드에 복사했습니다(화면에는 출력하지 않음)"
    : `  클립보드 도구가 없어 복사하지 못했습니다 — 직접 확인: cat ${tokenPath}`,
);

console.log(`
✔ 준비 완료. 남은 단계(수동, 1회):

  1. Chrome → chrome://extensions → 개발자 모드 켜기
     → "압축해제된 확장 프로그램 로드" → 아래 폴더 선택
       ${extDir}
     (이미 로드했다면 새로고침 ⟳ 만 누르면 됩니다)
  2. 툴바의 AutoPay 아이콘 → 사이드패널 "설정" 탭 → "MCP 브리지"에 토큰 붙여넣기 → 등록
     → "정책" 탭에서 결제 한도를 정하고 저장 (기본값 0원 = 전부 거절)
  3. 쿠팡에 직접 로그인 + 쿠팡 앱에서 원터치 결제 켜기
  4. 이 폴더에서 Claude Code 실행(이미 실행 중이면 재시작) → "○○ 사줘"

  사이드패널 "홈" 탭의 "시작하기" 카드가 남은 단계를 보여줍니다.
`);
