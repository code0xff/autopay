import { describe, expect, it, vi } from "vitest";
import { BrokerNotifier, type NotifyEvent } from "./notifier.js";

const makeNotifier = (notifyOnRejection: boolean) => {
  const chrome = vi.fn().mockResolvedValue(undefined);
  const notifier = new BrokerNotifier({ senders: { chrome }, notifyOnRejection });
  return { notifier, chrome };
};

describe("BrokerNotifier", () => {
  it("1. completed → chrome 알림에 금액·가맹점·주문번호", async () => {
    const { notifier, chrome } = makeNotifier(true);
    const e: NotifyEvent = { kind: "completed", merchant: "쿠팡", amount: 28_900, orderId: "#123" };
    await notifier.notify(e, ["chrome"]);
    expect(chrome).toHaveBeenCalledOnce();
    const [msg] = chrome.mock.calls[0] ?? [];
    expect(msg.body).toContain("쿠팡");
    expect(msg.body).toContain("28,900");
    expect(msg.body).toContain("#123");
  });

  it("2. approve_on_phone → '폰에서' 안내", async () => {
    const { notifier, chrome } = makeNotifier(true);
    await notifier.notify(
      { kind: "approve_on_phone", merchant: "쿠팡", amount: 1000, method: "kakaopay" },
      ["chrome"],
    );
    const [msg] = chrome.mock.calls[0] ?? [];
    expect(msg.body).toContain("폰에서");
  });

  it("3. rejected + notifyOnRejection:false → 미발송", async () => {
    const { notifier, chrome } = makeNotifier(false);
    await notifier.notify(
      { kind: "rejected", merchant: "쿠팡", amount: 1000, violation: "over_daily" },
      ["chrome"],
    );
    expect(chrome).not.toHaveBeenCalled();
  });

  it("4. rejected + notifyOnRejection:true → 발송", async () => {
    const { notifier, chrome } = makeNotifier(true);
    await notifier.notify(
      { kind: "rejected", merchant: "쿠팡", amount: 1000, violation: "over_daily" },
      ["chrome"],
    );
    expect(chrome).toHaveBeenCalledOnce();
  });

  it("5. 미구현 채널(telegram) 포함 → chrome만 발송, 에러 없음", async () => {
    const { notifier, chrome } = makeNotifier(true);
    await expect(
      notifier.notify({ kind: "completed", merchant: "쿠팡", amount: 1, orderId: "x" }, [
        "chrome",
        "telegram",
      ]),
    ).resolves.toBeUndefined();
    expect(chrome).toHaveBeenCalledOnce();
  });

  it("6. 알림 본문에 phone/birth/빌링키 문자열 없음", async () => {
    const { notifier, chrome } = makeNotifier(true);
    await notifier.notify({ kind: "completed", merchant: "쿠팡", amount: 1, orderId: "x" }, [
      "chrome",
    ]);
    const [msg] = chrome.mock.calls[0] ?? [];
    const text = `${msg.title} ${msg.body}`;
    expect(text).not.toMatch(/\d{3}-\*{0,4}-\d{4}/); // 휴대폰 패턴
    expect(text.toLowerCase()).not.toContain("billing");
  });
});
