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
    // 최소 권한: 결제/쇼핑 도메인만. 로그인 등 범위 밖 하위 도메인 제외.
    // (실결제 캡처로 확정 — payment-flows.md 검증 항목)
    host_permissions: [
      "https://coupang.com/*",
      // 쿠팡 생태계 하위 도메인 전체 — www·checkout 외에 **비밀번호 키패드가 뜨는
      // 결제 iframe**(rocketpay 등)이 별도 서브도메인이라, 여기에 권한이 없으면
      // 프레임 탐지가 조용히 건너뛰어진다(2026-09-26: 비번 창이 떴는데 핸드오프
      // 통지가 안 나가고 그대로 타임아웃). 탐지는 "비밀번호 문구가 보이는가"만
      // 확인하며 입력칸 값은 읽지 않는다(executor.md §3.2 불변식).
      "https://*.coupang.com/*",
      "https://online-payment.kakaopay.com/*",
      "https://pay.toss.im/*",
    ],
    action: { default_title: "AutoPay" },
  },
  vite: () => ({ plugins: [react()] }),
});
