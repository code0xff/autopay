import { Background } from "../src/background/compose.js";

// 배경 서비스워커: UI RPC 라우팅 + 사이드패널 동작 + 감시 폴링 스케줄.
export default defineBackground(() => {
  const bg = new Background();

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    bg.handle(msg)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // 비동기 응답
  });

  // 툴바 아이콘 클릭 시 사이드패널 열기(주 콘솔).
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

  // 감시 폴링(최소 간격 — payment-flows 무우회 원칙).
  chrome.alarms?.create("watch-poll", { periodInMinutes: 5 });
  chrome.alarms?.onAlarm.addListener(async (a) => {
    if (a.name !== "watch-poll") return;
    for (const w of await bg.watchEngine.list()) await bg.watchEngine.check(w.id);
  });
});
