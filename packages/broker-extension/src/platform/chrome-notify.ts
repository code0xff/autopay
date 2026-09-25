import type { ChannelSender, NotifyEvent } from "../notify/notifier.js";

// chrome.notifications 기반 알림 sender. 본문은 Notifier가 포맷(비밀/PII 없음).

const PW_ID_PREFIX = "autopay-pw-";

/** 비번 핸드오프 알림의 id에 결제 탭 id를 인코딩한다.
 *  왜 id에 담나 — 클릭 처리(onClicked)는 알림을 띄운 시점과 다른 서비스워커
 *  인스턴스에서 실행될 수 있다(핸드오프는 최대 10분, MV3 SW는 그 사이 죽는다).
 *  in-memory Map은 그때 사라지고 별도 영속 저장은 과하다 — id 자체에 담으면
 *  상태가 필요 없다. tabId는 비밀이 아니라 라우팅 정보다. */
export function passwordNotificationId(tabId: number): string {
  return `${PW_ID_PREFIX}${tabId}`;
}

/** 알림 id에서 결제 탭 id를 복원. 이 확장의 비번 알림이 아니면 null.
 *  숫자 검사는 정규식으로 한다 — Number("")는 0이라 접미사가 비었을 때
 *  엉뚱하게 탭 0을 가리킨다(테스트로 잡은 실제 버그). */
export function tabIdFromNotificationId(id: string): number | null {
  if (!id.startsWith(PW_ID_PREFIX)) return null;
  const suffix = id.slice(PW_ID_PREFIX.length);
  if (!/^\d+$/.test(suffix)) return null;
  const n = Number(suffix);
  return Number.isSafeInteger(n) ? n : null;
}

export const chromeNotificationSender: ChannelSender = async (msg, event) => {
  try {
    // basic 알림은 iconUrl이 필수 — 빈 값이면 "Unable to successfully use the provided
    // image"로 생성 자체가 실패한다. 익스텐션 아이콘을 쓴다.
    await chrome.notifications.create(notificationIdFor(event), {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon/128.png"),
      title: msg.title,
      message: msg.body,
      // 비번 입력을 기다리는 동안은 알림이 저절로 사라지면 안 된다(놓치면
      // 핸드오프가 타임아웃으로 끝난다). 나머지 알림은 기본 동작(자동 소멸).
      requireInteraction: event.kind === "enter_password_on_page",
    });
  } catch (e) {
    // 통지 실패가 결제 흐름을 막지는 않되, 조용히 삼키지 않고 로그로 남긴다.
    console.warn("[autopay] notification failed", e);
  }
};

/** 비번 알림만 고정 id(탭 포커스용). 나머지는 빈 문자열 = 크롬이 자동 생성. */
function notificationIdFor(event: NotifyEvent): string {
  return event.kind === "enter_password_on_page" ? passwordNotificationId(event.tabId) : "";
}
