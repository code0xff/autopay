import { Background } from "../src/background/compose.js";

// 배경 서비스워커: UI RPC 라우팅 + 사이드패널 동작 + 감시/타임아웃 스케줄.
export default defineBackground(() => {
  const bg = new Background();
  const CONFIRM_TTL_MS = 5 * 60_000; // spec/broker-api §2.2.1 기본 5분
  // 실행 착수(executing) 후 이 시간을 넘겨도 여전히 대기 중이면 워커가 죽은 것으로
  // 간주 — payTimeoutMs(어댑터 pay() 자체 타임아웃)보다 여유를 둬 정상 진행 중인
  // 건을 오판하지 않는다(§9 "MV3 서비스워커 수명·교차 워커 원자성").
  const EXECUTION_STALE_BUFFER_MS = 60_000;

  // 저장된 토큰이 있으면 mcp-server 브리지 허브에 접속(M2, spec/mcp-integration §7).
  bg.connectBridge().catch((e) => console.warn("[autopay] bridge connect failed", e));

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // 발신자 검증: 이 확장 자신의 페이지(Side Panel/Options)만 허용.
    if (sender.id !== chrome.runtime.id) {
      sendResponse({ ok: false, error: "forbidden_sender" });
      return false;
    }
    bg.handle(msg)
      .then(sendResponse)
      .catch((e) => {
        console.warn("[autopay] rpc failed", e); // 원문은 콘솔에만
        sendResponse({ ok: false, error: "internal_error" }); // 응답엔 일반 코드만
      });
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
    try {
      await bg.brokerCore.recoverStaleExecutions(
        bg.brokerCore.payTimeoutMsValue + EXECUTION_STALE_BUFFER_MS,
      );
    } catch (e) {
      console.warn("[autopay] stale execution sweep failed", e);
    }
    // MV3 SW 재기동/연결 끊김 대비 — 5분 틱마다 미접속이면 재접속 시도.
    if (!bg.isBridgeConnected) {
      bg.connectBridge().catch((e) => console.warn("[autopay] bridge reconnect failed", e));
    }
    let watches: { id: string }[] = [];
    try {
      watches = await bg.watchEngine.list();
    } catch (e) {
      console.warn("[autopay] watch list failed", e);
    }
    for (const w of watches) {
      try {
        await bg.watchEngine.check(w.id); // 한 감시 실패가 나머지를 막지 않게 격리
      } catch (e) {
        console.warn("[autopay] watch check failed", w.id, e);
      }
    }
  });
});
