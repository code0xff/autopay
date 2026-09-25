import { PaymentPolicy } from "@autopay/shared";
import { z } from "zod";

// UI(Side Panel/Options) ↔ background 내부 RPC. 같은 익스텐션이라도 인바운드를
// zod 검증(fail-closed). 비밀은 반환하지 않는다(hasProfile 같은 상태만).

export const RpcRequest = z.discriminatedUnion("type", [
  z.object({ type: z.literal("getState") }).strict(),
  z.object({ type: z.literal("setPolicy"), policy: PaymentPolicy }).strict(),
  z.object({ type: z.literal("unlock"), passphrase: z.string().min(1) }).strict(),
  z.object({ type: z.literal("lock") }).strict(),
  // 기록 탭 페이지네이션 — 최신순 offset/limit
  z
    .object({
      type: z.literal("getAudit"),
      offset: z.number().int().nonnegative(),
      limit: z.number().int().min(1).max(50),
    })
    .strict(),
  z
    .object({
      type: z.literal("resolveConfirmation"),
      requestId: z.string(),
      approved: z.boolean(),
    })
    .strict(),
  // MCP 브리지 토큰 등록(docs/spec/mcp-integration.md §5) — mcp-server가 발급한
  // 토큰을 사용자가 옵션에서 1회 입력. 저장 즉시 재접속 시도.
  z
    .object({ type: z.literal("setBridgeToken"), token: z.string().min(16) })
    .strict(),
  // 알림 진단 — 실사용에서 결제 실패 알림조차 안 뜨는데 원인을 밖에서 볼 방법이
  // 없었다(발송 실패는 console.warn으로 삼켜지고, 정책 channels가 비면 조용히
  // 아무 데도 안 간다). 실제 발송 경로를 그대로 태워보고 어디서 죽는지 돌려준다.
  z
    .object({ type: z.literal("testNotification") })
    .strict(),
]);
export type RpcRequest = z.infer<typeof RpcRequest>;
