#!/usr/bin/env node
/**
 * Browser Control MCP Server v3.1.0
 * Unified CDP-based browser control for Chrome, Comet, Edge, Brave
 * Cross-platform: macOS, Linux, Windows, WSL, Docker
 *
 * Usage: node server/index.js --browser chrome|comet|edge|brave [--port 9222]
 *
 * Requires browser launched with: --remote-debugging-port=9222
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import http from 'node:http';
import WebSocket from 'ws';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
function getArg(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const BROWSER_NAME = getArg('browser', 'chrome');
const CDP_PORT = parseInt(getArg('port', '9222'), 10);
const CDP_HOST = getArg('host', '127.0.0.1');

const BROWSERS = {
  chrome:  { label: 'Google Chrome',  port: CDP_PORT },
  comet:   { label: 'Comet',          port: CDP_PORT },
  edge:    { label: 'Microsoft Edge',  port: CDP_PORT },
  brave:   { label: 'Brave Browser',   port: CDP_PORT },
};

const browserConfig = BROWSERS[BROWSER_NAME] || { label: BROWSER_NAME, port: CDP_PORT };

// ---------------------------------------------------------------------------
// HTTP helper (node:http — works on Node 18+)
// ---------------------------------------------------------------------------
function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    }).on('error', reject);
  });
}

function httpGetRaw(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// CDP Client — per-page WebSocket connection manager
// ---------------------------------------------------------------------------
class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.msgId = 0;
    this.pending = new Map();
    this.eventHandlers = new Map();
    this.consoleMessages = [];
    this.networkRequests = new Map();
    this.networkCapturing = false;
    this.dialogQueue = [];
  }

  async connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl, { perMessageDeflate: false });
      let opened = false;
      this.ws.on('open', async () => {
        opened = true;
        this._setupListeners();
        // Auto-enable essential domains
        await this.send('Runtime.enable');
        await this.send('Page.enable');
        await this.send('DOM.enable');
        resolve();
      });
      this.ws.on('error', (err) => {
        if (!opened) reject(err);
        else this._failPending(`WebSocket error: ${err.message}`, 'websocket_error');
      });
      this.ws.on('close', (code, reason) => {
        this._failPending(
          `WebSocket closed (code=${code}${reason ? `, reason=${reason}` : ''})`,
          'websocket_closed',
          { code, reason: String(reason || '') }
        );
      });
    });
  }

  _setupListeners() {
    this.ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      // Response to a command
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result || {});
        return;
      }

      // CDP event
      if (msg.method) {
        this._handleEvent(msg.method, msg.params);
      }
    });
  }

  _handleEvent(method, params) {
    // Inspector.detached fires when our debugger session is terminated —
    // typically because another debugger (e.g. chrome.debugger.attach from a
    // Chrome extension) took over the target, OR because the target itself
    // closed. Reject every pending op immediately so the consumer agent gets
    // an actionable error in <50ms instead of waiting 30s for the timeout.
    if (method === 'Inspector.detached') {
      this._failPending(
        `Inspector detached (reason=${params?.reason || 'unknown'})`,
        'inspector_detached',
        { cdp_reason: params?.reason || 'unknown' }
      );
      return;
    }

    // Console messages
    if (method === 'Runtime.consoleAPICalled') {
      const text = (params.args || []).map(a => a.value ?? a.description ?? JSON.stringify(a)).join(' ');
      this.consoleMessages.push({
        type: params.type,
        text,
        timestamp: params.timestamp,
      });
      if (this.consoleMessages.length > 500) this.consoleMessages.shift();
    }

    // JavaScript exceptions
    if (method === 'Runtime.exceptionThrown') {
      const ex = params.exceptionDetails;
      this.consoleMessages.push({
        type: 'error',
        text: ex.text || (ex.exception && (ex.exception.description || ex.exception.value)) || 'Unknown error',
        timestamp: params.timestamp,
      });
    }

    // Network events
    if (this.networkCapturing) {
      if (method === 'Network.requestWillBeSent') {
        this.networkRequests.set(params.requestId, {
          requestId: params.requestId,
          url: params.request.url,
          method: params.request.method,
          type: params.type,
          timestamp: params.timestamp,
          status: null,
          mimeType: null,
          responseHeaders: null,
        });
      }
      if (method === 'Network.responseReceived') {
        const entry = this.networkRequests.get(params.requestId);
        if (entry) {
          entry.status = params.response.status;
          entry.mimeType = params.response.mimeType;
          entry.responseHeaders = params.response.headers;
        }
      }
    }

    // Dialog events
    if (method === 'Page.javascriptDialogOpening') {
      this.dialogQueue.push({
        type: params.type,
        message: params.message,
        url: params.url,
        defaultPrompt: params.defaultPrompt,
      });
    }

    // Fire registered handlers
    const handlers = this.eventHandlers.get(method);
    if (handlers) handlers.forEach(fn => fn(params));
  }

  /**
   * Reject all pending CDP operations with a structured error.
   * Called when the underlying transport is lost (close / error / Inspector.detached)
   * so consumers fail fast in <50ms instead of hanging until the 30s timeout.
   */
  _failPending(message, reasonCode = 'connection_lost', extra = {}) {
    const err = new Error(`CDP connection lost: ${message}`);
    err.cdpReasonCode = reasonCode;
    err.cdpRecoverable = true;
    err.cdpExtra = extra;
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      // Guard: never call ws.send() on a closed/closing socket. Without this,
      // ws.send() throws synchronously and can take the MCP transport down.
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        const err = new Error(
          `CDP socket not open (readyState=${this.ws?.readyState}). ` +
          `Possible causes: tab closed, browser quit, network reset, or another debugger took over the target.`
        );
        err.cdpReasonCode = 'socket_not_open';
        err.cdpRecoverable = true;
        reject(err);
        return;
      }
      const id = ++this.msgId;
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (sendErr) {
        this.pending.delete(id);
        const wrapped = new Error(`Failed to send ${method}: ${sendErr.message}`);
        wrapped.cdpReasonCode = 'send_failed';
        wrapped.cdpRecoverable = true;
        reject(wrapped);
        return;
      }
      // Timeout after 30s
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          const err = new Error(`CDP timeout: ${method}`);
          err.cdpReasonCode = 'cdp_timeout';
          err.cdpRecoverable = true;
          reject(err);
        }
      }, 30000);
    });
  }

  on(event, fn) {
    if (!this.eventHandlers.has(event)) this.eventHandlers.set(event, []);
    this.eventHandlers.get(event).push(fn);
  }

  async close() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Connection pool — one CDPClient per page
