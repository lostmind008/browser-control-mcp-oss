# Resilience Architecture

> Why and how Browser Control MCP Server **v3.1+** handles CDP transport
> failures. Companion to [`CHANGELOG.md`](../CHANGELOG.md) §3.1.0.

---

## 1. The Problem (pre-3.1)

The Chrome DevTools Protocol exposes its capabilities over a WebSocket — one
connection per debug target. The original `CDPClient` (3.0.x) handled only
the *happy path*:

```javascript
async connect() {
  return new Promise((resolve, reject) => {
    this.ws = new WebSocket(this.wsUrl, { perMessageDeflate: false });
    this.ws.on('open',  async () => { /* enable domains */ resolve(); });
    this.ws.on('error', reject);          // ← only fires BEFORE 'open'
  });
}
```

Once the socket was open there was **no `close` handler, no post-open
`error` handler**, and `send()` never checked `readyState` before calling
`ws.send()`. Post-connect failures were silently dropped.

Four real-world failure modes resulted:

| Scenario                                                          | Symptom                                              |
|-------------------------------------------------------------------|------------------------------------------------------|
| A Chrome extension calls `chrome.debugger.attach` on our target   | Every op hangs 30 s, then fails with no cause        |
| User closes the target tab while a tool call is in flight         | 30 s hang, then `CDP timeout`                        |
| Browser quits unexpectedly                                        | 30 s hang per call; stdio transport can go unhealthy |
| Network blip on the localhost CDP socket                          | 30 s hang                                            |

The **Claude for Chrome** extension's agent mode hits the first scenario
every time it enters its tool-use loop — that is the symptom that triggered
this work.

---

## 2. The Architectural Decision: Fail-Fast + Lazy Reconnect

Two patterns compete for transport-loss handling:

| Pattern             | Behaviour                                                                        | Best for                                           |
|---------------------|----------------------------------------------------------------------------------|----------------------------------------------------|
| **Eager reconnect** | Detect close, immediately re-open the socket, replay in-flight ops.              | Long-lived daemons, dashboards, realtime monitors. |
| **Lazy reconnect**  | Fail in-flight ops immediately; the *next* call opens a fresh connection.        | Tool servers, RPC interfaces, **MCP servers**.     |

**This server uses lazy reconnect.** Rationale:

1. The next tool call carries fresh context about whether the target is
   still meaningful. Eager-reconnecting to a closed tab is surprising;
   lazy reconnect lets the caller choose a different tab first.
2. A failed operation often carries semantics the caller must act on
   (*"the page reloaded — my fill result is moot"*). Eager reconnect masks
   this.
3. Mature CDP libraries — Puppeteer's `CDPSession`, `chrome-remote-interface`,
   Playwright's `CRBrowserContext` — all use lazy reconnect. Matching
   established convention reduces cognitive load for anyone reading this code.

---

## 3. Implementation Walkthrough

Five surgical changes in `server/index.js`. No behaviour flags — defensive
handling is universally correct, so it is unconditional.

### 3.1 WebSocket lifecycle handlers (`connect()`)

```javascript
this.ws.on('error', (err) => {
  if (!opened) reject(err);                                  // pre-open: fail connect()
  else this._failPending(`WebSocket error: ${err.message}`,  // post-open: fail pending
                          'websocket_error');
});
this.ws.on('close', (code, reason) => {
  this._failPending(
    `WebSocket closed (code=${code}${reason ? `, reason=${reason}` : ''})`,
    'websocket_closed',
    { code, reason: String(reason || '') }
  );
});
```

The `opened` boolean disambiguates a connect-time failure (reject the
`connect()` promise) from a mid-session drop (reject the pending ops).

### 3.2 `_failPending()` — the central cleanup

```javascript
_failPending(message, reasonCode = 'connection_lost', extra = {}) {
  const err = new Error(`CDP connection lost: ${message}`);
  err.cdpReasonCode  = reasonCode;
  err.cdpRecoverable = true;
  err.cdpExtra       = extra;
  for (const { reject } of this.pending.values()) reject(err);
  this.pending.clear();
}
```

Every transport-loss path funnels here. In-flight operations now reject in
**< 50 ms** rather than after the 30 s timeout. The error object carries
structured metadata that the MCP layer lifts into the response.

### 3.3 `Inspector.detached` interception (`_handleEvent()`)

```javascript
if (method === 'Inspector.detached') {
  this._failPending(
    `Inspector detached (reason=${params?.reason || 'unknown'})`,
    'inspector_detached',
    { cdp_reason: params?.reason || 'unknown' }
  );
  return;
}
```

Chromium 147 fires `Inspector.detached` with `reason: "target closed"`
~3–50 ms **before** the WebSocket actually closes when another debugger
attaches. Catching it first yields the precise `inspector_detached` reason
instead of the generic `websocket_closed` that would follow milliseconds later.

### 3.4 `send()` readyState guard

