# Omarchy setup for hands

Hands run as nested `sway` desktops inside your Hyprland session. Each one is a
normal window that `pip.ts` pins in the corner. Input injected by `desktop.ts`
goes only into that window's own seat, so you keep your mouse and keyboard.

## Packages

```sh
sudo pacman -S --needed sway grim wtype
sudo pacman -S --needed wlrctl || yay -S wlrctl
```

Chromium is Omarchy's default browser and needs nothing extra. Firefox works
too.

## Try it

```sh
bun desktop.ts up 2 --url=https://example.com   # two hands, a browser in each
bun pip.ts layout                                # pin them bottom-right
bun desktop.ts shot 1 /tmp/hand1.png             # what hand 1 sees
bun desktop.ts click 1 640 400
bun desktop.ts key 1 ctrl+l
bun desktop.ts type 1 wikipedia.org
bun desktop.ts key 1 Return
bun pip.ts swap 1                                # fullscreen hand 1; click in it to take over
bun pip.ts back
bun desktop.ts down
```

`bun desktop.ts up 2 --terminal` opens a terminal instead of a browser, which
is handy for testing input.

## Hyprland config (optional)

`pip.ts` does the floating and pinning by window address, so no rules are
required. If you want hand windows to *start* floating and never get tiled
into your layout, add a rule keyed on the nested compositor's app id. Check it
with `hyprctl clients -j` after `bun desktop.ts up 1`; it is usually `wlroots`
or `sway`:

```ini
windowrulev2 = float, class:^(wlroots|sway)$
windowrulev2 = noinitialfocus, class:^(wlroots|sway)$
```

Keybinds for the parts that come next (hotkey hold and release map to
`bind` and `bindr`):

```ini
bind  = SUPER, H, exec, curl -s -X POST localhost:7777/hotkey/down
bindr = SUPER, H, exec, curl -s -X POST localhost:7777/hotkey/up
bind  = SUPER, P, exec, bun /path/to/puk/pip.ts layout
bind  = SUPER, 1, exec, bun /path/to/puk/pip.ts swap 1
bind  = SUPER, 0, exec, bun /path/to/puk/pip.ts back
```

## Browser logins

`launchBrowser` copies `~/.config/chromium` (or your Firefox default profile)
into `~/.hands/<browser>-<id>` the first time a hand starts, so cookies and
logins carry over. Delete that folder to start fresh. Sync between the copy
and your real profile is one-way and only happens on first copy.

## How the pieces fit

- `desktop.ts` writes a tiny sway config, starts `sway` with
  `WLR_BACKENDS=wayland`, and waits for the nested compositor to report its
  socket name (`hand-<id>.display` under `$XDG_RUNTIME_DIR/hands`).
- Screenshots: `grim` with `WAYLAND_DISPLAY` set to the hand's socket.
- Mouse: `wlrctl pointer` (relative moves; we jump to the corner first so
  positions are absolute). Keyboard: `wtype`.
- `pip.ts` finds the Hyprland window whose `pid` equals the sway pid and
  drives it with `hyprctl dispatch`.

## Known limits

- `wlrctl` moves are relative, so if a nested app warps the cursor the next
  move still starts from the corner and stays correct.
- Two hands running the same Electron app share nothing but can collide on
  single-instance locks. Browsers are handled; other apps may need their own
  profile flags.
- Exiting the terminal that ran `bun desktop.ts up` may hang up the hands.
  Launch from a Hyprland keybind or `nohup` for anything long-lived.
