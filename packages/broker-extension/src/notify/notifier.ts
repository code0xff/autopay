// 알림 (docs/spec/notify.md). 완료/거절은 브로커가 직접 발송(에이전트 경유 아님).
// 본문에 비밀·PII 원문 금지 — 이벤트는 금액·가맹점·주문번호·사유만 담는다.

export type NotifyChannel = "chrome" | "telegram" | "email" | "webhook";

export type NotifyEvent =
  | { kind: "confirm_required"; merchant: string; amount: number; requestId: string }
  | { kind: "approve_on_phone"; merchant: string; amount: number; method: "kakaopay" | "tosspay" }
  | { kind: "completed"; merchant: string; amount: number; orderId: string }
  | { kind: "rejected"; merchant: string; amount: number; violation: string }
  | { kind: "failed"; merchant: string; amount: number; error: string };

export interface NotifyMessage {
  title: string;
  body: string;
}

// 채널 sender: 실제 발송 부수효과. 미구현 채널은 등록하지 않으면 무시된다.
export type ChannelSender = (msg: NotifyMessage, event: NotifyEvent) => Promise<void>;

export interface Notifier {
  notify(event: NotifyEvent, channels: NotifyChannel[]): Promise<void>;
}

export interface NotifierConfig {
  senders: Partial<Record<NotifyChannel, ChannelSender>>;
  notifyOnRejection: boolean;
}

export class BrokerNotifier implements Notifier {
  constructor(private readonly config: NotifierConfig) {}

  async notify(event: NotifyEvent, channels: NotifyChannel[]): Promise<void> {
    if (event.kind === "rejected" && !this.config.notifyOnRejection) return;
    const msg = format(event);
    for (const ch of channels) {
      const sender = this.config.senders[ch];
      if (!sender) continue; // 미구현/미설정 채널은 안전하게 무시(흐름 중단 없음)
      await sender(msg, event);
    }
  }
}

export function format(event: NotifyEvent): NotifyMessage {
  const won = (n: number) => `₩${n.toLocaleString("ko-KR")}`;
  switch (event.kind) {
    case "confirm_required":
      return {
        title: "결제 승인 요청",
        body: `${event.merchant} ${won(event.amount)} 승인해주세요`,
      };
    case "approve_on_phone":
      return {
        title: "폰에서 승인",
        body: `${event.merchant} ${won(event.amount)} — 폰에서 ${event.method} 승인하세요`,
      };
    case "completed":
      return {
        title: "결제 완료",
        body: `${event.merchant} ${won(event.amount)} · 주문 ${event.orderId}`,
      };
    case "rejected":
      return {
        title: "결제 거절",
        body: `${event.merchant} ${won(event.amount)} · ${event.violation}`,
      };
    case "failed":
      return {
        title: "결제 실패",
        body: `${event.merchant} ${won(event.amount)} · ${event.error}`,
      };
  }
}
