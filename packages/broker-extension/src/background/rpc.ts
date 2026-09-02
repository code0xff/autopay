import { PaymentMethod, PaymentPolicy } from "@autopay/shared";
import { z } from "zod";

// UI(Side Panel/Options) ↔ background 내부 RPC. 같은 익스텐션이라도 인바운드를
// zod 검증(fail-closed). 비밀은 반환하지 않는다(hasProfile 같은 상태만).

export const IdentityInput = z
  .object({ phone: z.string().min(1), birth: z.string().min(1) })
  .strict();

export const WatchInput = z
  .object({
    productRef: z.string().min(1),
    title: z.string().min(1),
    maxPrice: z.number().int().nonnegative(),
    freeShippingOnly: z.boolean(),
    buyOnRestock: z.boolean(),
    method: PaymentMethod,
  })
  .strict();

export const RpcRequest = z.discriminatedUnion("type", [
  z.object({ type: z.literal("getState") }),
  z.object({ type: z.literal("setPolicy"), policy: PaymentPolicy }),
  z.object({ type: z.literal("unlock"), passphrase: z.string().min(1) }),
  z.object({ type: z.literal("setProfile"), identity: IdentityInput }),
  z.object({ type: z.literal("addWatch"), spec: WatchInput }),
  z.object({ type: z.literal("removeWatch"), id: z.string() }),
  z.object({ type: z.literal("pauseWatch"), id: z.string(), paused: z.boolean() }),
  z.object({
    type: z.literal("resolveConfirmation"),
    requestId: z.string(),
    approved: z.boolean(),
  }),
]);
export type RpcRequest = z.infer<typeof RpcRequest>;
