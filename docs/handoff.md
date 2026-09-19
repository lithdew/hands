# Handoff: hand desktops + PIP (branch `desktop-pip`)

Written 2026-09-19 for whoever picks this up on Omarchy.

## What exists

| File | Purpose | Status |
| --- | --- | --- |
| `desktop.ts` | One nested sway desktop per hand: start/stop, screenshot, click, type, key, scroll, launch apps, launch browser with the user's logins | Verified live under WSLg. Not yet run on Omarchy. |
| `pip.ts` | Pins hand windows as corner tiles in Hyprland, swaps one to fullscreen and back | Unit tested only. Needs a real Hyprland to verify. |
| `desktop.test.ts`, `pip.test.ts` | 22 tests, all mocking the shell | `bun test` passes |
| `docs/omarchy-setup.md` | Packages, try-it commands, Hyprland keybinds | |
| `docs/superpowers/specs/2026-09-19-hand-desktops-and-pip-design.md` | Why this design and not Docker or a ghost monitor | |
| `.env.example` | Keys we expect in `.env.local` | `.env.local` still empty |

## The design in one paragraph

A hand is a `sway` compositor started with `WLR_BACKENDS=wayland` from inside
Hyprland. It appears as a normal window. It has its own seat, so input we
inject with `wlrctl` and `wtype` (with `WAYLAND_DISPLAY` set to the nested
socket) never touches the user's mouse or keyboard. Apps launched inside run as
the user with the user's home, so real apps and logins work. Screenshots come
from `grim`. `pip.ts` finds the window by the sway pid and drives it with
`hyprctl dispatch`. The window is the PIP feed; there is no VNC or streaming.

## First 10 minutes on Omarchy

```sh
sudo pacman -S --needed sway grim wtype
sudo pacman -S --needed wlrctl || yay -S wlrctl
git clone https://github.com/lithdew/puk && cd puk && git checkout desktop-pip
bun install && bun test

bun desktop.ts up 2 --terminal     # two hand windows should appear
bun pip.ts ls                      # each hand should map to a window address
bun pip.ts layout                  # tiles pinned bottom-right
bun desktop.ts click 1 640 400
bun desktop.ts type 1 "echo hi from hand 1"
bun desktop.ts key 1 Return
bun desktop.ts shot 1 /tmp/h1.png  # open it; the text should be there
bun pip.ts swap 1                  # fullscreen; click inside to take over
bun pip.ts back
bun desktop.ts down
```

Then the browser path: `bun desktop.ts up 1 --url=https://mail.google.com`.
The first launch copies `~/.config/chromium` to `~/.hands/chromium-1`, so you
should be logged in.

## What to watch for on first Omarchy run

1. **`pip.ts ls` shows "no window yet".** Hyprland reports a different pid
   than the sway process (unlikely, but possible). Compare `hyprctl clients -j`
   with `bun desktop.ts ls` and adjust `findHandWindow` in `pip.ts`.
2. **`pin` or `setfloating` rejects the address argument.** Check
   `hyprctl dispatch pin` syntax for your Hyprland version and edit
   `pipCommands` in `pip.ts`. The unit test for it is easy to update.
3. **Hand windows get tiled into your layout on start.** Add the
   `windowrulev2 = float` rule from `docs/omarchy-setup.md`.
4. **Nested sway fails to start.** Look at `$XDG_RUNTIME_DIR/hands/hand-1.log`.
   If it is a renderer error, try `WLR_RENDERER=pixman bun desktop.ts up 1`.
5. **First keystrokes garbled.** We saw this once and added a 40 ms settle
   delay before typing. If it recurs, raise `KEYMAP_SETTLE_MS` in `desktop.ts`.
6. **Chromium refuses to start a second instance.** The per-hand profile dir
   should prevent this. If it happens, delete `~/.hands/chromium-<id>/Singleton*`.

## Design decisions already made (do not re-open without a reason)

- Omarchy is the demo machine. Mac is a later port via a Docker desktop
  provider that exposes the same `Hand` API.
- Hands need real apps and logins, so no Docker sandbox on Omarchy.
- Risky actions pause and wait for approval.
- **Jev (TypeSafe) is text only.** It cannot see screenshots. Its job is the
  risk gate (`noul` over the planned action) and optionally picking between
  candidate actions (`choice`). A vision model does perception.
- One feature per file.

## What is next, in order

1. Verify `pip.ts` on real Hyprland (list above).
2. `hotkey.ts`: tiny Bun HTTP server; Hyprland `bind` posts `/hotkey/down`,
   `bindr` posts `/hotkey/up`. Config lines are in `docs/omarchy-setup.md`.
3. `transcribe.ts`: OpenAI realtime WebSocket, `type: "transcription"`,
   model `gpt-live-transcribe`, `turn_detection: null`, append 24 kHz PCM
   while held, `input_audio_buffer.commit` on release.
4. `gate.ts`: `POST https://api.typesafe.ai/v1/systemone` with a `noul`
   question over the next action's description. Block if probability is high.
5. The action loop: screenshot via `desktop.ts`, ask the vision model for the
   next action, run it through `gate.ts`, execute via `desktop.ts`.
6. Progress summaries and the on-screen "hands" cursors.

## Useful internals

- Registry: `$XDG_RUNTIME_DIR/hands/hand-<id>.json` holds `{id, pid, display,
  width, height}`. Any module can call `listHands()` from `desktop.ts`.
- Every shell call goes through an injectable `exec` so tests never need
  sway or Hyprland installed.
- Absolute mouse moves are done as a huge negative relative move (clamped to
  the corner) followed by the target offset. It is exact because a hand has
  exactly one output.
