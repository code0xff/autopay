import { Background } from "../src/background/compose.js";

// 배경 서비스워커: UI RPC 라우팅 + 사이드패널 동작 + 감시/타임아웃 스케줄.
export default defineBackground(() => {
  const bg = new Background();
  const CONFIRM_TTL_MS = 5 * 60_000; // spec/broker-api §2.2.1 기본 5분

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // 발신자 검증: 이 확장 자신의 페이지(Side Panel/Options)만 허용.
    if (sender.id !== chrome.runtime.id) {
      sendResponse({ ok: false, error: "forbidden_sender" });
      return false;
    }
    bg.handle(msg)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // 비동기 응답
  });

  // 툴바 아이콘 클릭 시 사이드패널 열기(주 콘솔).
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

  // 감시 폴링 + confirm 타임아웃 스윕(최소 간격 — payment-flows 무우회 원칙).
  chrome.alarms?.create("autopay-tick", { periodInMinutes: 5 });
  chrome.alarms?.onAlarm.addListener(async (a) => {
    if (a.name !== "autopay-tick") return;
    try {
      await bg.brokerCore.expireStaleConfirmations(CONFIRM_TTL_MS);
    } catch (e) {
      console.warn("[autopay] confirm sweep failed", e);
    }
    for (const w of await bg.watchEngine.list()) {
      try {
        await bg.watchEngine.check(w.id); // 한 감시 실패가 나머지를 막지 않게 격리
      } catch (e) {
        console.warn("[autopay] watch check failed", w.id, e);
      }
    }
  });
});
