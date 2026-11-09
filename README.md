# Browser Control MCP Server v3.1.0

Unified CDP-based browser control for AI agents via MCP (Model Context Protocol). Works with **Chrome**, **Comet**, **Edge**, **Brave**, and any Chromium-based browser.

## Why CDP?

Previous versions (v1/v2) used AppleScript + JavaScript injection — limited to macOS and unable to access native browser features. This v3.0 upgrade uses the **Chrome DevTools Protocol (CDP)** directly over WebSocket, providing:

- **Cross-platform**: macOS, Linux, Windows, WSL, Docker
- **36 tools** (up from 11 original / 26 JS-injected)
- **Real input events**: Click, type, drag via the browser engine (not DOM simulation)
- **Accessibility tree**: Full semantic page structure for AI understanding
- **Network monitoring**: Capture requests/responses with body extraction
- **Performance tracing**: CPU profiling and rendering analysis
- **Device emulation**: Mobile viewports, user agents, touch, DPR
- **File upload**: Native file input handling via CDP
- **PDF generation**: Print pages to PDF
- **Screenshot**: Full-page, element, and viewport screenshots
- **Dialog handling**: Alert, confirm, prompt auto-handling

## Quick Start

### 1. Install Dependencies

```bash
cd /path/to/browser-control-mcp-oss
npm install
```

### 2. Launch Your Browser with CDP Enabled

**macOS (Recommended) — Wrapper Apps:**

Pre-built wrapper apps launch your browser with CDP enabled automatically. Just click to open like any normal app:

| Wrapper App | Browser | CDP Port | Location |
|-------------|---------|----------|----------|
| **Google Chrome CDP.app** | Chrome | 9222 | `/Applications/Google Chrome CDP.app` |
| **Comet CDP.app** | Comet | 9223 | `/Applications/Comet CDP.app` |

These wrappers use your existing browser profile (no `--user-data-dir` isolation). If the browser is already running, they bring it to the front.

**macOS (Manual):**
```bash
# Chrome
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-debug

# Comet
/Applications/Comet.app/Contents/MacOS/Comet \
  --remote-debugging-port=9223 \
  --user-data-dir=/tmp/comet-debug

# Edge
/Applications/Microsoft\ Edge.app/Contents/MacOS/Microsoft\ Edge \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/edge-debug

# Brave
/Applications/Brave\ Browser.app/Contents/MacOS/Brave\ Browser \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/brave-debug
```

**Linux:**
```bash
# Chrome
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug

# Edge
microsoft-edge --remote-debugging-port=9222 --user-data-dir=/tmp/edge-debug

# Brave
brave-browser --remote-debugging-port=9222 --user-data-dir=/tmp/brave-debug
```

**Windows (PowerShell):**
```powershell
# Chrome
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$env:TEMP\chrome-debug"

# Edge
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$env:TEMP\edge-debug"
```

**Docker (headless):**
```bash
docker run -d -p 9222:9222 \
  chromedp/headless-shell:latest \
  --remote-debugging-address=0.0.0.0 \
  --remote-debugging-port=9222
```

### 3. Configure in Claude Code (.claude.json)

```json
{
  "mcpServers": {
    "chrome-control": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/path/to/browser-control-mcp-oss/server/index.js",
        "--browser", "chrome"
      ]
    },
    "comet-control": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/path/to/browser-control-mcp-oss/server/index.js",
        "--browser", "comet"
      ]
    }
  }
}
```

### 4. CLI Arguments

| Argument     | Default    | Description                          |
|-------------|------------|--------------------------------------|
| `--browser` | `chrome`   | Browser preset: chrome, comet, edge, brave |
| `--port`    | `9222`     | CDP debugging port                   |
| `--host`    | `127.0.0.1`| CDP host (use for Docker/remote)    |

## Tool Reference (36 Tools)

### Tab & Navigation (10 tools)

| Tool | Description |
|------|-------------|
| `health_check` | Check CDP connection status, browser version, tab count |
| `list_tabs` | List all open tabs with IDs, titles, URLs |
| `get_current_tab` | Get the active tab |
| `open_url` | Navigate to a URL (with optional wait-for-load) |
| `new_tab` | Open a new tab (optional URL) |
| `close_tab` | Close a tab by ID |
| `switch_to_tab` | Activate/focus a tab by ID |
| `reload_tab` | Reload (with optional cache bypass) |
| `go_back` | Navigate back in history |
| `go_forward` | Navigate forward in history |

