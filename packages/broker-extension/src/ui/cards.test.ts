import { describe, expect, it } from "vitest";
import { agentHint } from "./cards.js";

describe("agentHint", () => {
  it("둘 다 없으면 안내 문구(pbcopy 포함)", () => {
    const h = agentHint({ hasBridgeToken: false, assistantConnected: false });
    expect(h).toContain("pbcopy < ~/.autopay/bridge-token");
  });
  it("연결된 쪽을 밝힌다", () => {
    expect(agentHint({ hasBridgeToken: true, assistantConnected: false })).toBe(
      "MCP 브리지 토큰 등록됨",
    );
    expect(agentHint({ hasBridgeToken: false, assistantConnected: true })).toBe("ChatGPT 연결됨");
    expect(agentHint({ hasBridgeToken: true, assistantConnected: true })).toBe(
      "MCP 브리지 토큰 등록됨 · ChatGPT 연결됨",
    );
  });
});
