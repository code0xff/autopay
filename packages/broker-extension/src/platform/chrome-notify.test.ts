import { describe, expect, it } from "vitest";
import { passwordNotificationId, tabIdFromNotificationId } from "./chrome-notify.js";

// 비번 핸드오프 알림 클릭 → 결제 탭 포커스(executor.md §3.2)의 탭 id 왕복.
// 왜 id에 담나: 클릭은 알림을 띄운 시점과 다른 서비스워커 인스턴스에서 처리될 수
// 있다(핸드오프 최대 10분, MV3 SW는 그 사이 죽는다). id에 담으면 상태가 불필요.

describe("비번 알림 id ↔ 탭 id", () => {
  it("1. 인코딩한 탭 id를 그대로 복원한다", () => {
    for (const tabId of [0, 1, 42, 1680207760]) {
      expect(tabIdFromNotificationId(passwordNotificationId(tabId))).toBe(tabId);
    }
  });

  it("2. 다른 알림(자동 생성 id·타 확장)은 null — 엉뚱한 탭을 건드리지 않는다", () => {
    for (const id of ["", "autopay-other-1", "12345", "notif-abc"]) {
      expect(tabIdFromNotificationId(id)).toBeNull();
    }
  });

  it("3. 접두사만 맞고 숫자가 아니면 null(fail-closed)", () => {
    for (const id of ["autopay-pw-", "autopay-pw-abc", "autopay-pw--1", "autopay-pw-1.5"]) {
      expect(tabIdFromNotificationId(id)).toBeNull();
    }
  });
});
