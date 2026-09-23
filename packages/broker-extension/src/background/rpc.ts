import { PaymentPolicy } from "@autopay/shared";
import { z } from "zod";

// UI(Side Panel/Options) ↔ background 내부 RPC. 같은 익스텐션이라도 인바운드를
// zod 검증(fail-closed). 비밀은 반환하지 않는다(hasProfile 같은 상태만).

export const IdentityInput = z
  .object({ phone: z.string().min(1), birth: z.string().min(1) })
  .strict();

export const RpcRequest = z.discriminatedUnion("type", [
  z.object({ type: z.literal("getState") }).strict(),
  z.object({ type: z.literal("setPolicy"), policy: PaymentPolicy }).strict(),
  z.object({ type: z.literal("unlock"), passphrase: z.string().min(1) }).strict(),
  z.object({ type: z.literal("lock") }).strict(),
  z.object({ type: z.literal("setProfile"), identity: IdentityInput }).strict(),
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
]);
export type RpcRequest = z.infer<typeof RpcRequest>;
