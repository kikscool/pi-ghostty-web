# pi-ghostty-web

A [pi](https://github.com/badlogic/pi-mono) extension that provides web-based terminal access using [ghostty-web](https://github.com/coder/ghostty-web) — Ghostty's battle-tested VT100 parser compiled to WASM.

Open a browser tab (or your phone) and get a full terminal session in pi's working directory.

## Installation

```bash
pi install npm:pi-ghostty-web
```

Or from git:

```bash
pi install git:github.com/nicepkg/pi-ghostty-web
```

## Usage

Inside a pi session:

```
/web            Start the web terminal (default port 7681)
/web 8080       Start on a specific port
/web stop       Stop the server
```

The status bar shows the LAN URL so you can connect from your phone.

## Features

### Terminal
- Full terminal emulator in the browser via ghostty-web (WASM)
- Nerd Font support (JetBrains Mono NF) for zsh themes like Powerlevel10k
- Each browser tab gets its own shell session in pi's CWD
- Clean environment — tmux/screen vars are stripped so you can start tmux inside

### Session Persistence
- PTY sessions survive WebSocket disconnects (mobile tab backgrounding, network drops)
- 100KB replay buffer restores terminal state on reconnect
- Automatic reconnect with session reattachment — no "connection lost" interruptions
- 5-minute grace period before orphaned PTYs are killed

### Mobile
- Touch scrolling with three modes:
  - **Mouse tracking on** (tmux `set -g mouse on`): SGR wheel events
  - **Alternate screen** (tmux copy mode, vim, less): arrow keys
  - **Normal shell**: scrollback buffer scroll
- On-screen keyboard toolbar with:
  - Special keys: Esc, Tab, Shift+Tab, arrows (◀▼▲▶), PgUp/PgDn, Home/End, Alt+Enter
  - Sticky modifiers: Ctrl, Alt, Shift (tap to activate, double-tap to lock)
  - Modifier + key combos with xterm-style encoding (e.g. Ctrl+◀ = word-left)
- Text selection:
  - Long-press (500ms) to select word, drag to extend character-by-character
  - Double-tap to select word
  - Floating Copy/Paste/All bubble
- Virtual keyboard hides when scrolling, shows on tap
- Viewport resizes when keyboard opens (no content hidden behind keyboard)

### tmux Integration
- **tmux** button in the top bar opens a control panel with:
  - Windows: New, Prev, Next, Rename
  - Panes: H-Split, V-Split, Cycle, Zoom, Kill
  - Session: List, Scroll (copy mode), Detach

### Server
- Binds to `0.0.0.0` — accessible from other devices on the LAN
- LAN IP shown in status bar and startup notification
- Port auto-increment if the requested port is in use
- WebSocket heartbeat (ping/pong every 20s) cleans up stale connections
- Static assets cached in memory (ghostty-web JS/WASM served from RAM)
- `Cache-Control` headers for browser-side caching

## How It Works

```
┌──────────────┐     ┌───────────────────────────┐     ┌──────────────┐
│  Pi TUI      │     │  Pi Process               │     │  Browser     │
│  (terminal)  │     │                           │     │  (phone/     │
│              │     │  pi-ghostty-web extension  │     │   laptop)    │
└──────────────┘     │    ↳ HTTP + WS server     │◄───►│              │
                     │    ↳ PTY sessions          │     │  ghostty-web │
                     └───────────────────────────┘     │  terminal    │
                                                       └──────────────┘
```

The extension starts an HTTP + WebSocket server inside the Pi process. The browser loads ghostty-web (WASM terminal emulator) and connects via WebSocket. Each connection is bridged to a real PTY running your shell.

## Requirements

- Node.js 18+
- A platform supported by [@lydell/node-pty](https://github.com/nicolo-ribaudo/node-pty) (Linux, macOS, Windows)

## License

MIT