// ---------------------------------------------------------------------------
const pageConnections = new Map(); // targetId → CDPClient
let browserWsUrl = null;
let browserClient = null;

async function getPages() {
  return httpGet(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
}

async function getVersion() {
  return httpGet(`http://${CDP_HOST}:${CDP_PORT}/json/version`);
}

async function getPageConnection(targetId) {
  if (pageConnections.has(targetId)) {
    const client = pageConnections.get(targetId);
    if (client.ws && client.ws.readyState === WebSocket.OPEN) return client;
    try { await client.close(); } catch {}
    pageConnections.delete(targetId);
  }
  const pages = await getPages();
  const page = pages.find(p => p.id === targetId);
  if (!page || !page.webSocketDebuggerUrl) {
    throw new Error(`Page ${targetId} not found or not debuggable`);
  }
  const client = new CDPClient(page.webSocketDebuggerUrl);
  await client.connect();
  pageConnections.set(targetId, client);
  return client;
}

async function getActivePageConnection() {
  const pages = await getPages();
  const page = pages.find(p => p.type === 'page') || pages[0];
  if (!page) throw new Error('No browser pages found. Is the browser running with --remote-debugging-port?');
  return getPageConnection(page.id);
}

async function findPageByUrl(url) {
  const pages = await getPages();
  return pages.find(p => p.url === url || p.url.includes(url));
}

async function getBrowserConnection() {
  if (browserClient && browserClient.ws && browserClient.ws.readyState === WebSocket.OPEN) {
    return browserClient;
  }
  const version = await getVersion();
  if (!version.webSocketDebuggerUrl) throw new Error('Browser-level WebSocket not available');
  browserClient = new CDPClient(version.webSocketDebuggerUrl);
  await browserClient.connect();
  return browserClient;
}

// ---------------------------------------------------------------------------
// Helper: resolve CSS selector to CDP nodeId and get box model for coordinates
// ---------------------------------------------------------------------------
async function resolveSelector(client, selector) {
  const doc = await client.send('DOM.getDocument', { depth: 0 });
  const result = await client.send('DOM.querySelector', {
    nodeId: doc.root.nodeId,
    selector,
  });
  if (!result.nodeId) throw new Error(`Element not found: ${selector}`);
  return result.nodeId;
}

async function getElementCenter(client, selector) {
  const nodeId = await resolveSelector(client, selector);
  const box = await client.send('DOM.getBoxModel', { nodeId });
  if (!box.model) throw new Error(`Cannot get box model for: ${selector}`);
  // content quad: [x1,y1, x2,y2, x3,y3, x4,y4]
  const q = box.model.content;
  const x = (q[0] + q[2] + q[4] + q[6]) / 4;
  const y = (q[1] + q[3] + q[5] + q[7]) / 4;
  return { x, y, nodeId };
}

// ---------------------------------------------------------------------------
// Helper: dispatch mouse event sequence
// ---------------------------------------------------------------------------
async function clickAt(client, x, y, options = {}) {
  const button = options.button || 'left';
  const clickCount = options.clickCount || 1;
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x, y,
  });
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button, clickCount,
  });
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button, clickCount,
  });
}

// ---------------------------------------------------------------------------
// Helper: type text character by character via Input.dispatchKeyEvent
// ---------------------------------------------------------------------------
async function typeText(client, text) {
  for (const char of text) {
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      text: char,
      unmodifiedText: char,
      key: char,
    });
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: char,
    });
  }
}

// ---------------------------------------------------------------------------
// Helper: press a named key (Enter, Tab, Escape, ArrowDown, etc.)
// ---------------------------------------------------------------------------
const KEY_CODES = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Space: { key: ' ', code: 'Space', keyCode: 32 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};

async function pressKey(client, keyName, modifiers = 0) {
  const keyDef = KEY_CODES[keyName] || { key: keyName, code: keyName, keyCode: 0 };
  await client.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: keyDef.key,
    code: keyDef.code,
    windowsVirtualKeyCode: keyDef.keyCode,
    nativeVirtualKeyCode: keyDef.keyCode,
    modifiers,
  });
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: keyDef.key,
    code: keyDef.code,
    windowsVirtualKeyCode: keyDef.keyCode,
    nativeVirtualKeyCode: keyDef.keyCode,
    modifiers,
  });
}

// ---------------------------------------------------------------------------
// Next-action hints — paired with reason_code in error responses so consumer
// agents can decide retry strategy without parsing error strings.
// ---------------------------------------------------------------------------
const NEXT_ACTION_HINTS = {
  browser_not_running: 'Start the browser with --remote-debugging-port and retry.',
  tab_not_found:       'Call list_tabs to discover currently-debuggable tabs, then retry with a valid tabId.',
  inspector_detached:  'The CDP target was taken over (e.g., a Chrome extension attached via chrome.debugger.attach) or closed. Call list_tabs and retry — the next request will reconnect lazily.',
  websocket_closed:    'The CDP socket closed. Likely causes: tab closed, browser quit, or another debugger took over. Call list_tabs and retry.',
  websocket_error:     'A WebSocket transport error occurred. Retry the operation — the connection will be re-established.',
  socket_not_open:     'The CDP socket is not currently open. Retry the operation — it will trigger a reconnect.',
  send_failed:         'Failed to send the CDP command. Retry — the connection will be re-established.',
  cdp_timeout:         'The CDP operation exceeded 30s. Try a different tab, reload the page, or check if the page is hung.',
};

