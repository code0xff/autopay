#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Hub } from "./hub.js";
import { FileTokenStore, loadOrCreateToken } from "./token.js";
import { registerTools } from "./tools.js";

// 엔트리포인트(docs/spec/mcp-integration.md §7) — Claude Code에 stdio MCP로 뜨고,
// 동시에 로컬 WS 허브를 열어 익스텐션 background(WS 클라이언트)를 기다린다.

async function main(): Promise<void> {
  const token = await loadOrCreateToken(new FileTokenStore());
  const port = Number(process.env.AUTOPAY_BRIDGE_PORT ?? 8765);

  const hub = new Hub({ token, port });
  await hub.start();
  console.error(`[autopay-mcp] bridge hub listening on ws://127.0.0.1:${port}`);
  console.error(`[autopay-mcp] register this token in the extension options: ${token}`);

  const server = new McpServer({ name: "autopay", version: "0.1.0" });
  registerTools(server, hub);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = () => {
    hub.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[autopay-mcp] fatal", err);
  process.exit(1);
});
