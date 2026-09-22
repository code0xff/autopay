# @autopay/mcp-server (설계 — 미구현)

Claude Code 등 MCP 클라이언트에 AutoPay 도구를 노출하는 **stdio MCP 서버** +
익스텐션과 잇는 **로컬 WebSocket 브리지 허브**(토큰 게이트).

설계: [`docs/spec/mcp-integration.md`](../../docs/spec/mcp-integration.md).

## 역할
- stdio MCP 서버: `open`·`read_page`·`click`·`fill`·`request_payment`·
  `get_payment_result`·`get_policy_summary` 도구 노출(비밀 반환 없음).
- 로컬 WS 허브(`127.0.0.1`, 토큰 게이트): 도구 호출을 익스텐션 background로
  전달하고 결과를 되받음.

## 구현 예정 (M2, mcp-integration.md §9)
- `@modelcontextprotocol/sdk`(TypeScript) 기반 stdio 서버
- ws 허브 + 토큰 핸드셰이크(`~/.autopay/bridge-token`)
- `shared`의 도구/프레임 zod 스키마 재사용