### JavaScript & Content (2 tools)

| Tool | Description |
|------|-------------|
| `execute_javascript` | Run JS in page context (returns value, awaits promises) |
| `get_page_content` | Get page as HTML or extracted text |

### Interaction (10 tools)

| Tool | Description |
|------|-------------|
| `click` | Real CDP mouse click on element (left/right/double-click) |
| `fill` | Set input value (React-compatible via native setter) |
| `fill_form` | Fill multiple fields at once |
| `type_text` | Type character-by-character via keyboard events |
| `hover` | Real mouse hover over element |
| `press_key` | Press keyboard keys (Enter, Tab, Escape, arrows, etc.) |
| `select_option` | Select dropdown option by value |
| `scroll` | Scroll page or specific element |
| `drag` | Drag from source to target element with realistic movement |
| `wait_for` | Wait for element, JS condition, or timeout |

### Visual & Export (4 tools)

| Tool | Description |
|------|-------------|
| `take_screenshot` | Screenshot: viewport, full-page, or element (PNG/JPEG/WebP) |
| `take_snapshot` | Structured text DOM snapshot (for AI parsing) |
| `print_to_pdf` | Generate PDF of current page |
| `resize_window` | Set viewport dimensions |

### Device & Files (3 tools)

| Tool | Description |
|------|-------------|
| `emulate` | Device emulation: presets (iPhone 14, iPad, Pixel 7, Galaxy S23) or custom viewport/UA/DPR/touch |
| `upload_file` | Upload files to `<input type="file">` elements |
| `handle_dialog` | Accept/dismiss alert, confirm, prompt dialogs |

### Accessibility (1 tool)

| Tool | Description |
|------|-------------|
| `get_accessibility_tree` | Full accessibility tree — semantic roles, names, states. Ideal for AI page understanding |

### Monitoring (4 tools)

| Tool | Description |
|------|-------------|
| `console_messages` | Get captured console.log/warn/error messages |
| `network_requests` | Start network capture; retrieve requests with status, URL, type |
| `get_response_body` | Get response body for a captured network request |
| `get_cookies` | Get cookies for current page or specific URLs |

### Performance (2 tools)

| Tool | Description |
|------|-------------|
| `performance_start_trace` | Start CPU/rendering performance trace |
| `performance_stop_trace` | Stop trace and get summary with top events by duration |

## Device Emulation Presets

| Preset | Width | Height | DPR | Mobile |
|--------|-------|--------|-----|--------|
| `iphone-14` | 390 | 844 | 3 | Yes |
| `iphone-14-pro-max` | 430 | 932 | 3 | Yes |
| `ipad` | 810 | 1080 | 2 | Yes |
| `ipad-pro` | 1024 | 1366 | 2 | Yes |
| `pixel-7` | 412 | 915 | 2.625 | Yes |
| `galaxy-s23` | 360 | 780 | 3 | Yes |

## Key Modifier Flags (for press_key)

| Modifier | Value |
|----------|-------|
| Alt | 1 |
| Ctrl | 2 |
| Meta/Cmd | 4 |
| Shift | 8 |

Combine with addition: Ctrl+Shift = `2 + 8 = 10`

## Architecture

```
Claude Code  ──stdio──>  MCP Server  ──WebSocket──>  Browser CDP
                          (index.js)                   (port 9222)
                             │
                             ├── Per-page WS connections (tab control)
                             └── Browser-level WS (tracing, browser ops)
```

- **One unified codebase** serves Chrome, Comet, Edge, Brave via `--browser` flag
- **CDP HTTP API** (`/json/list`, `/json/new`, `/json/close`) for tab management
- **Per-page WebSocket** for page-specific commands (DOM, Input, Runtime)
- **Browser-level WebSocket** for cross-page operations (Tracing, Browser)
- **Auto-enabled domains**: Runtime (console capture) and Page (navigation events) enabled on connection
- **Network domain**: Enabled on demand when `network_requests` is called with `start: true`

## Error Responses (v3.1+)

