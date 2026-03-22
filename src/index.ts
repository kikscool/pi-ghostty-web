/**
 * pi-ghostty-web
 *
 * Pi extension that provides web-based terminal access to the current
 * working directory using ghostty-web (Ghostty's VT100 parser via WASM)
 * on the frontend and a real PTY on the backend.
 *
 * Usage:
 *   - Install: add "pi-ghostty-web" to packages in ~/.pi/agent/settings.json
 *   - /web          -- start the web terminal server (default port 7681)
 *   - /web stop     -- stop the server
 *   - /web <port>   -- start on a specific port
 *
 * Each WebSocket connection spawns a new shell session in the pi CWD.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { networkInterfaces } from "node:os";
import { join, extname } from "node:path";
import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn, type IPty } from "@lydell/node-pty";
import { WebSocketServer, type WebSocket } from "ws";

const DEFAULT_PORT = 7681;
const HEARTBEAT_INTERVAL_MS = 20_000;
const PORT_RETRY_MAX = 10;

function getLanIp(): string {
	const nets = networkInterfaces();
	// Prefer common interface names (WiFi/Ethernet)
	for (const name of ["en0", "en1", "eth0", "wlan0"]) {
		for (const net of nets[name] ?? []) {
			if (net.family === "IPv4" && !net.internal) return net.address;
		}
	}
	// Fallback: any LAN IP that isn't a bridge or VPN
	for (const name of Object.keys(nets)) {
		if (/^(bridge|utun|lo|veth|docker|br-)/.test(name)) continue;
		for (const net of nets[name] ?? []) {
			if (net.family === "IPv4" && !net.internal && /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(net.address)) {
				return net.address;
			}
		}
	}
	return "localhost";
}

const MIME_TYPES: Record<string, string> = {
	".html": "text/html",
	".js": "application/javascript",
	".mjs": "application/javascript",
	".cjs": "application/javascript",
	".css": "text/css",
	".json": "application/json",
	".wasm": "application/wasm",
};

// ---------------------------------------------------------------------------
// Locate ghostty-web assets from node_modules
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);

function resolveGhosttyPaths(): { distDir: string; wasmPath: string } {
	const main = require.resolve("ghostty-web");
	const pkgRoot = main.replace(/[/\\]dist[/\\].*$/, "");
	return {
		distDir: join(pkgRoot, "dist"),
		wasmPath: join(pkgRoot, "ghostty-vt.wasm"),
	};
}

// ---------------------------------------------------------------------------
// HTML page served at /
// ---------------------------------------------------------------------------

function buildHtml(title: string): string {
	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <title>${title}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <style>
    @font-face {
      font-family: 'JetBrains Mono NF';
      src: url('https://cdn.jsdelivr.net/gh/ryanoasis/nerd-fonts@v3.3.0/patched-fonts/JetBrainsMono/Ligatures/Regular/JetBrainsMonoNerdFont-Regular.ttf') format('truetype');
      font-weight: 400;
      font-style: normal;
      font-display: swap;
    }
    @font-face {
      font-family: 'JetBrains Mono NF';
      src: url('https://cdn.jsdelivr.net/gh/ryanoasis/nerd-fonts@v3.3.0/patched-fonts/JetBrainsMono/Ligatures/Bold/JetBrainsMonoNerdFont-Bold.ttf') format('truetype');
      font-weight: 700;
      font-style: normal;
      font-display: swap;
    }

    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    html { height: 100%; background: #1e1e1e; overflow: hidden; }
    body { height: 100%; background: #1e1e1e; overflow: hidden; display: flex; flex-direction: column; }
    #bar {
      background: #2d2d2d; padding: 8px 14px;
      display: flex; align-items: center; gap: 10px;
      border-bottom: 1px solid #111; flex-shrink: 0;
      font-family: system-ui, sans-serif; font-size: 13px; color: #ccc;
    }
    #bar .dot { width: 8px; height: 8px; border-radius: 50%; background: #888; }
    #bar .dot.ok { background: #27c93f; }
    #bar .dot.err { background: #ff5f56; }
    #bar .dot.wait { background: #ffbd2e; animation: pulse 1s infinite; }
    @keyframes pulse { 50% { opacity: .4; } }
    #bar .spacer { flex: 1; }
    #term { flex: 1; padding: 4px; min-height: 0; overflow: hidden; touch-action: none; }
    #term canvas, #term textarea { touch-action: none; }

    /* Hidden textarea for mobile keyboard input */
    #mobile-input {
      position: absolute;
      left: -9999px;
      top: 0;
      width: 1px;
      height: 1px;
      opacity: 0;
      font-size: 16px; /* prevents iOS zoom on focus */
    }

    /* Mobile modifier/special key toolbar */
    #toolbar {
      display: none;
      background: #2d2d2d;
      border-top: 1px solid #111;
      padding: 6px 4px;
      gap: 4px;
      flex-shrink: 0;
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
    }
    #toolbar .row {
      display: flex;
      gap: 4px;
      justify-content: center;
      flex-wrap: nowrap;
    }
    #toolbar button {
      background: #444;
      color: #ddd;
      border: 1px solid #555;
      border-radius: 5px;
      padding: 10px 12px;
      font-size: 13px;
      font-family: system-ui, sans-serif;
      min-width: 44px;
      min-height: 44px;
      text-align: center;
      touch-action: manipulation;
      -webkit-tap-highlight-color: transparent;
      user-select: none;
      flex-shrink: 0;
    }
    #toolbar button:active {
      background: #666;
    }
    #toolbar button.mod {
      background: #3a3a3a;
      border-color: #666;
    }
    #toolbar button.mod.active {
      background: #0078d4;
      color: #fff;
      border-color: #0078d4;
    }
    #toolbar button.mod.locked {
      background: #005a9e;
      color: #fff;
      border-color: #47a7ff;
      box-shadow: 0 0 4px #47a7ff88;
    }
    /* Tmux control panel */
    #tmux-btn {
      background: none; border: 1px solid #555; color: #aaa;
      border-radius: 4px; padding: 3px 8px; font-size: 11px;
      font-family: system-ui, sans-serif; cursor: pointer;
      letter-spacing: 0.3px;
    }
    #tmux-btn:hover, #tmux-btn.active { background: #2d7d46; color: #fff; border-color: #2d7d46; }
    /* Floating copy/paste bubble — appears after selection */
    #sel-bubble {
      display: none; position: fixed; z-index: 200;
      background: #333; border: 1px solid #555; border-radius: 8px;
      padding: 2px; box-shadow: 0 4px 16px rgba(0,0,0,0.5);
      font-family: system-ui, sans-serif;
    }
    #sel-bubble.show { display: flex; gap: 2px; }
    #sel-bubble button {
      background: none; color: #eee; border: none; border-radius: 6px;
      padding: 8px 14px; font-size: 13px; cursor: pointer;
      min-height: 40px;
    }
    #sel-bubble button:active { background: #555; }
    #copy-toast {
      display: none; position: fixed; bottom: 80px; left: 50%;
      transform: translateX(-50%); background: #333; color: #eee;
      padding: 6px 16px; border-radius: 6px; font-size: 13px;
      font-family: system-ui, sans-serif; z-index: 200;
      pointer-events: none; opacity: 0; transition: opacity 0.2s;
    }
    #copy-toast.show { display: block; opacity: 1; }
    #tmux-panel {
      display: none; position: absolute; top: 100%; right: 0; z-index: 100;
      background: #252528; border: 1px solid #444; border-radius: 8px;
      padding: 10px; min-width: 260px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.5);
      font-family: system-ui, sans-serif; font-size: 13px; color: #ccc;
    }
    #tmux-panel.open { display: block; }
    #tmux-panel .group { margin-bottom: 8px; }
    #tmux-panel .group:last-child { margin-bottom: 0; }
    #tmux-panel .group-label {
      font-size: 10px; text-transform: uppercase; letter-spacing: 1px;
      color: #666; margin-bottom: 4px; padding-left: 2px;
    }
    #tmux-panel .group-btns { display: flex; flex-wrap: wrap; gap: 4px; }
    #tmux-panel button {
      background: #3a3a3a; color: #ddd; border: 1px solid #555;
      border-radius: 5px; padding: 7px 11px; font-size: 12px;
      font-family: system-ui, sans-serif; cursor: pointer;
      min-width: 44px; min-height: 36px; text-align: center;
      touch-action: manipulation; -webkit-tap-highlight-color: transparent;
    }
    #tmux-panel button:hover { background: #555; }
    #tmux-panel button:active { background: #666; }
  </style>
