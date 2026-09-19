# Omarchy setup

Hands are nested Sway desktops inside Hyprland. Each has a separate input seat. The native window is the preview, so there is no VNC stream or remote desktop server.

## Prerequisites

Bun, Sway, grim, wtype, wlrctl, foot (or alacritty), curl, util-linux (`setpriv` and `flock`), and PipeWire (`pw-record` for speech). On Omarchy, use its package commands:

```sh
omarchy pkg add sway
omarchy pkg add grim
omarchy pkg add wtype
omarchy pkg aur add wlrctl
```

Install [Cua Driver for Linux](https://cua.ai/docs/how-to-guides/driver/install) and ensure `cua-driver` is on Puk's PATH. The app was tested with **0.28.2**. No shared driver daemon is needed: Puk launches a private MCP process per worker, strips the host display target and sets `CUA_DRIVER_RS_ENABLE_WAYLAND=1` for the nested Sway session. Driver telemetry is disabled in that subprocess.

```sh
cua-driver --version
```

The implementation was verified on Hyprland 0.56.2 (Lua configuration), Sway 1.12, and Bun 1.4.2. Older Hyprland INI dispatcher syntax is not supported by this branch.

## Start and use

```sh
bun install
bun desktop.ts up 2 --terminal
bun start
```

Open `http://127.0.0.1:7777`. Use **Open desktop** or click a corner preview to enter. **‹ Desktop** in the nested bar returns to your previous app. The bar also launches apps; the tabs switch between open apps. The initial desktop is hand 1 unless `PUK_HAND` is set. Independent spoken requests start workers on other available hands; the panel lets you select which one to watch. Hold F8 to stream speech to Jev and start work; release finishes the instruction.

Hold **Super** (Windows key) over a corner preview: **left-drag moves** it and **right-drag resizes** it, using Omarchy's native [mouse bindings](https://wiki.hypr.land/configuring/core/binds/devices/mouse/). Entering and returning keeps each preview's size and position. **Reset previews** in the panel, Ctrl+Alt+P, or `bun pip.ts layout` restores the default arrangement.

Previews appear while their agents work or await review. Idle, stopped and failed hands move to a hidden workspace without closing their apps. **Open desktop** and the hand shortcuts still open them, and manually opened desktops stay visible until you return. The panel serves the last captured frame while a hand is hidden. Run one Puk server to manage all hands; it reconciles their visibility together.

`up` reuses existing hands, preserves adjusted previews and open desktops, and places new hands in free slots. `--empty` starts without an app, `--no-pip` skips arrangement, and omitting `--terminal` starts a browser. Hands and launched apps survive the CLI exiting. `bun desktop.ts down` closes all registered hands, so save work first.

## Shortcuts

Check `omarchy menu keybindings --print` for conflicts. Back up `~/.config/hypr/bindings.lua`, then add the output of:

```sh
bun pip.ts bindings
```

It generates current Omarchy Lua bindings with absolute paths: Ctrl+Alt+1/2/3 to enter/return, Ctrl+Alt+0 to return, Ctrl+Alt+P to arrange, F8 press/release for speech, and Ctrl+Alt+Escape to stop. It also generates a conditional left-click handler that consumes clicks on pinned previews while passing other clicks through.

If a key is already assigned, explicitly unbind its old assignment before replacing it. Finish with:

```sh
hyprctl reload
hyprctl configerrors
```

No global window rules are required. `pip.ts` floats, pins, tags, positions, rounds and borders only windows matched to registered compositor PIDs. `bun pip.ts state <id> idle|working|review|error` applies visibility and the state border, and the running server checks all hands once a second. Idle previews are unpinned and parked on `special:puk-idle`; working previews return to the active workspace with `follow=false`, preserving host focus and tile geometry. UI, bar, shortcut and state transitions use the same `flock` lock. A bounded screenshot capture caches the last frame before parking because hidden Sway outputs stop producing frames.

The nested bar and tab strip use the active Omarchy theme's `colors.toml` (read from `~/.local/state/omarchy/current/theme.name`), falling back to Tokyo Night. The bar polls `http://127.0.0.1:$PUK_PORT/status` once a second to show the agent's state from inside the hand; restart hands after changing themes.

## App and browser behavior

The agent scans XDG desktop entries, respects hidden user overrides, and passes parsed arguments directly to executables. It chooses appropriate installed apps from their descriptions, categories and keywords. Already open matching apps are focused inside the hand. Omarchy webapp launchers use the hand's browser profile; foot clients are launched as separate foot windows.

Hands use tabs by default and disable focus-follows-mouse. Hovering over a preview should not redirect the agent's keyboard input to another inner window. Bash identifies the nested session as Sway and receives its IPC socket; the host Hyprland target is removed.

Browsers use per-hand profiles under `~/.hands`. On first launch, `launchBrowser` copies the user's existing Chromium/Chrome/Brave profile or Firefox default profile when found, excluding active singleton locks afterward. Profile copying is one-time; subsequent changes are not synchronized. Programmatic callers can use `{ copyProfile: false }` for a clean profile. Login portability depends on the browser and its credential storage.

## Troubleshooting and limits

- `PUK_DEBUG=1 bun start` enables redacted provider, Jev, Cua and capture diagnostics.
- Logs and registry live in `$XDG_RUNTIME_DIR/hands`. `bun desktop.ts ls` and `bun pip.ts ls` show the mapping.
- Arch Sway carries `CAP_SYS_NICE`; `setpriv --no-new-privs` prevents inherited realtime limits from killing the nested compositor at startup.
- The native CLI/standalone wtype helper restores Sway's persistent keyboard afterward. This avoids a Sway 1.12 / Chromium keymap race observed when opening Chromium after virtual-keyboard input.
- The nested output's physical size follows the outer window, but the bar process rescales it to preserve `Hand.width` (1280 by default). A 480×300 tile therefore represents a 1280×800 desktop at 0.375 scale. A different fullscreen aspect ratio can still change the logical height. Cua capture/input alignment must be checked at a non-1 scale: a physical-size capture would be 480×300 while logical clicks expect 1280×800.
- While a hand is a small tile its window buffer is only 480×300 pixels, so screenshots taken then are soft. Enlarge the tile or enter the hand when the agent needs to read small text.
- Cua's native Wayland support is experimental. Screenshot dimensions come from the PNG and nested Sway state; the driver's generic `get_screen_size` still expects X11 in this version. Unsupported operations report an error.
- Other apps can have D-Bus activation or single-instance behavior that needs app-specific flags. X11-only apps are not supported with the current `xwayland disable` config.
- On release, `pw-record` can handle SIGINT and exit with code 1. An expected stop is accepted and final transcription is preserved; only an unsolicited capture exit is a microphone failure. Provider/auth errors retain their cause.
- PipeWire captures the default microphone; set `PUK_MICROPHONE` to a target accepted by `pw-record` if necessary. Capture starts only on a press and has a 60-second hold limit.
- macOS Spaces and Windows virtual desktops provide navigation within a session; an independent agent desktop there still needs a backend/viewer. This branch implements Linux/Hyprland only.