```javascript
if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
  const err = new Error('CDP socket not open ...');
  err.cdpReasonCode  = 'socket_not_open';
  err.cdpRecoverable = true;
  reject(err);
  return;
}
// ws.send() wrapped in try/catch → reason_code 'send_failed' on throw
```

Without the guard, `ws.send()` on a `CLOSING`/`CLOSED` socket throws
**synchronously**. A synchronous throw inside an MCP tool handler can take
down the entire stdio transport. The guard converts undefined-behaviour
into a defined Promise rejection.

### 3.5 Stale-connection cleanup (`getPageConnection()`)

```javascript
if (client.ws && client.ws.readyState === WebSocket.OPEN) return client;
try { await client.close(); } catch {}     // ← was missing: leaked the FD
pageConnections.delete(targetId);
```

---

## 4. Consumer-Agent Integration

Every tool error now returns a structured payload:

```json
{
  "error":       "CDP connection lost: Inspector detached (reason=target closed)",
  "tool":        "execute_javascript",
  "reason_code": "inspector_detached",
  "recoverable": true,
  "next_action": "The CDP target was taken over (e.g., a Chrome extension attached via chrome.debugger.attach) or closed. Call list_tabs and retry — the next request will reconnect lazily.",
  "cdp_extra":   { "cdp_reason": "target closed" }
}
```

### Recommended retry logic

```javascript
async function callToolResilient(name, args, { maxRetries = 1 } = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await mcpCall(name, args);
    if (!result.isError) return result;

    const p = JSON.parse(result.content[0].text);

    if (!p.recoverable) throw new Error(p.error);          // hard stop

    // Transient transport loss → one transparent retry (lazy reconnect
    // happens inside the server on the next getPageConnection()).
    if (['inspector_detached', 'websocket_closed', 'socket_not_open',
         'send_failed', 'websocket_error'].includes(p.reason_code)) {
      continue;
    }

    if (p.reason_code === 'tab_not_found') {
      // tabId is stale — surface choices to the user / re-list tabs
      const tabs = await mcpCall('list_tabs', {});
      throw new Error(`Tab gone. Available: ${tabs.content[0].text}`);
    }

    throw new Error(p.error);                              // unknown → surface
  }
}
```

### Full `reason_code` → action map

| Code                  | Cause                                            | Suggested consumer action                              |
|-----------------------|--------------------------------------------------|--------------------------------------------------------|
| `browser_not_running` | No `--remote-debugging-port`                      | Tell user to launch browser. **Do not retry.**         |
| `tab_not_found`       | Stale / closed `tabId`                            | `list_tabs`, surface alternatives.                     |
| `inspector_detached`  | Another debugger stole the target                 | Retry once; if persists, pick a different tab.         |
| `websocket_closed`    | Socket closed (`cdp_extra.code` has close code)   | Retry once (fresh connection established lazily).      |
| `websocket_error`     | Transport-level WS error                          | Retry once.                                            |
| `socket_not_open`     | `send()` on non-OPEN socket                       | Retry once.                                            |
| `send_failed`         | `ws.send()` threw synchronously                   | Retry once.                                            |
| `cdp_timeout`         | 30 s with no response                             | Page may be hung — reload or switch tab.               |
| `unknown`             | Unmatched error shape                             | Surface to user as-is.                                 |

---

## 5. Verification Scenarios

Manual scenarios that exercise the patch (latency = time-to-error):

| Scenario                                                         | Expected `reason_code`  | Expected latency |
|------------------------------------------------------------------|-------------------------|------------------|
| Claude for Chrome enters agent mode mid-tool-call                | `inspector_detached`    | < 50 ms          |
| User closes target tab while a call is in flight                 | `websocket_closed`      | < 100 ms         |
| User quits the browser mid-call                                  | `websocket_closed`      | < 200 ms         |
| Tool call against a deleted `tabId`                              | `tab_not_found`         | immediate        |
| Browser never started with `--remote-debugging-port`             | `browser_not_running`   | immediate        |

---

## 6. Non-Goals (deliberately excluded from 3.1)

- **Auto-reconnect with operation replay.** High complexity, marginal
  benefit; mature libraries avoid it for the same reasons.
- **Exponential backoff.** The lazy reconnect happens on the next tool
  call, which the consumer naturally throttles.
- **A flag to disable the new behaviour.** Defensive handling is strictly
  better than silent failure; no caller benefits from the old semantics.

If a future use case needs any of these, they can be added without
breaking the current contract.

---

## 7. References

- DevTools Protocol — `Inspector` domain:
  <https://chromedevtools.github.io/devtools-protocol/tot/Inspector/>
- `Inspector.detached` event:
  <https://chromedevtools.github.io/devtools-protocol/tot/Inspector/#event-detached>
- Puppeteer `CDPSession` (reference implementation of lazy reconnect):
  <https://github.com/puppeteer/puppeteer>
- `chrome-remote-interface` connection lifecycle:
  <https://github.com/cyrus-and/chrome-remote-interface>