</head>
<body>
  <textarea id="mobile-input" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false"></textarea>
  <div id="bar">
    <div class="dot wait" id="dot"></div>
    <span id="status">Connecting...</span>
    <span class="spacer"></span>
    <span style="color:#666">${title}</span>
    <span style="position:relative">
      <button id="tmux-btn">tmux</button>
      <div id="tmux-panel">
        <div class="group">
          <div class="group-label">Windows</div>
          <div class="group-btns">
            <button data-tmux="c">+ New</button>
            <button data-tmux="p">&#9664; Prev</button>
            <button data-tmux="n">Next &#9654;</button>
            <button data-tmux=",">Rename</button>
          </div>
        </div>
        <div class="group">
          <div class="group-label">Panes</div>
          <div class="group-btns">
            <button data-tmux="&quot;">&#8212; H-Split</button>
            <button data-tmux="%">| V-Split</button>
            <button data-tmux="o">Cycle</button>
            <button data-tmux="z">Zoom</button>
            <button data-tmux="x" class="danger">Kill</button>
          </div>
        </div>
        <div class="group">
          <div class="group-label">Session</div>
          <div class="group-btns">
            <button data-tmux="s">List</button>
            <button data-tmux="[">Scroll</button>
            <button data-tmux="d">Detach</button>
          </div>
        </div>
      </div>
    </span>
  </div>
  <div id="term"></div>
  <div id="sel-bubble">
    <button id="bubble-copy">Copy</button>
    <button id="bubble-paste">Paste</button>
    <button id="bubble-all">All</button>
  </div>
  <div id="copy-toast"></div>
  <div id="toolbar">
    <div class="row">
      <button data-key="Escape">Esc</button>
      <button data-key="Tab">Tab</button>
      <button data-key="ShiftTab">&#8677;Tab</button>
      <button class="mod" data-mod="ctrl">Ctrl</button>
      <button class="mod" data-mod="alt">Alt</button>
      <button class="mod" data-mod="shift">Shift</button>
      <button data-key="ArrowLeft">&#9664;</button>
      <button data-key="ArrowDown">&#9660;</button>
      <button data-key="ArrowUp">&#9650;</button>
      <button data-key="ArrowRight">&#9654;</button>
      <button data-key="PageUp">PgUp</button>
      <button data-key="PageDown">PgDn</button>
      <button data-key="Home">Home</button>
      <button data-key="End">End</button>
      <button data-key="AltEnter">A-Ret</button>
    </div>
  </div>
  <script type="module">
    import { init, Terminal, FitAddon } from '/dist/ghostty-web.js';

    // Wait for Nerd Font to load (or timeout after 3s)
    try {
      await Promise.race([
        document.fonts.ready,
        new Promise(r => setTimeout(r, 3000)),
      ]);
    } catch {}

    await init();

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: '"JetBrains Mono NF", "JetBrains Mono", Menlo, Monaco, "Courier New", monospace',
      theme: { background: '#1e1e1e', foreground: '#d4d4d4' },
      scrollback: 10000,
    });

    window.term = term; // expose for debugging

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(document.getElementById('term'));
    fit.fit();
    fit.observeResize();
    window.addEventListener('resize', () => fit.fit());

    // --- Mouse scroll support for tmux and other mouse-aware programs ---
    // ghostty-web's default wheel handler sends arrow keys on alternate screen,
    // which doesn't work with tmux mouse mode. When the program has enabled
    // mouse tracking (e.g. tmux "set -g mouse on"), we intercept wheel events
    // and send proper SGR mouse escape sequences instead.
    term.attachCustomWheelEventHandler((ev) => {
      if (!term.hasMouseTracking()) return false; // let default handler run

      const canvas = term.element?.querySelector('canvas');
      if (!canvas || !term.renderer) return false;

      const rect = canvas.getBoundingClientRect();
      const cellW = term.renderer.charWidth;
      const cellH = term.renderer.charHeight;

      // 1-based cell coordinates
      const cx = Math.floor((ev.clientX - rect.left) / cellW) + 1;
      const cy = Math.floor((ev.clientY - rect.top) / cellH) + 1;

      // SGR mouse: button 64 = scroll up, 65 = scroll down
      const btn = ev.deltaY < 0 ? 64 : 65;
      const lines = Math.max(1, Math.min(Math.abs(Math.round(ev.deltaY / 40)), 5));

      for (let i = 0; i < lines; i++) {
        // CSI < btn ; x ; y M  (SGR mouse press)
        term.input('\\x1b[<' + btn + ';' + cx + ';' + cy + 'M', true);
      }
      return true; // we handled it
    });

    // Mouse click/drag/release reporting for tmux pane selection, resize, etc.
    function cellCoords(ev) {
      const canvas = term.element?.querySelector('canvas');
      if (!canvas || !term.renderer) return null;
      const rect = canvas.getBoundingClientRect();
      const cellW = term.renderer.charWidth;
      const cellH = term.renderer.charHeight;
      return {
        x: Math.floor((ev.clientX - rect.left) / cellW) + 1,
        y: Math.floor((ev.clientY - rect.top) / cellH) + 1,
      };
    }

    function sgrButton(ev) {
      let btn = ev.button; // 0=left, 1=middle, 2=right
      if (ev.shiftKey) btn |= 4;
      if (ev.altKey) btn |= 8;
      if (ev.ctrlKey) btn |= 16;
      return btn;
    }

    const termEl = document.getElementById('term');

    // Mouse handlers for desktop. On mobile, touchstart calls preventDefault()
    // which blocks synthetic mouse events, but touchActive is checked as a safety net.
    termEl.addEventListener('mousedown', (ev) => {
      if (touchActive) return;
      if (!term.hasMouseTracking()) return;
      const c = cellCoords(ev);
      if (!c) return;
      term.input('\\x1b[<' + sgrButton(ev) + ';' + c.x + ';' + c.y + 'M', true);
    });

    termEl.addEventListener('mousemove', (ev) => {
      if (touchActive) return;
      if (!term.hasMouseTracking()) return;
      if (ev.buttons === 0) return;
      const c = cellCoords(ev);
      if (!c) return;
      const btn = sgrButton(ev) + 32;
      term.input('\\x1b[<' + btn + ';' + c.x + ';' + c.y + 'M', true);
    });

    termEl.addEventListener('mouseup', (ev) => {
      if (touchActive) return;
      if (!term.hasMouseTracking()) return;
      const c = cellCoords(ev);
      if (!c) return;
      term.input('\\x1b[<' + sgrButton(ev) + ';' + c.x + ';' + c.y + 'm', true);
    });

    // --- Touch scroll: convert swipe gestures to scroll ---
    // Mobile has no scroll wheel, so vertical swipes on the terminal area
    // are converted to the appropriate action:
    //   - Mouse tracking on: SGR wheel events (tmux mouse mode)
    //   - Alternate screen (tmux copy mode, vim, etc.): arrow up/down
    //   - Normal screen: scroll terminal scrollback buffer
    //
    // Uses capture phase + touch-action:none CSS to intercept touches
    // before ghostty-web's internal handlers or the browser consume them.
    //
    // CRITICAL: touchstart calls preventDefault() to block the browser from
    // generating synthetic mouse events (mousedown/mousemove/mouseup) from
    // touch input. Without this, ghostty-web's selection handler and our SGR
    // mouse handlers fire simultaneously with scroll events, confusing tmux.
    // Keyboard focus is handled manually in the touchend handler below.
    //
    // wasScrolling is shared with the keyboard touchend handler below
    // so it can skip focusing the input after a scroll gesture.
    // --- Unified touch handler: scroll OR select ---
    // Single handler decides between gestures based on timing:
    //   - Move before 500ms → scroll
    //   - Hold still 500ms → select word, then drag to extend
    //   - Double-tap → select word
    //   - Tap while selection active → dismiss (unless on bubble)
    let wasScrolling = false;
    let touchActive = false;
    let selecting = false;
    {
      // Scroll state
      let scrollStartY = null;
      let scrollStartX = null;
      let accumDelta = 0;
      let isScrolling = false;

      // Selection state
      const sm = term.selectionManager;
      let selStart = null; // {col, absoluteRow} anchor
      let longPressTimer = null;
      let longPressOrigin = null; // {x, y}
      let lastTapTime = 0;

      // Shared
      const bubble = document.getElementById('sel-bubble');
      const toast = document.getElementById('copy-toast');
      const LONG_PRESS_MS = 500;
      const MOVE_THRESHOLD = 10;

      function isTouchInTerm(e) {
        const t = e.target;
        return termEl.contains(t) && !t.closest('#toolbar') && !t.closest('#bar') && !t.closest('#sel-bubble');
      }

      function showToast(msg) {
        toast.textContent = msg;
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 1500);
      }

      function touchToCell(touch) {
        const canvas = termEl.querySelector('canvas');
        if (!canvas || !term.renderer) return null;
        const rect = canvas.getBoundingClientRect();
        const col = Math.floor((touch.clientX - rect.left) / term.renderer.charWidth);
        const row = Math.floor((touch.clientY - rect.top) / term.renderer.charHeight);
        const absRow = sm ? sm.viewportRowToAbsolute(row) : row;
        return { col, row, absoluteRow: absRow };
      }

      function setSelection(c1, r1, c2, r2) {
        if (!sm) return;
        sm.selectionStart = { col: c1, absoluteRow: r1 };
        sm.selectionEnd = { col: c2, absoluteRow: r2 };
        sm.requestRender();
      }

      function showBubble(y) {
        let top = y - 56;
        if (top < 50) top = y + 20;
        bubble.style.left = Math.max(8, (window.innerWidth - 180) / 2) + 'px';
        bubble.style.top = top + 'px';
        bubble.classList.add('show');
      }

      function hideBubble() { bubble.classList.remove('show'); }

      function exitSelection() {
        selecting = false;
        selStart = null;
        term.clearSelection();
        hideBubble();
      }

      function cancelLongPress() {
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
        longPressOrigin = null;
      }

      function startScrolling(touch) {
        cancelLongPress();
        isScrolling = true;
        scrollStartY = touch.clientY;
        scrollStartX = touch.clientX;
        accumDelta = 0;
        if (document.activeElement === mobileInput) mobileInput.blur();
      }

      // enterSelection takes pre-captured coordinates, NOT a Touch object
      // (Touch objects become stale after the event handler returns on mobile)
      function enterSelection(clientX, clientY) {
        cancelLongPress();
        const canvas = termEl.querySelector('canvas');
        if (!canvas || !term.renderer || !sm) return;
        const rect = canvas.getBoundingClientRect();
        const col = Math.floor((clientX - rect.left) / term.renderer.charWidth);
        const row = Math.floor((clientY - rect.top) / term.renderer.charHeight);
        const absRow = sm.viewportRowToAbsolute(row);

        selecting = true;
        isScrolling = false;
        // Select word at touch point
        const word = sm.getWordAtCell(col, row);
        if (word) {
          selStart = { col: word.startCol, absoluteRow: absRow };
          setSelection(word.startCol, absRow, word.endCol, absRow);
        } else {
          selStart = { col: col, absoluteRow: absRow };
          setSelection(col, absRow, col, absRow);
        }
        showBubble(clientY);
        if (navigator.vibrate) navigator.vibrate(30);
      }

      // --- Bubble buttons ---
      document.getElementById('bubble-copy').addEventListener('click', async (e) => {
        e.stopPropagation();
        const text = term.getSelection();
        if (!text) { showToast('Nothing selected'); return; }
        try { await navigator.clipboard.writeText(text); showToast('Copied'); }
        catch {
          const ta = document.createElement('textarea');
          ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
          document.body.appendChild(ta); ta.select();
          document.execCommand('copy'); document.body.removeChild(ta);
          showToast('Copied');
        }
        exitSelection();
      });
      document.getElementById('bubble-paste').addEventListener('click', async (e) => {
        e.stopPropagation();
        try { const text = await navigator.clipboard.readText(); if (text) term.input(text, true); }
        catch { showToast('Clipboard denied'); }
        exitSelection();
      });
      document.getElementById('bubble-all').addEventListener('click', (e) => {
        e.stopPropagation();
        term.selectAll();
        selecting = true;
        showBubble(80);
      });

      // --- TOUCHSTART ---
      termEl.addEventListener('touchstart', (e) => {
        if (!isTouchInTerm(e)) return;
        if (e.touches.length !== 1) return;
        e.preventDefault(); // block synthetic mouse events
        touchActive = true;

        const touch = e.touches[0];
        const now = Date.now();

        // Double-tap: select word immediately
        if (now - lastTapTime < 350 && !selecting) {
          lastTapTime = 0;
          enterSelection(touch.clientX, touch.clientY);
          return;
        }
        lastTapTime = now;

        // Tap dismisses active selection
        if (selecting) { exitSelection(); return; }

        // Record start position for both scroll and long-press
        scrollStartY = touch.clientY;
        scrollStartX = touch.clientX;
        accumDelta = 0;
        isScrolling = false;

        // Start long-press timer — capture coordinates NOW (Touch objects go stale)
        const lx = touch.clientX, ly = touch.clientY;
        longPressOrigin = { x: lx, y: ly };
        longPressTimer = setTimeout(() => {
          longPressTimer = null;
          enterSelection(lx, ly);
        }, LONG_PRESS_MS);
      }, { passive: false, capture: true });

      // --- TOUCHMOVE ---
      termEl.addEventListener('touchmove', (e) => {
        if (e.touches.length !== 1) return;
        const touch = e.touches[0];

        // If selecting: extend selection by dragging
        if (selecting && selStart) {
          e.preventDefault();
          e.stopPropagation();
          const cell = touchToCell(touch);
          if (cell) {
            setSelection(selStart.col, selStart.absoluteRow, cell.col, cell.absoluteRow);
            showBubble(Math.min(touch.clientY, longPressOrigin?.y ?? touch.clientY));
          }
          return;
        }

        // Cancel long-press if finger moved too much
        if (longPressOrigin) {
          const dx = Math.abs(touch.clientX - longPressOrigin.x);
          const dy = Math.abs(touch.clientY - longPressOrigin.y);
          if (dx > MOVE_THRESHOLD || dy > MOVE_THRESHOLD) {
            cancelLongPress();
            // Finger moved → switch to scroll mode
            if (!isScrolling) startScrolling(touch);
          }
        }

        // Scroll logic
        if (!isScrolling || scrollStartY === null) return;
        if (!isTouchInTerm(e)) return;

        e.preventDefault();
        e.stopPropagation();

        const dy = scrollStartY - touch.clientY;
        const cellH = term.renderer ? term.renderer.charHeight : 18;
        accumDelta += dy;
        scrollStartY = touch.clientY;
        scrollStartX = touch.clientX;

        const lines = Math.trunc(accumDelta / cellH);
        if (lines === 0) return;
        accumDelta -= lines * cellH;

        const absLines = Math.abs(lines);
        const scrollingUp = lines > 0;
        const mouseTracking = term.hasMouseTracking();
        const altScreen = term.wasmTerm?.isAlternateScreen() ?? false;

        if (mouseTracking) {
          const canvas = term.element?.querySelector('canvas');
          if (canvas && term.renderer) {
            const rect = canvas.getBoundingClientRect();
            const cx = Math.floor((touch.clientX - rect.left) / term.renderer.charWidth) + 1;
            const cy = Math.floor((touch.clientY - rect.top) / term.renderer.charHeight) + 1;
            const btn = scrollingUp ? 64 : 65;
            for (let i = 0; i < absLines; i++)
              term.input('\\x1b[<' + btn + ';' + cx + ';' + cy + 'M', true);
          }
        } else if (altScreen) {
          const key = scrollingUp ? '\\x1b[A' : '\\x1b[B';
          for (let i = 0; i < absLines; i++) term.input(key, true);
        } else {
          term.scrollLines(scrollingUp ? -absLines : absLines);
        }
      }, { passive: false, capture: true });

      // --- TOUCHEND ---
      termEl.addEventListener('touchend', () => {
        cancelLongPress();
        wasScrolling = isScrolling;
        scrollStartY = null;
        scrollStartX = null;
        accumDelta = 0;
        isScrolling = false;
        // selStart stays set so next touchmove can extend if selecting
        setTimeout(() => { wasScrolling = false; touchActive = false; }, 0);
      }, { passive: true, capture: true });
    }

    // --- Touch keyboard + toolbar support ---
    const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    const mobileInput = document.getElementById('mobile-input');
    const toolbar = document.getElementById('toolbar');

    // sendInput is set once WebSocket connects
    let sendInput = (data) => {};

    if (hasTouch) {
      toolbar.style.display = 'flex';

      // --- Viewport resize: shrink body when virtual keyboard opens ---
      if (window.visualViewport) {
        const vv = window.visualViewport;
        function handleViewportResize() {
          // Set body height to the visible viewport (excludes keyboard)
          document.body.style.height = vv.height + 'px';
          // Scroll to top so the terminal stays in view
          window.scrollTo(0, 0);
          // Refit terminal to new container size
          fit.fit();
        }
        vv.addEventListener('resize', handleViewportResize);
        vv.addEventListener('scroll', () => window.scrollTo(0, 0));
      }

      // --- Sticky modifier state ---
      // Single tap = active for next keypress, double tap = locked on
      const mods = { ctrl: false, alt: false, shift: false };
      const locked = { ctrl: false, alt: false, shift: false };

      function clearMod(name) {
        if (locked[name]) return;
        mods[name] = false;
        toolbar.querySelector('[data-mod="' + name + '"]').classList.remove('active');
      }

      function clearAllMods() {
        for (const m of ['ctrl', 'alt', 'shift']) clearMod(m);
      }

      // Modifier button handling: tap = toggle, double-tap = lock
      const modTimers = {};
      toolbar.querySelectorAll('.mod').forEach((btn) => {
        const name = btn.dataset.mod;

        function handleModTap(e) {
          e.preventDefault();
          e.stopPropagation();
          if (locked[name]) {
            locked[name] = false;
            mods[name] = false;
            btn.classList.remove('active', 'locked');
            return;
          }
          if (mods[name] && modTimers[name]) {
            clearTimeout(modTimers[name]);
            modTimers[name] = null;
            locked[name] = true;
            btn.classList.add('locked');
            return;
          }
          mods[name] = !mods[name];
          btn.classList.toggle('active', mods[name]);
          if (mods[name]) {
            modTimers[name] = setTimeout(() => { modTimers[name] = null; }, 400);
          }
          mobileInput.focus({ preventScroll: true });
        }

        btn.addEventListener('touchend', handleModTap);
        btn.addEventListener('click', handleModTap);
      });

      // --- Special key escape sequences ---
      const specialKeys = {
        Escape:     '\\x1b',
        Tab:        '\\t',
        ShiftTab:   '\\x1b[Z',
        ArrowLeft:  '\\x1b[D',
        ArrowDown:  '\\x1b[B',
        ArrowUp:    '\\x1b[A',
        ArrowRight: '\\x1b[C',
        PageUp:     '\\x1b[5~',
        PageDown:   '\\x1b[6~',
        Home:       '\\x1b[H',
        End:        '\\x1b[F',
        AltEnter:   '\\x1b\\r',
      };

      // --- Apply modifiers to keyboard/toolbar input ---
      // For single chars: Ctrl+a = 0x01, Alt+x = ESC x, Shift+x = X
      // For CSI sequences (\\x1b[X): rewrite to \\x1b[1;modX (xterm-style)
      //   mod = 1 + (shift?1:0) + (alt?2:0) + (ctrl?4:0)
      function applyMods(key) {
        const hasAnyMod = mods.ctrl || mods.alt || mods.shift;
        if (!hasAnyMod) { clearAllMods(); return key; }

        let seq = key;

        // CSI sequences: \\x1b[A, \\x1b[5~, etc -> \\x1b[1;modA, \\x1b[5;mod~
        const csiMatch = seq.match(/^\\x1b\\[([0-9]*)([A-Z~])$/i);
        if (csiMatch) {
          const param = csiMatch[1] || '1';
          const suffix = csiMatch[2];
          const mod = 1 + (mods.shift ? 1 : 0) + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0);
          seq = '\\x1b[' + param + ';' + mod + suffix;
          clearAllMods();
          return seq;
        }

        // Single character
        if (mods.ctrl && seq.length === 1) {
          const code = seq.toLowerCase().charCodeAt(0);
          if (code >= 97 && code <= 122) {
            seq = String.fromCharCode(code - 96);
          }
        }
        if (mods.alt) {
          seq = '\\x1b' + seq;
        }
        if (mods.shift && seq.length === 1) {
          seq = seq.toUpperCase();
        }
        clearAllMods();
        return seq;
      }

      // Special key buttons — apply modifiers for combos like Ctrl+Arrow
      toolbar.querySelectorAll('button[data-key]').forEach((btn) => {
        function handleKeyTap(e) {
          e.preventDefault();
          e.stopPropagation();
          const seq = specialKeys[btn.dataset.key];
          if (seq) {
            sendInput(applyMods(seq));
          }
          mobileInput.focus({ preventScroll: true });
        }
        btn.addEventListener('touchend', handleKeyTap);
        btn.addEventListener('click', handleKeyTap);
      });

      // (tmux panel handlers are set up outside the hasTouch block)

      // Tap on terminal area focuses the hidden textarea to trigger keyboard
      // Skip if user was scrolling (wasScrolling set by capture-phase touchend above)
      termEl.addEventListener('touchend', (e) => {
        if (e.target.closest('#toolbar')) return;
        if (wasScrolling) return;
        e.preventDefault();
        mobileInput.focus({ preventScroll: true });
      });

      // Forward typed characters with modifier support
      mobileInput.addEventListener('input', (e) => {
        const data = e.target.value;
        if (data) {
          sendInput(applyMods(data));
          e.target.value = '';
        }
      });

      // Handle special keys from the virtual keyboard
      mobileInput.addEventListener('keydown', (e) => {
        const baseMap = {
          Enter:      '\\r',
          Backspace:  '\\x7f',
          Tab:        '\\t',
          Escape:     '\\x1b',
          ArrowUp:    '\\x1b[A',
          ArrowDown:  '\\x1b[B',
          ArrowRight: '\\x1b[C',
          ArrowLeft:  '\\x1b[D',
        };
        const seq = baseMap[e.key];
        if (seq) {
          e.preventDefault();
          sendInput(applyMods(seq));
          mobileInput.value = '';
        }
      });
    }

    // (selection is handled by the unified touch handler above)

    // --- Tmux control panel (works on both desktop and mobile) ---
    {
      const tmuxBtn = document.getElementById('tmux-btn');
      const tmuxPanel = document.getElementById('tmux-panel');

      tmuxBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = tmuxPanel.classList.toggle('open');
        tmuxBtn.classList.toggle('active', isOpen);
      });

      // Close panel when clicking outside
      document.addEventListener('click', (e) => {
        if (!tmuxPanel.contains(e.target) && e.target !== tmuxBtn) {
          tmuxPanel.classList.remove('open');
          tmuxBtn.classList.remove('active');
        }
      });

      // Tmux command buttons: send prefix (Ctrl+b = \\x02) + key
      tmuxPanel.querySelectorAll('button[data-tmux]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const key = btn.dataset.tmux;
          // sendInput may not be wired yet if WS hasn't connected,
          // so use term.input -> onData -> ws.send pipeline
          term.input('\\x02' + key, true);
          // Close panel after action
          tmuxPanel.classList.remove('open');
          tmuxBtn.classList.remove('active');
        });
      });
    }

    // --- Connection with session persistence ---
    const dot = document.getElementById('dot');
    const statusEl = document.getElementById('status');
    function setStatus(cls, text) {
      dot.className = 'dot ' + cls;
      statusEl.textContent = text;
    }

    let sessionId = null;
    let activeWs = null;
    let reconnectTimer = null;
    let connecting = false;

    function scheduleReconnect(delay) {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    }

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    function connect() {
      // Prevent concurrent connection attempts
      if (connecting) return;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

      // Close any stale WebSocket
      if (activeWs) {
        try { activeWs.onclose = null; activeWs.close(); } catch {}
        activeWs = null;
      }

      connecting = true;
      setStatus('wait', sessionId ? 'Reconnecting...' : 'Connecting...');

      let wsUrl = proto + '//' + location.host + '/ws?cols=' + term.cols + '&rows=' + term.rows;
      if (sessionId) wsUrl += '&sid=' + sessionId;

      const ws = new WebSocket(wsUrl);
      let gotSession = false;
      let intentionalClose = false;

      ws.onopen = () => {
        connecting = false;
        activeWs = ws;
        sendInput = (data) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(data);
        };
      };

      ws.onmessage = (e) => {
        // First message is always a JSON session handshake
        if (!gotSession && typeof e.data === 'string' && e.data.startsWith('{')) {
          try {
            const msg = JSON.parse(e.data);
            if (msg.type === 'session') {
              gotSession = true;
              if (msg.expired || !msg.sid) {
                // Session expired — start fresh
                sessionId = null;
                intentionalClose = true;
                ws.close();
                term.reset();
                scheduleReconnect(500);
                return;
              }
              if (msg.sid !== sessionId) {
                sessionId = msg.sid;
              } else {
                term.reset();
              }
              setStatus('ok', 'Connected');
              return;
            }
          } catch {}
        }
        term.write(e.data);
      };

      ws.onclose = () => {
        connecting = false;
        if (activeWs === ws) activeWs = null;
        sendInput = () => {};
        // Only auto-reconnect if the close was not intentional
        if (!intentionalClose) {
          setStatus('err', 'Disconnected');
          scheduleReconnect(2000);
        }
      };

      ws.onerror = () => {
        connecting = false;
        setStatus('err', 'Error');
      };
    }

    term.onData((data) => {
      if (activeWs && activeWs.readyState === WebSocket.OPEN) activeWs.send(data);
    });
    term.onResize(({ cols, rows }) => {
      if (activeWs && activeWs.readyState === WebSocket.OPEN)
        activeWs.send(JSON.stringify({ type: 'resize', cols, rows }));
    });

    // Reconnect when tab becomes visible again
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !activeWs && !connecting) {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = null;
        connect();
      }
    });

    connect();
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Server implementation
// ---------------------------------------------------------------------------

