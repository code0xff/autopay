import type { ChannelSender } from "../notify/notifier.js";

// chrome.notifications 기반 알림 sender. 본문은 Notifier가 포맷(비밀/PII 없음).
export const chromeNotificationSender: ChannelSender = async (msg) => {
  try {
    // iconUrl 미지정(아이콘 자산 부재로 인한 발송 실패 방지). MV3에서 선택 항목.
    await chrome.notifications.create({
      type: "basic",
      iconUrl: "",
      title: msg.title,
      message: msg.body,
    });
  } catch (e) {
    // 통지 실패가 결제 흐름을 막지는 않되, 조용히 삼키지 않고 로그로 남긴다.
    console.warn("[autopay] notification failed", e);
  }
};
