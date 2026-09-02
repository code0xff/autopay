import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@autopay/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // 정책 엔진은 순수 함수 — 100% 커버리지 목표 (docs/spec/policy.md §5)
      include: ["src/policy/engine.ts"],
      thresholds: { 100: true },
    },
  },
});