Every tool error returns a **structured payload** so consumer agents can
decide retry strategy programmatically — no string parsing required:

```json
{
  "error":       "CDP connection lost: Inspector detached (reason=target closed)",
  "tool":        "execute_javascript",
  "reason_code": "inspector_detached",
  "recoverable": true,
  "next_action": "Call list_tabs and retry — the next request will reconnect lazily.",
  "cdp_extra":   { "cdp_reason": "target closed" }
}
```

| Field | Meaning |
|-------|---------|
| `error` | Human-readable message (unchanged from earlier versions) |
| `reason_code` | Machine-readable cause — switch on this, not the string |
| `recoverable` | `true` if retrying may succeed; `false` means surface to user |
| `next_action` | Concrete remediation hint for the failing `reason_code` |
| `cdp_extra` | Optional raw CDP context (e.g. close code, detach reason) |

Transport failures (a Chrome extension attaching via
`chrome.debugger.attach`, a closed tab, a quit browser) now fail in
**< 50 ms** instead of hanging for 30 s, and the **next** tool call
transparently re-establishes the CDP connection (lazy reconnect — no
manual restart needed).

Full `reason_code` taxonomy and recommended consumer-agent retry logic:
[`docs/RESILIENCE.md`](docs/RESILIENCE.md). Release notes:
[`CHANGELOG.md`](CHANGELOG.md).

## Troubleshooting

### "ECONNREFUSED" Error
The browser is not running with CDP enabled. Launch it with `--remote-debugging-port=9222`.

### "Page not found" Error
The target tab may have been closed. Call `list_tabs` to get current tab IDs.

### Port Already in Use
Another browser instance is using port 9222. Either close it or use a different port:
```bash
node server/index.js --browser chrome --port 9223
```

### Using with Existing Browser Profile
By default, `--user-data-dir` creates a separate profile. To use your existing profile, omit the flag — but note that only one Chrome instance can run at a time with CDP.

### Remote/Docker CDP
For remote browsers or Docker containers, use the `--host` argument:
```bash
node server/index.js --browser chrome --host 192.168.1.100 --port 9222
```

## Claude Code Skills (Powered by This Server)

A Claude Code skill consumes this CDP server for intelligent browser workflows:

| Skill | Version | Purpose | Command |
|-------|---------|---------|---------|
| **cdp-dev-companion** | v1.0.0 | Active development: verify code changes, test user flows, explore apps, delegate to AI assistants, iterate autonomously | `/cdp-dev-companion --mode verify\|test\|explore\|delegate\|iterate` |

Skills are defined in `~/.claude/commands/` and invoked as slash commands in Claude Code sessions.

## Multi-Browser Strategy

| Browser | Recommended Port | Primary Use |
|---------|-----------------|-------------|
| **Chrome** | 9222 | Dev server testing (localhost), visual verification, production site testing |
| **Comet** | 9223 | AI assistant delegation, multi-AI orchestration, side-by-side research |

Both browsers use this same unified server. The MCP tool prefix determines targeting:
- `mcp__chrome-control__<tool>` — Chrome
- `mcp__comet-control__<tool>` — Comet

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2024 | Original AppleScript-based, 11 tools, macOS only |
| 2.0 | 2026-03-16 | JS injection enhancement, 26 tools, macOS only |
| 3.0 | 2026-03-17 | Full CDP rewrite, 36 tools, cross-platform |
| 3.0.1 | 2026-03-18 | Documentation: added wrapper apps, skills reference, multi-browser strategy |
| 3.1.0 | 2026-05-14 | Resilience layer: handle WebSocket close/error + `Inspector.detached` + send-on-closed-socket; structured error metadata (`reason_code` / `recoverable` / `next_action`); lazy reconnect. See [`CHANGELOG.md`](CHANGELOG.md) and [`docs/RESILIENCE.md`](docs/RESILIENCE.md). |

## Requirements

- **Node.js**: 18.0+ (uses `node:http` built-in)
- **Browser**: Any Chromium-based browser with `--remote-debugging-port` flag
- **Dependencies**: `ws` (WebSocket client), `@modelcontextprotocol/sdk`

## License

MIT. See [LICENSE](LICENSE).

---

Built by [LostMind AI](https://www.lostmindai.com).
