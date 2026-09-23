# AutoPay

**An autonomous spending governance layer.** AI agents search for and pay for
products on the web on the user's behalf, while policy, audit, isolation and
notifications keep the user in control and fully informed. The primary target is
the Korean payment ecosystem (KakaoPay, Toss Pay, Coupang).

The design and its rationale live in **[AGENTS.md](AGENTS.md)** (the project's
single source of truth). Current implementation status is in
**[docs/status.md](docs/status.md)**. Design documents are written in Korean.

User guide: **https://code0xff.github.io/autopay/** (source:
[`docs/site/index.html`](docs/site/index.html)).

## What it does

- **Policy control**: per-payment, daily and monthly limits, a daily count, and
  allowed merchants, categories and payment methods. Every payment must pass
  policy before it runs.
- **Secret isolation**: the broker never stores or types raw payment secrets.
  Final approval happens on the phone (pattern B) or through pre-authorised
  one-touch payment (pattern C, Coupang). The design leaves nothing to steal.
- **Audit and notification**: every payment attempt is written to an audit log,
  and completions and rejections are notified immediately.
- **Limit-price buying**: Claude Code (via the MCP skill) watches a product and
  a price ceiling, and requests payment once the condition is met, always
  through the policy gate.

## Layout

```
packages/shared              Shared Zod schemas and types (single source of truth at the boundary, incl. the bridge protocol)
packages/broker-extension    Chrome MV3 extension (trusted zone)
  src/policy                 Policy engine (pure functions, 100% coverage)
  src/{audit,notify,refstore,executor,broker}  Trusted core (dependency-injected, unit-tested)
  src/platform               Chrome adapters (kv / notify / page bridge)
  src/bridge                 MCP bridge WebSocket client + tool mapping (M2)
  src/background             Composition root + UI RPC
  entrypoints                background · sidepanel · options (WXT / React)
packages/mcp-server          Local stdio MCP server + WebSocket hub (M2, for Claude Code)
packages/agent-skill         Claude Code shopping skill (SKILL.md)
docs/                        Design, specs and conventions (12 specs under spec/)
```

## Quick start

Requirements: Node 20+, pnpm 9, Chrome, Claude Code.

```bash
pnpm bootstrap   # install → build MCP server and extension → prepare bridge token (copied to clipboard)
```

Then, once by hand:

1. `chrome://extensions` → Developer mode → "Load unpacked" →
   `packages/broker-extension/.output/chrome-mv3` (after a rebuild, just press reload ⟳)
2. AutoPay options → paste the token into **MCP Bridge** (it is on your
   clipboard) → save **payment limits** (the default is ₩0, which refuses everything)
3. Log in to Coupang yourself and turn on one-touch payment in the Coupang app
4. Run Claude Code in this folder (the `autopay` server is already registered in
   `.mcp.json`) → "Buy this laptop stand if it's under ₩30,000"

The **Getting started** card at the top of the options page shows what is left.
Unlocking with a passphrase is only needed for the identity details used by
KakaoPay and Toss Pay (pattern B); skip it if you only use Coupang. If Coupang
asks for the payment password again during checkout, you get a notification and
**type it yourself in the checkout tab**. AutoPay and the agent never handle the
password.

The agent has exactly seven tools: `open`, `read_page`, `click`, `fill`,
`request_payment`, `get_payment_result` and `get_policy_summary`. Payments always
go through policy, confirmation and audit (`docs/spec/mcp-integration.md`).

## Development

```bash
pnpm test               # all unit tests
pnpm typecheck          # type check
pnpm lint               # Biome
pnpm --filter @autopay/broker-extension dev     # WXT dev mode
pnpm --filter @autopay/broker-extension build   # build the extension (.output/chrome-mv3)
pnpm --filter @autopay/mcp-server build         # bundle the MCP server (dist/index.js)
```

## Workflow

The default branch is `dev`. Commit in complete feature units, followed by
review (see [docs/methodology.md](docs/methodology.md)). Never use real cards or
accounts for development or testing.

## Status

M0 (skeleton), M1 (extension) and M2 (MCP bridge core) are complete and
verified. M3 (live selectors for real payments) and M4 (billing keys) still need
live integration. See [docs/status.md](docs/status.md).
