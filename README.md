# NightPay

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
- **Agent-driven buying**: an AI agent (any MCP agent, or the built-in Order tab)
  searches, compares and reaches checkout, then requests payment, always through
  the policy gate.

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
packages/mcp-server          Local stdio MCP server + WebSocket hub (M2, for MCP agents)
packages/agent-skill         Shopping skill (SKILL.md, also at .claude/skills/autopay-shopping)
docs/                        Design, specs and conventions (12 specs under spec/)
```

## Quick start

### Requirements

- Node 20+ and pnpm 9 (`npm i -g pnpm@9`)
- Google Chrome
- One of: an MCP-capable AI agent such as Claude Code, **or** a ChatGPT account
  for the built-in Order tab

### 1. Install and build

```bash
git clone https://github.com/code0xff/autopay.git && cd autopay
pnpm bootstrap
```

`pnpm bootstrap` (`scripts/bootstrap.mjs`) runs four steps:

1. installs dependencies (`pnpm install`);
2. builds the MCP server (`packages/mcp-server/dist/index.js`);
3. builds the Chrome extension (`packages/broker-extension/.output/chrome-mv3`);
4. creates the bridge token at `~/.autopay/bridge-token` (mode 0600), or reuses it
   if it already exists, and copies it to the clipboard. The token is never
   printed to the terminal; if no clipboard tool is available, the script tells you
   the file path instead.

### 2. Load the extension in Chrome

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select `packages/broker-extension/.output/chrome-mv3`
   (the script prints the absolute path).
3. Pin the NightPay icon to the toolbar and click it to open the side panel.
4. After a rebuild, press the reload button on the extension card.

### 3. First run in the side panel

1. Set a passphrase (first run; afterwards you unlock with it).
2. **Settings** tab: paste the token into **MCP Bridge** (it is still on your
   clipboard). Needed for option A; skip it for option B.
3. **Policy** tab: check the limits. Defaults are ₩20,000 per payment, ₩50,000/day,
   ₩100,000/month, 3 payments/day, and approval required above ₩10,000.
   **Payments of ₩10,000 or less run without any confirmation.** Lower the
   approval threshold or turn on "always confirm" if you do not want that.

The **Getting started** card on the Home tab shows which steps are left.

### 4. Prepare Coupang

Log in to Coupang yourself in Chrome and turn on one-touch payment in the Coupang
app. NightPay and the agent never handle logins or passwords. If Coupang asks for
the payment password again during checkout, you get a notification: **type it
yourself in the checkout tab**.

### 5. Order something

**Option A: an AI agent (MCP).** Run Claude Code in the repo folder. The `autopay`
server is already registered in `.mcp.json`; approve the MCP server when Claude
Code asks. Then ask, for example: "Buy two 6-packs of 2L water on Coupang, the top
recommended one." Codex is registered the same way in `.codex/config.toml`, so
running Codex in the repo folder works too. For other MCP agents, register
`node packages/mcp-server/dist/index.js` as a stdio server (run from the repo
folder).

**Option B: the Order tab.** Open the side panel's **Order** tab and press
"설정에서 ChatGPT 연결" (connect ChatGPT in Settings), then press
"ChatGPT로 로그인" in Settings. The tokens are encrypted with your passphrase and
stored only in this browser. Back in the Order tab, type a request (for example
"Buy two 6-packs of 2L water") and send it. You can stop a running request with the
stop button ("중단").

Either way, payments go through policy, confirmation and audit.

### Troubleshooting

- **Side panel stuck on loading**: remove the extension and load it again. This
  resets the policy, bridge token and passphrase, so re-enter them.
- **Bridge not connected**: make sure the agent is running in the repo folder (so
  it picks up `.mcp.json`) and that the token in Settings → MCP Bridge matches
  `~/.autopay/bridge-token`.

### Notes

The side panel has five tabs: Home (approvals and remaining limits), Order, Policy,
History (audit log) and Settings. The options page shows the same app. The History
tab pages through the audit log.

NightPay is inactive until you unlock it with your passphrase: while locked, only the
lock screen is shown and every agent tool call is refused. Once unlocked it stays
unlocked until you close the browser or press the lock button in the header.

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

## License

[Apache License 2.0](LICENSE). The self-hosted fonts under `docs/site/fonts/` (Pretendard,
JetBrains Mono) are distributed under the SIL Open Font License 1.1; each font's licence
file (`OFL.txt`) sits beside it.
