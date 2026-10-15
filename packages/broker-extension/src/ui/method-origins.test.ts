import { describe, expect, it } from "vitest";
import { METHOD_DEFAULT_ORIGINS, addMethodOrigins, removeMethodOrigins } from "./method-origins.js";

const al = (origins: string[]) => ({ mode: "allowlist" as const, origins });
const NAVER = METHOD_DEFAULT_ORIGINS.naverpay;

describe("method default origins", () => {
  it("켜면 기본 오리진을 추가한다", () => {
    const r = addMethodOrigins(al(["https://x.example"]), "naverpay");
    expect(r.origins).toEqual(["https://x.example", ...NAVER]);
    expect(r.added).toEqual([...NAVER]);
  });
  it("이미 있는 오리진은 중복 추가하지 않는다", () => {
    const r = addMethodOrigins(al([NAVER[0] as string]), "naverpay");
    expect(r.added).toEqual([]);
    expect(r.origins.filter((o) => o === NAVER[0])).toHaveLength(1);
  });
  it("기본값이 없는 수단은 변화 없음", () => {
    const r = addMethodOrigins(al(["https://x.example"]), "kakaopay");
    expect(r).toEqual({ origins: ["https://x.example"], added: [] });
  });
  it("끄면 기본 오리진만 제거하고 사용자가 입력한 값은 유지", () => {
    const r = removeMethodOrigins(al([...NAVER, "https://x.example"]), "naverpay", ["coupay"]);
    expect(r.origins).toEqual(["https://x.example"]);
    expect(r.removed).toEqual([...NAVER]);
  });
  it("다른 켜진 수단이 필요로 하는 오리진은 유지", () => {
    const shared = METHOD_DEFAULT_ORIGINS.coupay;
    const r = removeMethodOrigins(al([...shared]), "kakaopay", ["coupay"]);
    expect(r.origins).toEqual([...shared]);
    expect(r.removed).toEqual([]);
  });
  it("기본값은 와일드카드", () => {
    expect(METHOD_DEFAULT_ORIGINS.coupay).toEqual(["https://*.coupang.com"]);
    expect(METHOD_DEFAULT_ORIGINS.naverpay).toEqual(["https://*.naver.com"]);
    expect(METHOD_DEFAULT_ORIGINS.kakaopay).toEqual([]);
    expect(METHOD_DEFAULT_ORIGINS.tosspay).toEqual([]);
  });
  it("와일드카드 항목도 끄면 제거되고, 다른 수단이 쓰면 유지", () => {
    const r = removeMethodOrigins(al(["https://*.coupang.com"]), "coupay", ["naverpay"]);
    expect(r).toEqual({ origins: [], removed: ["https://*.coupang.com"] });
  });
  it("any 모드에서는 아무것도 하지 않는다", () => {
    const m = { mode: "any" as const, origins: ["https://x.example"] };
    expect(addMethodOrigins(m, "coupay")).toEqual({ origins: m.origins, added: [] });
    expect(removeMethodOrigins(m, "coupay", [])).toEqual({ origins: m.origins, removed: [] });
  });
});