// ---------------------------------------------------------------------------
// Tool Definitions (36 tools)
// ---------------------------------------------------------------------------
const TOOLS = [
  // --- Tab / Navigation ---
  {
    name: 'health_check',
    description: `Check if ${browserConfig.label} is running with CDP and accessible`,
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_tabs',
    description: `List all open tabs in ${browserConfig.label}`,
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_current_tab',
    description: `Get the active tab in ${browserConfig.label}`,
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'open_url',
    description: `Navigate a tab to a URL in ${browserConfig.label}`,
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to navigate to' },
        tabId: { type: 'string', description: 'Target tab ID (optional, uses active tab)' },
        waitForLoad: { type: 'boolean', description: 'Wait for page load to complete (default true)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'new_tab',
    description: `Open a new tab in ${browserConfig.label}`,
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to open (default about:blank)' },
      },
      required: [],
    },
  },
  {
    name: 'close_tab',
    description: `Close a tab in ${browserConfig.label}`,
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab ID to close' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'switch_to_tab',
    description: `Activate/focus a tab in ${browserConfig.label}`,
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab ID to activate' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'reload_tab',
    description: `Reload the current or specified tab`,
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab ID (optional)' },
        ignoreCache: { type: 'boolean', description: 'Hard reload bypassing cache' },
      },
      required: [],
    },
  },
  {
    name: 'go_back',
    description: `Navigate back in browser history`,
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab ID (optional)' },
      },
      required: [],
    },
  },
  {
    name: 'go_forward',
    description: `Navigate forward in browser history`,
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab ID (optional)' },
      },
      required: [],
    },
  },
  // --- JavaScript & Content ---
  {
    name: 'execute_javascript',
    description: `Execute JavaScript in the page context`,
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript code to execute' },
        tabId: { type: 'string', description: 'Tab ID (optional)' },
      },
      required: ['code'],
    },
  },
  {
    name: 'get_page_content',
    description: `Get the HTML content or text of the current page`,
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab ID (optional)' },
        format: { type: 'string', enum: ['html', 'text'], description: 'Return HTML or text (default text)' },
      },
      required: [],
    },
  },
  // --- Interaction ---
  {
    name: 'click',
    description: `Click an element using real CDP mouse events (works with any framework)`,
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the element to click' },
        tabId: { type: 'string', description: 'Tab ID (optional)' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default left)' },
        clickCount: { type: 'number', description: 'Number of clicks (2 for double-click)' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'fill',
    description: `Fill an input field with text (clears existing value, React-compatible)`,
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the input element' },
        value: { type: 'string', description: 'Text value to fill' },
        tabId: { type: 'string', description: 'Tab ID (optional)' },
      },
      required: ['selector', 'value'],
    },
  },
  {
    name: 'fill_form',
    description: `Fill multiple form fields at once`,
    inputSchema: {
      type: 'object',
      properties: {
        fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              selector: { type: 'string' },
              value: { type: 'string' },
            },
            required: ['selector', 'value'],
          },
          description: 'Array of {selector, value} pairs',
        },
        tabId: { type: 'string', description: 'Tab ID (optional)' },
      },
      required: ['fields'],
    },
  },
  {
    name: 'type_text',
    description: `Type text character-by-character using real keyboard events (triggers all JS handlers)`,
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector to focus first (optional)' },
        text: { type: 'string', description: 'Text to type' },
        tabId: { type: 'string', description: 'Tab ID (optional)' },
      },
      required: ['text'],
    },
  },
  {
    name: 'hover',
    description: `Hover over an element using real mouse movement`,
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the element' },
        tabId: { type: 'string', description: 'Tab ID (optional)' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'press_key',
    description: `Press a keyboard key (Enter, Tab, Escape, ArrowDown, etc.)`,
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key name (Enter, Tab, Escape, Backspace, ArrowUp, ArrowDown, etc.)' },
        tabId: { type: 'string', description: 'Tab ID (optional)' },
        modifiers: { type: 'number', description: 'Modifier flags: 1=Alt, 2=Ctrl, 4=Meta/Cmd, 8=Shift' },
      },
      required: ['key'],
    },
  },
  {
    name: 'select_option',
    description: `Select an option in a <select> dropdown`,
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the <select> element' },
        value: { type: 'string', description: 'Option value to select' },
        tabId: { type: 'string', description: 'Tab ID (optional)' },
      },
      required: ['selector', 'value'],
    },
  },
  {
    name: 'scroll',
    description: `Scroll the page or a specific element`,
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector to scroll (optional, defaults to page)' },
        x: { type: 'number', description: 'Horizontal scroll amount in pixels' },
        y: { type: 'number', description: 'Vertical scroll amount in pixels' },
        tabId: { type: 'string', description: 'Tab ID (optional)' },
      },
      required: ['y'],
    },
  },
  {
    name: 'drag',
    description: `Drag from one element/position to another`,
    inputSchema: {
      type: 'object',
      properties: {
        sourceSelector: { type: 'string', description: 'CSS selector of element to drag' },
        targetSelector: { type: 'string', description: 'CSS selector of drop target' },
        tabId: { type: 'string', description: 'Tab ID (optional)' },
      },
      required: ['sourceSelector', 'targetSelector'],
    },
  },
  {
    name: 'wait_for',
    description: `Wait for an element to appear, a condition, or a timeout`,
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector to wait for (optional)' },
        condition: { type: 'string', description: 'JavaScript expression that returns truthy (optional)' },
        timeout: { type: 'number', description: 'Max wait time in ms (default 10000)' },
        tabId: { type: 'string', description: 'Tab ID (optional)' },
      },
      required: [],
    },
  },
  // --- Screenshots & Snapshots ---
  {
    name: 'take_screenshot',
    description: `Capture a screenshot of the page (returns base64 PNG)`,
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab ID (optional)' },
        fullPage: { type: 'boolean', description: 'Capture full scrollable page (default false)' },
        selector: { type: 'string', description: 'CSS selector to screenshot a specific element' },
        quality: { type: 'number', description: 'JPEG quality 0-100 (if format is jpeg)' },
        format: { type: 'string', enum: ['png', 'jpeg', 'webp'], description: 'Image format (default png)' },
      },
      required: [],
    },
  },
  {
    name: 'take_snapshot',
    description: `Get a structured text snapshot of the page DOM (useful for AI understanding)`,
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab ID (optional)' },
      },
      required: [],
    },
  },
  {
    name: 'print_to_pdf',
    description: `Generate a PDF of the current page`,
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab ID (optional)' },
        landscape: { type: 'boolean', description: 'Landscape orientation' },
        printBackground: { type: 'boolean', description: 'Print background graphics (default true)' },
      },
      required: [],
    },
  },
  {
    name: 'resize_window',
    description: `Resize the browser viewport`,
    inputSchema: {
      type: 'object',
      properties: {
        width: { type: 'number', description: 'Viewport width in pixels' },
        height: { type: 'number', description: 'Viewport height in pixels' },
        tabId: { type: 'string', description: 'Tab ID (optional)' },
      },
      required: ['width', 'height'],
    },
  },
  // --- Device Emulation ---
  {
    name: 'emulate',
    description: `Emulate a mobile device or custom viewport (user agent, dimensions, touch, DPR)`,
    inputSchema: {
      type: 'object',
      properties: {
        device: { type: 'string', description: 'Preset: iphone-14, ipad, pixel-7, galaxy-s23 (optional)' },
        width: { type: 'number', description: 'Custom viewport width' },
        height: { type: 'number', description: 'Custom viewport height' },
        deviceScaleFactor: { type: 'number', description: 'Device pixel ratio (default 1)' },
        mobile: { type: 'boolean', description: 'Enable mobile mode' },
        userAgent: { type: 'string', description: 'Custom user agent string' },
        tabId: { type: 'string', description: 'Tab ID (optional)' },
      },
      required: [],
    },
  },
  // --- File Upload ---
  {
    name: 'upload_file',
    description: `Upload file(s) to a file input element`,
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the <input type="file"> element' },
        files: { type: 'array', items: { type: 'string' }, description: 'Array of absolute file paths to upload' },
        tabId: { type: 'string', description: 'Tab ID (optional)' },
      },
      required: ['selector', 'files'],
    },
  },
  // --- Dialogs ---
  {
    name: 'handle_dialog',
    description: `Handle a JavaScript dialog (alert, confirm, prompt)`,
    inputSchema: {
      type: 'object',
      properties: {
        accept: { type: 'boolean', description: 'Accept (true) or dismiss (false) the dialog' },
        promptText: { type: 'string', description: 'Text to enter for prompt dialogs' },
        tabId: { type: 'string', description: 'Tab ID (optional)' },
      },
      required: ['accept'],
    },
  },
  // --- Accessibility ---
  {
    name: 'get_accessibility_tree',
    description: `Get the full accessibility tree of the page (ideal for AI understanding of page structure)`,
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab ID (optional)' },
      },
      required: [],
    },
  },
  // --- Console & Network ---
  {
    name: 'console_messages',
    description: `Get captured console messages from the page`,
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab ID (optional)' },
        clear: { type: 'boolean', description: 'Clear messages after retrieving (default false)' },
      },
      required: [],
    },
  },
  {
    name: 'network_requests',
    description: `Get captured network requests (must call once to start capturing)`,
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab ID (optional)' },
        start: { type: 'boolean', description: 'Start capturing network requests (call once before monitoring)' },
        clear: { type: 'boolean', description: 'Clear captured requests (default false)' },
      },
      required: [],
    },
  },
  {
    name: 'get_response_body',
    description: `Get the response body of a captured network request`,
    inputSchema: {
      type: 'object',
      properties: {
        requestId: { type: 'string', description: 'Request ID from network_requests output' },
        tabId: { type: 'string', description: 'Tab ID (optional)' },
      },
      required: ['requestId'],
    },
  },
  {
    name: 'get_cookies',
    description: `Get cookies for the current page or a specific URL`,
    inputSchema: {
      type: 'object',
      properties: {
        urls: { type: 'array', items: { type: 'string' }, description: 'URLs to get cookies for (optional)' },
        tabId: { type: 'string', description: 'Tab ID (optional)' },
      },
      required: [],
    },
  },
  // --- Performance ---
  {
    name: 'performance_start_trace',
    description: `Start a performance trace (CPU profiling, rendering, etc.)`,
    inputSchema: {
      type: 'object',
      properties: {
        categories: {
          type: 'string',
          description: 'Comma-separated trace categories (default: all standard categories)',
        },
      },
      required: [],
    },
  },
  {
    name: 'performance_stop_trace',
    description: `Stop performance trace and return results`,
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

// ---------------------------------------------------------------------------
// Device Presets for Emulation
// ---------------------------------------------------------------------------
const DEVICE_PRESETS = {
  'iphone-14': { width: 390, height: 844, deviceScaleFactor: 3, mobile: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' },
  'iphone-14-pro-max': { width: 430, height: 932, deviceScaleFactor: 3, mobile: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' },
  'ipad': { width: 810, height: 1080, deviceScaleFactor: 2, mobile: true, userAgent: 'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' },
  'ipad-pro': { width: 1024, height: 1366, deviceScaleFactor: 2, mobile: true, userAgent: 'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' },
  'pixel-7': { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true, userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36' },
  'galaxy-s23': { width: 360, height: 780, deviceScaleFactor: 3, mobile: true, userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36' },
};

// ---------------------------------------------------------------------------
// Trace buffer for performance tracing
// ---------------------------------------------------------------------------
let traceEvents = [];
let traceActive = false;

// ---------------------------------------------------------------------------
// Tool Handlers
// ---------------------------------------------------------------------------
async function handleTool(name, args) {
  switch (name) {

    // -----------------------------------------------------------------------
    case 'health_check': {
      try {
        const version = await getVersion();
        const pages = await getPages();
        return {
          status: 'connected',
          browser: version['Browser'] || browserConfig.label,
          protocol: version['Protocol-Version'],
          userAgent: version['User-Agent'],
          v8Version: version['V8-Version'],
          webkitVersion: version['WebKit-Version'],
          tabs: pages.length,
          cdpEndpoint: `http://${CDP_HOST}:${CDP_PORT}`,
        };
      } catch (e) {
        return {
          status: 'disconnected',
          error: e.message,
          hint: `Launch ${browserConfig.label} with: --remote-debugging-port=${CDP_PORT}`,
        };
      }
    }

    // -----------------------------------------------------------------------
    case 'list_tabs': {
      const pages = await getPages();
      return pages
        .filter(p => p.type === 'page')
        .map(p => ({
          id: p.id,
          title: p.title,
          url: p.url,
          type: p.type,
        }));
    }

    // -----------------------------------------------------------------------
    case 'get_current_tab': {
      const pages = await getPages();
      const page = pages.find(p => p.type === 'page') || pages[0];
      if (!page) return { error: 'No tabs found' };
      return { id: page.id, title: page.title, url: page.url };
    }

    // -----------------------------------------------------------------------
    case 'open_url': {
      const client = args.tabId
        ? await getPageConnection(args.tabId)
        : await getActivePageConnection();
      const waitForLoad = args.waitForLoad !== false;
      if (waitForLoad) {
        const loadPromise = new Promise((resolve) => {
          const handler = () => { resolve(); };
          client.on('Page.loadEventFired', handler);
          // Timeout fallback
          setTimeout(resolve, 15000);
        });
        await client.send('Page.navigate', { url: args.url });
        await loadPromise;
      } else {
        await client.send('Page.navigate', { url: args.url });
      }
      return { success: true, url: args.url };
    }

    // -----------------------------------------------------------------------
    case 'new_tab': {
      const url = args.url || 'about:blank';
      const result = await httpGet(`http://${CDP_HOST}:${CDP_PORT}/json/new?${url}`);
      return { id: result.id, title: result.title, url: result.url };
    }

    // -----------------------------------------------------------------------
    case 'close_tab': {
      await httpGetRaw(`http://${CDP_HOST}:${CDP_PORT}/json/close/${args.tabId}`);
      if (pageConnections.has(args.tabId)) {
        const client = pageConnections.get(args.tabId);
        await client.close();
        pageConnections.delete(args.tabId);
      }
      return { success: true, closedTabId: args.tabId };
    }

    // -----------------------------------------------------------------------
    case 'switch_to_tab': {
      await httpGetRaw(`http://${CDP_HOST}:${CDP_PORT}/json/activate/${args.tabId}`);
      return { success: true, activatedTabId: args.tabId };
    }

    // -----------------------------------------------------------------------
    case 'reload_tab': {
      const client = args.tabId
        ? await getPageConnection(args.tabId)
        : await getActivePageConnection();
      await client.send('Page.reload', {
        ignoreCache: args.ignoreCache || false,
      });
      return { success: true };
    }

    // -----------------------------------------------------------------------
    case 'go_back': {
      const client = args.tabId
        ? await getPageConnection(args.tabId)
        : await getActivePageConnection();
      const history = await client.send('Page.getNavigationHistory');
      if (history.currentIndex > 0) {
        const entry = history.entries[history.currentIndex - 1];
        await client.send('Page.navigateToHistoryEntry', { entryId: entry.id });
        return { success: true, url: entry.url };
      }
      return { success: false, reason: 'Already at first page in history' };
    }

    // -----------------------------------------------------------------------
    case 'go_forward': {
      const client = args.tabId
        ? await getPageConnection(args.tabId)
        : await getActivePageConnection();
      const history = await client.send('Page.getNavigationHistory');
      if (history.currentIndex < history.entries.length - 1) {
        const entry = history.entries[history.currentIndex + 1];
        await client.send('Page.navigateToHistoryEntry', { entryId: entry.id });
        return { success: true, url: entry.url };
      }
      return { success: false, reason: 'Already at last page in history' };
    }

    // -----------------------------------------------------------------------
    case 'execute_javascript': {
      const client = args.tabId
        ? await getPageConnection(args.tabId)
        : await getActivePageConnection();
      const result = await client.send('Runtime.evaluate', {
        expression: args.code,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      });
      if (result.exceptionDetails) {
        return { error: result.exceptionDetails.text || 'JavaScript error' };
      }
      return { result: result.result?.value ?? result.result?.description ?? null };
    }

    // -----------------------------------------------------------------------
    case 'get_page_content': {
      const client = args.tabId
        ? await getPageConnection(args.tabId)
        : await getActivePageConnection();
      const format = args.format || 'text';
      if (format === 'html') {
        const result = await client.send('Runtime.evaluate', {
          expression: 'document.documentElement.outerHTML',
          returnByValue: true,
        });
        return { content: result.result?.value };
      }
      // Text extraction
      const result = await client.send('Runtime.evaluate', {
        expression: `(function() {
          const sel = window.getSelection();
          sel.removeAllRanges();
          const range = document.createRange();
          range.selectNodeContents(document.body);
          sel.addRange(range);
          const text = sel.toString();
          sel.removeAllRanges();
          return text;
        })()`,
        returnByValue: true,
      });
      return { content: result.result?.value };
    }

    // -----------------------------------------------------------------------
    case 'click': {
      const client = args.tabId
        ? await getPageConnection(args.tabId)
        : await getActivePageConnection();
      const { x, y } = await getElementCenter(client, args.selector);
      await clickAt(client, x, y, {
        button: args.button || 'left',
        clickCount: args.clickCount || 1,
      });
      return { success: true, selector: args.selector, position: { x, y } };
    }

    // -----------------------------------------------------------------------
    case 'fill': {
      const client = args.tabId
        ? await getPageConnection(args.tabId)
        : await getActivePageConnection();
      // Focus the element, clear it, then set value (React-compatible)
      const { x, y } = await getElementCenter(client, args.selector);
      await clickAt(client, x, y);
      await client.send('Runtime.evaluate', {
        expression: `(function() {
          const el = document.querySelector(${JSON.stringify(args.selector)});
          if (!el) throw new Error('Element not found');
          el.focus();
          // React-compatible value setting
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
          )?.set || Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, 'value'
          )?.set;
          if (nativeInputValueSetter) {
            nativeInputValueSetter.call(el, ${JSON.stringify(args.value)});
          } else {
            el.value = ${JSON.stringify(args.value)};
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()`,
        returnByValue: true,
        userGesture: true,
      });
      return { success: true, selector: args.selector, value: args.value };
    }

    // -----------------------------------------------------------------------
    case 'fill_form': {
      const client = args.tabId
        ? await getPageConnection(args.tabId)
        : await getActivePageConnection();
      const results = [];
      for (const field of args.fields) {
        try {
          const { x, y } = await getElementCenter(client, field.selector);
          await clickAt(client, x, y);
          await client.send('Runtime.evaluate', {
            expression: `(function() {
              const el = document.querySelector(${JSON.stringify(field.selector)});
              if (!el) throw new Error('Element not found');
              el.focus();
              const setter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, 'value'
              )?.set || Object.getOwnPropertyDescriptor(
                window.HTMLTextAreaElement.prototype, 'value'
              )?.set;
              if (setter) setter.call(el, ${JSON.stringify(field.value)});
              else el.value = ${JSON.stringify(field.value)};
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            })()`,
            returnByValue: true,
            userGesture: true,
          });
          results.push({ selector: field.selector, success: true });
        } catch (e) {
          results.push({ selector: field.selector, success: false, error: e.message });
        }
      }
      return { results };
    }

    // -----------------------------------------------------------------------
    case 'type_text': {
      const client = args.tabId
        ? await getPageConnection(args.tabId)
        : await getActivePageConnection();
      if (args.selector) {
        const { x, y } = await getElementCenter(client, args.selector);
        await clickAt(client, x, y);
      }
      await typeText(client, args.text);
      return { success: true, textLength: args.text.length };
    }

    // -----------------------------------------------------------------------
    case 'hover': {
      const client = args.tabId
        ? await getPageConnection(args.tabId)
        : await getActivePageConnection();
      const { x, y } = await getElementCenter(client, args.selector);
      await client.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x, y,
      });
      return { success: true, selector: args.selector, position: { x, y } };
    }

    // -----------------------------------------------------------------------
    case 'press_key': {
      const client = args.tabId
        ? await getPageConnection(args.tabId)
        : await getActivePageConnection();
      await pressKey(client, args.key, args.modifiers || 0);
      return { success: true, key: args.key };
    }

    // -----------------------------------------------------------------------
    case 'select_option': {
      const client = args.tabId
        ? await getPageConnection(args.tabId)
        : await getActivePageConnection();
      const result = await client.send('Runtime.evaluate', {
        expression: `(function() {
          const el = document.querySelector(${JSON.stringify(args.selector)});
          if (!el || el.tagName !== 'SELECT') throw new Error('Select element not found');
          el.value = ${JSON.stringify(args.value)};
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return el.value;
        })()`,
        returnByValue: true,
        userGesture: true,
      });
      return { success: true, selectedValue: result.result?.value };
    }

    // -----------------------------------------------------------------------
    case 'scroll': {
      const client = args.tabId
        ? await getPageConnection(args.tabId)
        : await getActivePageConnection();
      if (args.selector) {
        await client.send('Runtime.evaluate', {
          expression: `document.querySelector(${JSON.stringify(args.selector)}).scrollBy(${args.x || 0}, ${args.y || 0})`,
          returnByValue: true,
        });
      } else {
        await client.send('Runtime.evaluate', {
          expression: `window.scrollBy(${args.x || 0}, ${args.y || 0})`,
          returnByValue: true,
        });
      }
      return { success: true, scrolled: { x: args.x || 0, y: args.y || 0 } };
    }

    // -----------------------------------------------------------------------
    case 'drag': {
      const client = args.tabId
        ? await getPageConnection(args.tabId)
        : await getActivePageConnection();
      const src = await getElementCenter(client, args.sourceSelector);
      const tgt = await getElementCenter(client, args.targetSelector);

      // Mouse down on source
      await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: src.x, y: src.y });
      await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: src.x, y: src.y, button: 'left', clickCount: 1 });

      // Move to target in steps for realistic drag
      const steps = 10;
      for (let i = 1; i <= steps; i++) {
        const x = src.x + (tgt.x - src.x) * (i / steps);
        const y = src.y + (tgt.y - src.y) * (i / steps);
        await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      }

      // Release on target
      await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tgt.x, y: tgt.y, button: 'left', clickCount: 1 });

      return { success: true, from: { x: src.x, y: src.y }, to: { x: tgt.x, y: tgt.y } };
    }

    // -----------------------------------------------------------------------
    case 'wait_for': {
      const client = args.tabId
        ? await getPageConnection(args.tabId)
        : await getActivePageConnection();
      const timeout = args.timeout || 10000;
      const startTime = Date.now();

      if (args.selector) {
        while (Date.now() - startTime < timeout) {
          const result = await client.send('Runtime.evaluate', {
            expression: `!!document.querySelector(${JSON.stringify(args.selector)})`,
            returnByValue: true,
          });
          if (result.result?.value) return { success: true, found: true, elapsed: Date.now() - startTime };
          await new Promise(r => setTimeout(r, 200));
        }
        return { success: false, reason: 'Timeout waiting for selector', selector: args.selector };
      }

      if (args.condition) {
        while (Date.now() - startTime < timeout) {
          const result = await client.send('Runtime.evaluate', {
            expression: args.condition,
            returnByValue: true,
          });
          if (result.result?.value) return { success: true, conditionMet: true, elapsed: Date.now() - startTime };
          await new Promise(r => setTimeout(r, 200));
        }
        return { success: false, reason: 'Timeout waiting for condition' };
      }

      // Just wait for the timeout duration
      await new Promise(r => setTimeout(r, timeout));
      return { success: true, waited: timeout };
    }

    // -----------------------------------------------------------------------
    case 'take_screenshot': {
      const client = args.tabId
        ? await getPageConnection(args.tabId)
        : await getActivePageConnection();
      const params = {
        format: args.format || 'png',
      };
      if (args.quality && params.format === 'jpeg') {
        params.quality = args.quality;
      }
      if (args.fullPage) {
        // Get full page dimensions
        const metrics = await client.send('Page.getLayoutMetrics');
        const contentSize = metrics.cssContentSize || metrics.contentSize;
        params.clip = {
          x: 0, y: 0,
          width: contentSize.width,
          height: contentSize.height,
          scale: 1,
        };
      }
      if (args.selector) {
        const nodeId = await resolveSelector(client, args.selector);
        const box = await client.send('DOM.getBoxModel', { nodeId });
        if (box.model) {
          const q = box.model.border;
          params.clip = {
            x: q[0], y: q[1],
            width: q[2] - q[0],
            height: q[5] - q[1],
            scale: 1,
          };
        }
      }
      const result = await client.send('Page.captureScreenshot', params);
      return {
        success: true,
        format: params.format,
        dataLength: result.data.length,
        base64: result.data,
      };
    }

    // -----------------------------------------------------------------------
    case 'take_snapshot': {
      const client = args.tabId
        ? await getPageConnection(args.tabId)
        : await getActivePageConnection();
      const result = await client.send('Runtime.evaluate', {
        expression: `(function snapshot(el, depth) {
          if (depth > 6) return '';
          el = el || document.body;
          let out = '';
          for (const child of el.children) {
            const tag = child.tagName.toLowerCase();
            const skip = ['script','style','noscript','svg','path'];
            if (skip.includes(tag)) continue;
            const text = child.childNodes.length === 1 && child.childNodes[0].nodeType === 3
              ? child.textContent.trim().substring(0, 100)
              : '';
            const attrs = [];
            if (child.id) attrs.push('id=' + child.id);
            if (child.className && typeof child.className === 'string') attrs.push('class=' + child.className.split(' ').slice(0,3).join('.'));
            if (child.href) attrs.push('href=' + child.href.substring(0, 80));
            if (child.src) attrs.push('src=' + child.src.substring(0, 80));
            if (child.type) attrs.push('type=' + child.type);
            if (child.name) attrs.push('name=' + child.name);
            if (child.value) attrs.push('value=' + child.value.substring(0, 50));
            if (child.placeholder) attrs.push('placeholder=' + child.placeholder);
            const indent = '  '.repeat(depth);
            const attrStr = attrs.length ? ' ' + attrs.join(' ') : '';
            out += indent + '<' + tag + attrStr + '>' + (text ? ' ' + text : '') + '\\n';
            out += snapshot(child, depth + 1);
          }
          return out;
        })(document.body, 0)`,
        returnByValue: true,
      });
      return { snapshot: result.result?.value || '' };
    }

    // -----------------------------------------------------------------------
    case 'print_to_pdf': {
      const client = args.tabId
        ? await getPageConnection(args.tabId)
        : await getActivePageConnection();
      const result = await client.send('Page.printToPDF', {
        landscape: args.landscape || false,
        printBackground: args.printBackground !== false,
        preferCSSPageSize: true,
      });
      return {
        success: true,
        dataLength: result.data.length,
        base64: result.data,
      };
    }

    // -----------------------------------------------------------------------
    case 'resize_window': {
      const client = args.tabId
        ? await getPageConnection(args.tabId)
        : await getActivePageConnection();
      await client.send('Emulation.setDeviceMetricsOverride', {
        width: args.width,
        height: args.height,
        deviceScaleFactor: 0,
        mobile: false,
      });
      return { success: true, width: args.width, height: args.height };
    }

    // -----------------------------------------------------------------------
    case 'emulate': {
      const client = args.tabId
        ? await getPageConnection(args.tabId)
        : await getActivePageConnection();
      let config = {};
      if (args.device && DEVICE_PRESETS[args.device]) {
        config = { ...DEVICE_PRESETS[args.device] };
      }
      // Allow overrides
      if (args.width) config.width = args.width;
      if (args.height) config.height = args.height;
      if (args.deviceScaleFactor !== undefined) config.deviceScaleFactor = args.deviceScaleFactor;
      if (args.mobile !== undefined) config.mobile = args.mobile;

      await client.send('Emulation.setDeviceMetricsOverride', {
        width: config.width || 375,
        height: config.height || 812,
        deviceScaleFactor: config.deviceScaleFactor || 1,
        mobile: config.mobile || false,
      });

      if (config.userAgent || args.userAgent) {
        await client.send('Emulation.setUserAgentOverride', {
          userAgent: args.userAgent || config.userAgent,
        });
      }

      if (config.mobile) {
        await client.send('Emulation.setTouchEmulationEnabled', {
          enabled: true,
          maxTouchPoints: 5,
        });
      }

      return { success: true, emulation: config };
    }

    // -----------------------------------------------------------------------
    case 'upload_file': {
      const client = args.tabId
        ? await getPageConnection(args.tabId)
        : await getActivePageConnection();
      const nodeId = await resolveSelector(client, args.selector);
      await client.send('DOM.setFileInputFiles', {
        nodeId,
        files: args.files,
      });
      return { success: true, files: args.files };
    }

    // -----------------------------------------------------------------------
    case 'handle_dialog': {
      const client = args.tabId
        ? await getPageConnection(args.tabId)
        : await getActivePageConnection();
      await client.send('Page.handleJavaScriptDialog', {
        accept: args.accept,
        promptText: args.promptText || '',
      });
      const dialogInfo = client.dialogQueue.shift();
      return { success: true, dialog: dialogInfo || { handled: true } };
    }

    // -----------------------------------------------------------------------
    case 'get_accessibility_tree': {
      const client = args.tabId
        ? await getPageConnection(args.tabId)
        : await getActivePageConnection();
      await client.send('Accessibility.enable');
      const result = await client.send('Accessibility.getFullAXTree');
      // Simplify the tree for readability
      const simplified = (result.nodes || [])
        .filter(n => n.role?.value !== 'none' && n.role?.value !== 'generic')
        .map(n => ({
          role: n.role?.value,
          name: n.name?.value,
          value: n.value?.value,
          description: n.description?.value,
          properties: (n.properties || [])
            .filter(p => ['checked', 'disabled', 'expanded', 'selected', 'required', 'level'].includes(p.name))
            .map(p => ({ [p.name]: p.value?.value })),
          childCount: n.childIds?.length || 0,
        }))
        .filter(n => n.name || n.value || n.role !== 'StaticText');
      return { nodeCount: simplified.length, tree: simplified };
    }

    // -----------------------------------------------------------------------
    case 'console_messages': {
      const client = args.tabId
        ? await getPageConnection(args.tabId)
        : await getActivePageConnection();
      const messages = [...client.consoleMessages];
      if (args.clear) client.consoleMessages.length = 0;
      return { count: messages.length, messages };
    }

    // -----------------------------------------------------------------------
    case 'network_requests': {
      const client = args.tabId
        ? await getPageConnection(args.tabId)
        : await getActivePageConnection();
      if (args.start && !client.networkCapturing) {
        await client.send('Network.enable');
        client.networkCapturing = true;
        return { success: true, status: 'Network capturing started' };
      }
      const requests = Array.from(client.networkRequests.values());
      if (args.clear) client.networkRequests.clear();
      return { count: requests.length, requests };
    }

    // -----------------------------------------------------------------------
    case 'get_response_body': {
      const client = args.tabId
        ? await getPageConnection(args.tabId)
        : await getActivePageConnection();
      if (!client.networkCapturing) {
        return { error: 'Network capturing not started. Call network_requests with start=true first.' };
      }
      const result = await client.send('Network.getResponseBody', {
        requestId: args.requestId,
      });
      return { body: result.body, base64Encoded: result.base64Encoded };
    }

    // -----------------------------------------------------------------------
    case 'get_cookies': {
      const client = args.tabId
        ? await getPageConnection(args.tabId)
        : await getActivePageConnection();
      const params = {};
      if (args.urls) params.urls = args.urls;
      const result = await client.send('Network.getCookies', params);
      return {
        count: result.cookies.length,
        cookies: result.cookies.map(c => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          expires: c.expires,
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: c.sameSite,
        })),
      };
    }

    // -----------------------------------------------------------------------
    case 'performance_start_trace': {
      const bClient = await getBrowserConnection();
      traceEvents = [];
      traceActive = true;

      bClient.on('Tracing.dataCollected', (params) => {
        traceEvents.push(...(params.value || []));
      });

      const categories = args.categories ||
        '-*,devtools.timeline,v8.execute,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.frame';

      await bClient.send('Tracing.start', {
        traceConfig: {
          recordMode: 'recordUntilFull',
          includedCategories: categories.split(','),
        },
      });
      return { success: true, status: 'Tracing started' };
    }

    // -----------------------------------------------------------------------
    case 'performance_stop_trace': {
      if (!traceActive) return { error: 'No active trace. Call performance_start_trace first.' };
      const bClient = await getBrowserConnection();

      const endPromise = new Promise((resolve) => {
        bClient.on('Tracing.tracingComplete', () => resolve());
        setTimeout(resolve, 10000);
      });

      await bClient.send('Tracing.end');
      await endPromise;
      traceActive = false;

      // Summarise trace events
      const summary = {
        totalEvents: traceEvents.length,
        categories: {},
        topEvents: [],
      };

      for (const evt of traceEvents) {
        const cat = evt.cat || 'other';
        summary.categories[cat] = (summary.categories[cat] || 0) + 1;
      }

      // Top 20 longest events
      const sorted = traceEvents
        .filter(e => e.dur)
        .sort((a, b) => (b.dur || 0) - (a.dur || 0))
        .slice(0, 20);

      summary.topEvents = sorted.map(e => ({
        name: e.name,
        category: e.cat,
        duration_ms: (e.dur / 1000).toFixed(2),
      }));

      return summary;
    }

    // -----------------------------------------------------------------------
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ---------------------------------------------------------------------------
// MCP Server Setup
// ---------------------------------------------------------------------------
const server = new Server(
  {
    name: `${BROWSER_NAME}-control`,
    version: '3.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const result = await handleTool(name, args || {});
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    // Structured error payload — consumer agents get machine-readable
    // reason_code + recoverable + next_action so they can decide retry
    // strategy without parsing error strings.
    const reasonCode = error.cdpReasonCode || (
      error.message.includes('ECONNREFUSED')                   ? 'browser_not_running' :
      error.message.includes('not found or not debuggable')    ? 'tab_not_found' :
      'unknown'
    );
    const recoverable = error.cdpRecoverable !== undefined ? error.cdpRecoverable : true;
    const nextAction  = NEXT_ACTION_HINTS[reasonCode] || null;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error:       error.message,
            tool:        name,
            reason_code: reasonCode,
            recoverable,
            next_action: nextAction,
            cdp_extra:   error.cdpExtra || undefined,
            hint: reasonCode === 'browser_not_running'
              ? `${browserConfig.label} is not running with CDP. Launch with: --remote-debugging-port=${CDP_PORT}`
              : undefined,
          }, null, 2),
        },
      ],
      isError: true,
    };
  }
});

// ---------------------------------------------------------------------------
// Start Server
// ---------------------------------------------------------------------------
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Browser Control MCP server v3.1.0 (${browserConfig.label}) running on stdio [CDP port: ${CDP_PORT}]`);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
