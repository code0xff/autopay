import react from "@vitejs/plugin-react";
import { defineConfig } from "wxt";

// MV3 매니페스트 (docs/spec/manifest.md). 권한 최소·명시, debugger 미사용,
// host는 payment-flows 화이트리스트(placeholder — 실캡처로 확정).
export default defineConfig({
  srcDir: ".",
  manifest: {
    name: "AutoPay",
    description: "자율 지출 거버넌스 — 정책·감사·격리 하에 에이전트 결제",
    permissions: ["sidePanel", "notifications", "storage", "alarms", "scripting", "tabs"],
    host_permissions: [
      "https://*.coupang.com/*",
      "https://online-payment.kakaopay.com/*",
      "https://pay.toss.im/*",
    ],
    action: { default_title: "AutoPay" },
  },
  vite: () => ({ plugins: [react()] }),
});
