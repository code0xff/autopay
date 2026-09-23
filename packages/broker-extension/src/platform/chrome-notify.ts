import type { ChannelSender } from "../notify/notifier.js";

// chrome.notifications 기반 알림 sender. 본문은 Notifier가 포맷(비밀/PII 없음).
export const chromeNotificationSender: ChannelSender = async (msg) => {
  try {
    // basic 알림은 iconUrl이 필수 — 빈 값이면 "Unable to successfully use the provided
    // image"로 생성 자체가 실패한다. 익스텐션 아이콘을 쓴다.
    await chrome.notifications.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon/128.png"),
      title: msg.title,
      message: msg.body,
    });
  } catch (e) {
    // 통지 실패가 결제 흐름을 막지는 않되, 조용히 삼키지 않고 로그로 남긴다.
    console.warn("[autopay] notification failed", e);
  }
};
