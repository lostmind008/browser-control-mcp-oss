# Changelog

All notable changes to **Browser Control MCP Server** are documented here.

The format adheres to [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [3.1.0] — 2026-05-14

A resilience release. No breaking changes; existing tool APIs and the
`error`/`hint` response fields are unchanged. Three new error fields are
**added** (`reason_code`, `recoverable`, `next_action`).

### Added — Resilience layer for CDP transport failures

Before this release, the underlying CDP WebSocket could die mid-operation
and the failure was silently dropped: pending operations hung until the
30-second timeout, and a synchronous `ws.send()` throw on a closed socket
could take the MCP stdio transport down with it. The trigger that surfaced
this: the Claude for Chrome extension entering agent mode, which calls
`chrome.debugger.attach()` and forcibly detaches our CDP session.

- `CDPClient` now installs a `ws.on('close')` handler and a post-open
  `ws.on('error')` handler. Both reject every pending operation
  immediately instead of letting them age out.
- **New** `CDPClient._failPending(message, reasonCode, extra)` — rejects all
  pending operations with a structured `Error` carrying machine-readable
  `cdpReasonCode`, `cdpRecoverable`, and `cdpExtra`.
- `CDPClient._handleEvent()` now intercepts the `Inspector.detached` CDP
  event. Chromium 147 fires this ~3–50 ms *before* the socket closes when
  another debugger takes over, yielding a precise `inspector_detached`
  reason instead of a generic close.
- `CDPClient.send()` now guards against closed/closing sockets with a
  `readyState` check, wraps `ws.send()` in `try/catch`, and tags every
  failure path with a `cdpReasonCode`.
- `getPageConnection()` now `await client.close()`s stale pool entries
  before deleting them — eliminates leaked WebSocket file descriptors over
  long-running sessions.

### Added — Structured error metadata in MCP responses

Tool error responses now carry machine-readable fields so downstream
agents can decide retry strategy without parsing prose:

```json
{
  "error":       "CDP connection lost: Inspector detached (reason=target closed)",
  "tool":        "execute_javascript",
  "reason_code": "inspector_detached",
  "recoverable": true,
  "next_action": "The CDP target was taken over ... Call list_tabs and retry — the next request will reconnect lazily.",
  "cdp_extra":   { "cdp_reason": "target closed" }
}
```

- **New** `NEXT_ACTION_HINTS` constant maps each `reason_code` to a concrete
  remediation hint. Full schema and consumer-agent integration guide in
  [`docs/RESILIENCE.md`](docs/RESILIENCE.md).

### `reason_code` taxonomy

| `reason_code`         | Recoverable | Typical cause                                                                |
|-----------------------|:-----------:|------------------------------------------------------------------------------|
| `browser_not_running` | yes         | Browser not launched with `--remote-debugging-port`                          |
| `tab_not_found`       | yes         | Tab was closed or `tabId` is stale                                           |
| `inspector_detached`  | yes         | Another debugger (e.g. Chrome extension via `chrome.debugger.attach`) took over |
| `websocket_closed`    | yes         | CDP socket closed (tab closed, browser quit, takeover)                       |
| `websocket_error`     | yes         | Transport-level WebSocket error                                              |
| `socket_not_open`     | yes         | `send()` called while socket not in OPEN state                               |
| `send_failed`         | yes         | `ws.send()` threw synchronously                                              |
| `cdp_timeout`         | yes         | 30-second response timeout exceeded                                          |
| `unknown`             | yes         | Error did not match any known shape                                          |

### Behaviour changes

- **Faster failure**: operations that previously hung 30 s now fail in
  < 50 ms once the transport is dead.
- **Lazy reconnect**: failed operations do not auto-retry; the *next*
  `getPageConnection()` call establishes a fresh WebSocket. Matches
  Puppeteer / chrome-remote-interface / Playwright conventions.
- **No new flags**: behaviour is opinionated by design — there is no opt-out.

### Compatibility

- Tested against Chromium 147 (Comet 147.0.7727.1858).
- No breaking changes to any of the 36 tool APIs.
- Node.js 18+ (unchanged).

---

## [3.0.1] — 2026-03-18

### Documentation

- Added macOS wrapper-app instructions (Google Chrome CDP.app / Comet CDP.app).
- Added Claude Code skill reference (cdp-dev-companion).
- Added multi-browser strategy section.

---

## [3.0.0] — 2026-03-17

### Changed — Full CDP rewrite

- Replaced AppleScript + JavaScript injection with native **Chrome
  DevTools Protocol** over WebSocket.
- **36 tools** (up from 26).
- Cross-platform: macOS, Linux, Windows, WSL, Docker.
- Real input events (mouse/keyboard via the browser engine), accessibility
  tree, network monitoring, performance tracing, device emulation, native
  file upload, PDF generation, screenshots, dialog handling.
- One unified codebase serves Chrome, Comet, Edge, Brave via `--browser`.

---

## [2.0.0] — 2026-03-16

### Added

- JavaScript-injection enhancement layer. 26 tools. macOS only.

---

## [1.0.0] — 2024

### Added

- Original AppleScript-based implementation. 11 tools. macOS only.