// PTY sessions persist across WebSocket reconnects. Each session has a
// scrollback ring buffer so the client can restore terminal state after
// the browser tab is backgrounded and the WebSocket is killed.

const REPLAY_BUFFER_SIZE = 100 * 1024; // 100KB of recent output
const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 min before orphan PTY is killed

interface PtySession {
	id: string;
	pty: IPty;
	ws: WebSocket | null;
	replayBuf: string[];
	replayStart: number;
	replayBytes: number;
	exitCode: number | null;
	killTimer: ReturnType<typeof setTimeout> | null;
}

function getShell(): string {
	if (process.platform === "win32") return process.env.COMSPEC || "cmd.exe";
	return process.env.SHELL || "/bin/bash";
}

let sessionIdCounter = 0;

export default function (pi: ExtensionAPI) {
	let httpServer: ReturnType<typeof createServer> | null = null;
	let wss: WebSocketServer | null = null;
	let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	const sessions = new Map<string, PtySession>();
	let activePort: number | null = null;
	let ghosttyPaths: { distDir: string; wasmPath: string } | null = null;

	// -----------------------------------------------------------------------
	// Serve files — cached in memory after first read
	// -----------------------------------------------------------------------

	let cachedHtml: Buffer | null = null;
	const fileCache = new Map<string, { data: Buffer; contentType: string }>();

	function handleHttp(req: IncomingMessage, res: ServerResponse) {
		const pathname = (req.url ?? "/").split("?")[0];

		if (pathname === "/" || pathname === "/index.html") {
			if (!cachedHtml) {
				const title = `pi — ${pi.getSessionName() ?? "web terminal"}`;
				cachedHtml = Buffer.from(buildHtml(title));
			}
			res.writeHead(200, { "Content-Type": "text/html", "Content-Length": cachedHtml.length });
			res.end(cachedHtml);
			return;
		}

		if (!ghosttyPaths) {
			res.writeHead(500);
			res.end("ghostty-web assets not found");
			return;
		}

		let filePath: string | null = null;
		if (pathname.startsWith("/dist/")) {
			filePath = join(ghosttyPaths.distDir, pathname.slice(6));
		} else if (pathname === "/ghostty-vt.wasm") {
			filePath = ghosttyPaths.wasmPath;
		}

		if (filePath) {
			const cached = fileCache.get(filePath);
			if (cached) {
				res.writeHead(200, {
					"Content-Type": cached.contentType,
					"Content-Length": cached.data.length,
					"Cache-Control": "public, max-age=86400",
				});
				res.end(cached.data);
				return;
			}
			// Read once, cache forever (assets don't change at runtime)
			readFile(filePath).then((data) => {
				const ext = extname(filePath!);
				const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
				fileCache.set(filePath!, { data, contentType });
				res.writeHead(200, {
					"Content-Type": contentType,
					"Content-Length": data.length,
					"Cache-Control": "public, max-age=86400",
				});
				res.end(data);
			}).catch(() => {
				res.writeHead(404);
				res.end("Not Found");
			});
			return;
		}

		res.writeHead(404);
		res.end("Not Found");
	}

	// -----------------------------------------------------------------------
	// PTY + WebSocket bridge
	// -----------------------------------------------------------------------

	// Replay buffer uses a circular index to avoid Array.shift() (O(n) per call).
	// When over budget, we advance replayStart and periodically compact.
	function appendReplay(session: PtySession, data: string) {
		session.replayBuf.push(data);
		session.replayBytes += data.length;
		// Trim from front by advancing start index
		while (session.replayBytes > REPLAY_BUFFER_SIZE && session.replayStart < session.replayBuf.length - 1) {
			session.replayBytes -= session.replayBuf[session.replayStart]!.length;
			session.replayBuf[session.replayStart] = null as any; // allow GC
			session.replayStart++;
		}
		// Compact when more than half the array is dead entries
		if (session.replayStart > session.replayBuf.length / 2 && session.replayStart > 100) {
			session.replayBuf = session.replayBuf.slice(session.replayStart);
			session.replayStart = 0;
		}
	}

	function getReplayChunks(session: PtySession): string[] {
		return session.replayBuf.slice(session.replayStart);
	}

	function createPtySession(cols: number, rows: number, cwd: string): PtySession {
		const id = String(++sessionIdCounter);

		// Clean env: strip tmux/screen vars so the PTY shell is a fresh session,
		// not one that thinks it's nested inside tmux/screen.
		const env = { ...process.env };
		delete env.TMUX;
		delete env.TMUX_PANE;
		delete env.STY; // screen
		delete env.TERM_PROGRAM;
		delete env.TERM_PROGRAM_VERSION;
		env.TERM = "xterm-256color";
		env.COLORTERM = "truecolor";

		const ptyProcess = spawn(getShell(), [], {
			name: "xterm-256color",
			cols,
			rows,
			cwd,
			env,
		});

		const session: PtySession = {
			id,
			pty: ptyProcess,
			ws: null,
			replayBuf: [],
			replayStart: 0,
			replayBytes: 0,
			exitCode: null,
			killTimer: null,
		};

		sessions.set(id, session);

		// PTY output → replay buffer + active WebSocket
		ptyProcess.onData((data: string) => {
			appendReplay(session, data);
			if (session.ws && session.ws.readyState === session.ws.OPEN) {
				session.ws.send(data);
			}
		});

		ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
			session.exitCode = exitCode;
			if (session.ws && session.ws.readyState === session.ws.OPEN) {
				session.ws.send(`\r\n\x1b[33mShell exited (code: ${exitCode})\x1b[0m\r\n`);
				session.ws.close();
			}
			// Clean up after exit
			if (session.killTimer) clearTimeout(session.killTimer);
			sessions.delete(id);
		});

		return session;
	}

	function attachWs(session: PtySession, ws: WebSocket) {
		// Detach previous WebSocket if any
		if (session.ws) {
			try { session.ws.close(); } catch {}
		}
		// Cancel kill timer
		if (session.killTimer) {
			clearTimeout(session.killTimer);
			session.killTimer = null;
		}

		session.ws = ws;
		(ws as any).isAlive = true;
		ws.on("pong", () => { (ws as any).isAlive = true; });

		ws.on("message", (raw: Buffer) => {
			const msg = raw.toString("utf8");
			if (msg.startsWith("{")) {
				try {
					const parsed = JSON.parse(msg);
					if (parsed.type === "resize") {
						session.pty.resize(parsed.cols, parsed.rows);
						return;
					}
				} catch {
					// not JSON — fall through to pty write
				}
			}
			session.pty.write(msg);
		});

		ws.on("close", () => {
			if (session.ws === ws) {
				session.ws = null;
				// Start kill timer — if no reconnect within timeout, kill PTY
				session.killTimer = setTimeout(() => {
					session.pty.kill();
					sessions.delete(session.id);
				}, SESSION_TIMEOUT_MS);
			}
		});

		ws.on("error", () => {
			// ignore socket errors
		});
	}

	function handleWsConnection(ws: WebSocket, req: IncomingMessage, cwd: string) {
		const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
		const cols = parseInt(url.searchParams.get("cols") || "80", 10);
		const rows = parseInt(url.searchParams.get("rows") || "24", 10);
		const reconnectId = url.searchParams.get("sid");

		// Try to reconnect to existing session
		if (reconnectId && sessions.has(reconnectId)) {
			const session = sessions.get(reconnectId)!;
			if (session.exitCode !== null) {
				// PTY already exited — tell client to start fresh
				ws.send(JSON.stringify({ type: "session", sid: "", expired: true }));
				ws.close();
				return;
			}
			// Reattach
			attachWs(session, ws);
			// Send session ID + replay buffer to restore terminal state
			ws.send(JSON.stringify({ type: "session", sid: session.id }));
			// Replay buffered output — client clears screen first
			for (const chunk of getReplayChunks(session)) {
				ws.send(chunk);
			}
			// Resize PTY to match new client dimensions
			session.pty.resize(cols, rows);
			return;
		}

		// New session
		const session = createPtySession(cols, rows, cwd);
		attachWs(session, ws);
		ws.send(JSON.stringify({ type: "session", sid: session.id }));
	}

	// -----------------------------------------------------------------------
	// Start / Stop helpers
	// -----------------------------------------------------------------------

	function startServer(port: number, cwd: string): Promise<number> {
		return new Promise((resolve, reject) => {
			try {
				ghosttyPaths = resolveGhosttyPaths();
			} catch (e) {
				reject(new Error("Could not locate ghostty-web package. Run npm install in the extension directory."));
				return;
			}

			httpServer = createServer((req, res) => {
				try {
					handleHttp(req, res);
				} catch (err) {
					res.writeHead(500);
					res.end(String(err));
				}
			});

			wss = new WebSocketServer({ noServer: true });

			httpServer.on("upgrade", (req, socket, head) => {
				const pathname = (req.url ?? "").split("?")[0];
				if (pathname === "/ws") {
					wss!.handleUpgrade(req, socket, head, (ws) => {
						handleWsConnection(ws, req, cwd);
					});
				} else {
					socket.destroy();
				}
			});

			// Heartbeat: ping every 20s, terminate unresponsive clients
			heartbeatTimer = setInterval(() => {
				if (!wss) return;
				for (const ws of wss.clients) {
					if (!(ws as any).isAlive) {
						ws.terminate();
						continue;
					}
					(ws as any).isAlive = false;
					ws.ping();
				}
			}, HEARTBEAT_INTERVAL_MS);

			// Port auto-increment on EADDRINUSE
			const tryListen = (p: number) => {
				httpServer!.removeAllListeners("error");
				httpServer!.on("error", (err: NodeJS.ErrnoException) => {
					if (err.code === "EADDRINUSE" && p < port + PORT_RETRY_MAX) {
						tryListen(p + 1);
					} else {
						reject(err.code === "EADDRINUSE"
							? new Error(`Ports ${port}-${p} are all in use`)
							: err);
					}
				});
				httpServer!.listen(p, "0.0.0.0", () => {
					activePort = p;
					resolve(p);
				});
			};

			tryListen(port);
		});
	}

	function stopServer() {
		cachedHtml = null;
		fileCache.clear();
		if (heartbeatTimer) {
			clearInterval(heartbeatTimer);
			heartbeatTimer = null;
		}
		for (const session of sessions.values()) {
			if (session.killTimer) clearTimeout(session.killTimer);
			session.pty.kill();
			if (session.ws) try { session.ws.close(); } catch {}
		}
		sessions.clear();

		if (wss) {
			wss.close();
			wss = null;
		}
		if (httpServer) {
			httpServer.close();
			httpServer = null;
		}
		activePort = null;
	}

	// -----------------------------------------------------------------------
	// /web command
	// -----------------------------------------------------------------------

	pi.registerCommand("web", {
		description: "Start/stop a web terminal (ghostty-web). Usage: /web [port|stop]",
		handler: async (args, ctx) => {
			const arg = args?.trim() ?? "";

			if (arg === "stop") {
				if (!activePort) {
					ctx.ui.notify("Web terminal is not running", "warning");
					return;
				}
				stopServer();
				ctx.ui.setStatus("web-access", undefined);
				ctx.ui.notify("Web terminal stopped", "info");
				return;
			}

			if (activePort) {
				ctx.ui.notify(`Web terminal already running on http://localhost:${activePort}`, "warning");
				return;
			}

			const port = arg ? parseInt(arg, 10) : DEFAULT_PORT;
			if (isNaN(port) || port < 1 || port > 65535) {
				ctx.ui.notify(`Invalid port: ${arg}`, "error");
				return;
			}

			try {
				const boundPort = await startServer(port, ctx.cwd);
				const lanIp = getLanIp();
				const localUrl = `http://localhost:${boundPort}`;
				const lanUrl = lanIp !== "localhost" ? `http://${lanIp}:${boundPort}` : null;
				ctx.ui.setStatus(
					"web-access",
					ctx.ui.theme.fg("accent", `web: ${lanUrl ?? localUrl}`),
				);
				ctx.ui.notify(
					lanUrl ? `Web terminal: ${localUrl} (LAN: ${lanUrl})` : `Web terminal: ${localUrl}`,
					"info",
				);
			} catch (err) {
				ctx.ui.notify(`Failed to start: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});

	// -----------------------------------------------------------------------
	// Cleanup on session shutdown
	// -----------------------------------------------------------------------

	pi.on("session_shutdown", async () => {
		stopServer();
	});
}
