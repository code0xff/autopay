import type { PaymentPolicy } from "@autopay/shared";
import type { UiState } from "../background/compose.js";

// UI → background RPC 헬퍼. background가 zod로 재검증한다(rpc.ts).
async function rpc<T = { ok: boolean }>(msg: Record<string, unknown>): Promise<T> {
  return (await chrome.runtime.sendMessage(msg)) as T;
}

export const getState = () => rpc<UiState>({ type: "getState" });
export const setPolicy = (policy: PaymentPolicy) => rpc({ type: "setPolicy", policy });
export const unlock = (passphrase: string) => rpc({ type: "unlock", passphrase });
export const setProfile = (identity: { phone: string; birth: string }) =>
  rpc({ type: "setProfile", identity });
export const resolveConfirmation = (requestId: string, approved: boolean) =>
  rpc({ type: "resolveConfirmation", requestId, approved });
export const removeWatch = (id: string) => rpc({ type: "removeWatch", id });
export const addWatch = (spec: {
  productRef: string;
  title: string;
  maxPrice: number;
  freeShippingOnly: boolean;
  buyOnRestock: boolean;
  method: "kakaopay" | "tosspay" | "coupay";
}) => rpc({ type: "addWatch", spec });

export function applyTheme(): void {
  try {
    const t = localStorage.getItem("autopay-theme");
    if (t) document.documentElement.setAttribute("data-theme", t);
  } catch {}
}
export function toggleTheme(): void {
  const root = document.documentElement;
  const dark =
    root.getAttribute("data-theme") === "dark" ||
    (!root.getAttribute("data-theme") && matchMedia("(prefers-color-scheme: dark)").matches);
  const next = dark ? "light" : "dark";
  root.setAttribute("data-theme", next);
  try {
    localStorage.setItem("autopay-theme", next);
  } catch {}
}
