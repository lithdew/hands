# Hand desktops and picture-in-picture (Omarchy first)

Date: 2026-09-19. Project: **hands** (team puk, General Learning Hackathon).

## Problem

A "hand" is an AI computer-use worker. The user holds a hotkey, speaks a task,
and 2 to 3 hands go off and do it. The user keeps working on their own desktop
and watches the hands through small always-on-top tiles (PIP). They can swap
into a hand's desktop to watch closely or take over, and swap back.

Constraints from the user:

- Hands need **real apps and real logins**, not just a browser. Browser use plus
  computer use.
- 2 to 3 hands run **concurrently** on one laptop.
- Demo machine is **Omarchy** (Arch + Hyprland, Wayland). Mac is a later port.
- Risky actions **pause and wait** for approval (gate lives in a separate file,
  out of scope here).
- One feature per file. Bun + TypeScript.

## Why not the obvious options

- **Agent on the user's real screen.** One seat, one cursor. The user loses the
  laptop while a hand works, and two hands cannot coexist.
- **Hyprland ghost monitor + wayvnc.** Gives a hidden output, but wayvnc's
  virtual pointer still lives in Hyprland's single seat. Agent and user fight
  over the same cursor. No concurrency.
- **Docker desktop per hand.** Clean isolation and cross-platform, but the hand
  has none of the user's apps or logins. Kept as the Mac fallback.

## Chosen design: one nested Wayland compositor per hand

Each hand is a `sway` instance started with the Wayland backend from inside the
user's Hyprland session. It shows up as a normal window. Properties:

- **Own seat.** Input injected through `wlr-virtual-pointer` and
  `virtual-keyboard` (via `wlrctl` and `wtype`) with `WAYLAND_DISPLAY` set to
  the nested socket lands only inside that hand. The user's mouse is untouched.
- **Real apps, real user.** Apps launched with the nested `WAYLAND_DISPLAY` run
  as the user with the user's home directory. Browser profiles are copied per
  hand so several Chromium instances can run at once with the user's cookies.
- **The window is the PIP.** Hyprland floats, pins, sizes and stacks the hand
  windows in a corner. No VNC, no browser page, no stream.
- **Swap in = fullscreen the window.** Clicking into it hands the user's
  keyboard and mouse to the nested desktop, so the user can take over.
- **Screenshots** come from `grim` against the nested socket.

## Components

### `desktop.ts` (hand desktop lifecycle, screenshot, input)

Exports:

```
startHand(id, {width, height}) -> Hand      spawn nested sway, wait for its socket
stopHand(hand)                              kill sway, remove registry entry
listHands() -> Hand[]                       read registry
screenshot(hand, {scale}) -> Uint8Array     PNG via grim
moveMouse(hand, x, y)                       wlrctl: jump to origin, then move x y
click(hand, x, y, button)                   moveMouse + wlrctl pointer click
scroll(hand, x, y, dy)                      moveMouse + wlrctl pointer scroll
typeText(hand, text)                        wtype
pressKey(hand, "ctrl+shift+t")              wtype with modifiers
launch(hand, argv, env?)                    spawn an app inside the hand
launchBrowser(hand, url, {copyProfile})     Chromium/Firefox with per-hand profile
```

`Hand = { id, pid, display, width, height }`. Registry lives at
`$XDG_RUNTIME_DIR/hands/hand-<id>.json` so `pip.ts` and future modules can find
hands without sharing process state.

Startup detail: the generated sway config runs
`exec sh -c 'echo $WAYLAND_DISPLAY > .../hand-<id>.display'`. `startHand` polls
for that file. This is how we learn the nested socket name.

Absolute pointer positioning: `wlrctl pointer move` is relative. We move by a
huge negative delta (clamped to 0,0 by wlroots) then by (x, y). Deterministic
because the nested compositor has exactly one output.

All shell calls go through an injectable `exec` so tests can assert the exact
argv without sway installed.

### `pip.ts` (Hyprland window layout for hand windows)

Exports:

```
findHandWindow(hand) -> HyprClient | null   hyprctl clients -j, match by pid
layoutPip(hands, {w, h, margin})            float + pin + size + stack bottom-right
swapTo(hand)                                focus + fullscreen
swapBack()                                  un-fullscreen
tileRects(n, monitor, opts) -> Rect[]       pure layout math (unit tested)
```

CLI: `bun pip.ts layout | swap <id> | back`.

### Out of scope for this spec

`hotkey.*`, `transcribe.ts`, `gate.ts` (Jev), the vision/action loop, the
progress summariser, and the Mac fallback (`desktop.ts` provider that talks to
a Docker container over VNC). The `Hand` shape and the `exec` seam are designed
so the Mac provider can slot in later.

## Error handling

- `startHand` times out after 10 s if the socket file never appears and kills
  the sway process.
- Missing binaries (`sway`, `grim`, `wlrctl`, `wtype`) raise a clear error
  naming the package to install.
- `pip.ts` tolerates a hand whose window is not yet mapped (skips it).

## Testing

- `bun test` unit tests with a fake `exec`: sway config content, grim args,
  the move-to-origin sequence, key-combo parsing, tile geometry.
- Live test on Omarchy (or WSLg here): `bun desktop.ts up 2`, take a
  screenshot, click, type into a terminal, then `bun pip.ts layout`.

## Omarchy packages

`sudo pacman -S sway grim wtype` and `wlrctl` (AUR if not in extra).
