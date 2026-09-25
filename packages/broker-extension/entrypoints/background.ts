import { Background } from "../src/background/compose.js";
import { tabIdFromNotificationId } from "../src/platform/chrome-notify.js";

// 배경 서비스워커: UI RPC 라우팅 + 사이드패널 동작 + 타임아웃 스케줄.
export default defineBackground(() => {
  const bg = new Background();
  const CONFIRM_TTL_MS = 5 * 60_000; // spec/broker-api §2.2.1 기본 5분
  // 실행 착수(executing) 후 이 시간을 넘겨도 여전히 대기 중이면 워커가 죽은 것으로
  // 간주 — payTimeoutMs(어댑터 pay() 자체 타임아웃)보다 여유를 둬 정상 진행 중인
  // 건을 오판하지 않는다(§9 "MV3 서비스워커 수명·교차 워커 원자성").
  const EXECUTION_STALE_BUFFER_MS = 60_000;

  // 저장된 토큰이 있으면 mcp-server 브리지 허브에 접속(M2, spec/mcp-integration §7).
  bg.connectBridge().catch((e) => console.warn("[autopay] bridge connect failed", e));

  // 기동 즉시 이전 워커의 잔여 실행을 회수한다. 색인에 남은 건 이 워커가 시작한
  // 게 아니므로 실행 루프가 이미 사라진 상태 — 방치하면 리로드해도 페이지 도구가
  // 계속 잠긴다(§9 MV3 서비스워커 수명). 알람 틱까지 기다릴 이유가 없다.
  bg.brokerCore
    .recoverStaleExecutions(bg.brokerCore.payTimeoutMsValue + EXECUTION_STALE_BUFFER_MS)
    .catch((e) => console.warn("[autopay] startup execution sweep failed", e));

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

  // 비번 핸드오프 알림 클릭 → 결제 탭으로 바로 이동(executor.md §3.2).
  // 사용자가 탭 수십 개 중에서 결제창을 찾아 헤매다 타임아웃되는 걸 막는 목적.
  // 탭 id는 알림 id에 인코딩돼 있어 SW가 재시작돼도 동작한다(chrome-notify.ts).
  // 리스너는 최상위에 등록 — MV3는 SW 재기동 시 동기 등록된 리스너만 복원한다.
  chrome.notifications?.onClicked.addListener(async (notificationId) => {
    const tabId = tabIdFromNotificationId(notificationId);
    if (tabId === null) return;
    try {
      const tab = await chrome.tabs.get(tabId); // 이미 닫힌 탭이면 여기서 throw
      await chrome.tabs.update(tabId, { active: true });
      if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.notifications.clear(notificationId);
    } catch (e) {
      // 탭이 이미 닫혔거나 포커스 실패 — 결제 흐름에는 영향 없다(계속 폴링).
      console.warn("[autopay] focus payment tab failed", e);
    }
  });

  // confirm 타임아웃 + 중단된 실행 스윕(최소 간격 — payment-flows 무우회 원칙).
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
  });
});
