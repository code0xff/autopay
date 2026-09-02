import type { ChannelSender } from "../notify/notifier.js";

// chrome.notifications 기반 알림 sender. 본문은 Notifier가 포맷(비밀/PII 없음).
export const chromeNotificationSender: ChannelSender = async (msg) => {
  try {
    await chrome.notifications.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon/128.png"),
      title: msg.title,
      message: msg.body,
    });
  } catch {
    // 아이콘 부재 등으로 실패해도 결제 흐름을 막지 않는다.
  }
};
