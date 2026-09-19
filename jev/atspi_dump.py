#!/usr/bin/python3
"""atspi_dump.py: print the accessible UI of one hand as JSON. Helper for observe.ts.

usage: atspi_dump.py <wayland-display>      e.g. atspi_dump.py wayland-1

Every app on the session shares one accessibility bus, so the user's own
windows are on it too. A hand's apps are the ones whose process was started
with WAYLAND_DISPLAY set to the hand's socket; everything else is skipped.

Coordinates are relative to each app's window (Wayland clients do not know
where they are on screen). observe.ts adds the window's position.

Requires: python-gobject at-spi2-core   (pacman -S python-gobject at-spi2-core)
"""

import json
import sys

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi  # noqa: E402

MAX_NODES = 6000  # per app; a long web page can expose far more
MAX_DEPTH = 60
MAX_ELEMENTS = 400
MAX_TEXTS = 80
TEXT_CHARS = 160

INTERACTIVE = {
    "push button", "toggle button", "check box", "radio button", "link",
    "menu item", "check menu item", "radio menu item", "menu",
    "entry", "password text", "combo box", "spin button", "slider", "switch",
    "page tab", "list item", "tree item", "table cell", "icon",
}
READABLE = {"heading", "label", "static", "paragraph", "caption", "status bar", "alert", "notification"}
WINDOWS = {"frame", "window", "dialog", "alert", "file chooser"}
CLICK_ACTIONS = {"click", "press", "activate", "jump", "open"}


def hand_display_of(pid):
    try:
        with open(f"/proc/{pid}/environ", "rb") as f:
            for entry in f.read().split(b"\0"):
                if entry.startswith(b"WAYLAND_DISPLAY="):
                    return entry[len(b"WAYLAND_DISPLAY="):].decode()
    except OSError:
        pass
    return None


def text_of(acc, limit):
    try:
        iface = acc.get_text_iface()
        if iface is None:
            return ""
        count = Atspi.Text.get_character_count(iface)
        return Atspi.Text.get_text(iface, 0, min(count, limit)) or ""
    except Exception:
        return ""


def clickable(acc):
    try:
        iface = acc.get_action_iface()
        if iface is None:
            return False
        for i in range(Atspi.Action.get_n_actions(iface)):
            if (Atspi.Action.get_action_name(iface, i) or "").lower() in CLICK_ACTIONS:
                return True
    except Exception:
        pass
    return False


def walk(acc, app, pid, frame, within, depth, out, budget):
    if depth > MAX_DEPTH or budget[0] <= 0:
        return
    budget[0] -= 1
    try:
        role = acc.get_role_name() or ""
        name = (acc.get_name() or "").strip()
        states = acc.get_state_set()
        if depth > 0 and not states.contains(Atspi.StateType.VISIBLE):
            return  # hidden tab, closed menu: nothing under it is on screen
        showing = states.contains(Atspi.StateType.SHOWING)
        editable = states.contains(Atspi.StateType.EDITABLE)
    except Exception:
        return

    if role in WINDOWS and depth <= 1:
        frame = name
        out["frames"].append({"name": name, "pid": pid, "active": states.contains(Atspi.StateType.ACTIVE)})

    if showing and (role in INTERACTIVE or editable or (name and role not in READABLE and clickable(acc))):
        try:
            ext = acc.get_component_iface().get_extents(Atspi.CoordType.WINDOW)
            if ext.width > 0 and ext.height > 0 and len(out["elements"]) < MAX_ELEMENTS:
                secret = role == "password text"
                out["elements"].append({
                    "role": role,
                    "name": name,
                    "description": (acc.get_description() or "").strip(),
                    "value": "" if secret or not editable else text_of(acc, TEXT_CHARS).strip(),
                    "editable": editable,
                    "focused": states.contains(Atspi.StateType.FOCUSED),
                    "checked": states.contains(Atspi.StateType.CHECKED),
                    "enabled": states.contains(Atspi.StateType.SENSITIVE) or states.contains(Atspi.StateType.ENABLED),
                    "app": app, "pid": pid, "frame": frame, "within": within,
                    "x": ext.x, "y": ext.y, "w": ext.width, "h": ext.height,
                })
        except Exception:
            pass
    elif showing and role in READABLE and len(out["texts"]) < MAX_TEXTS:
        text = (name or text_of(acc, TEXT_CHARS)).strip()
        if text:
            out["texts"].append(text[:TEXT_CHARS])

    if name and role not in WINDOWS and role not in INTERACTIVE and role not in READABLE:
        within = name  # nearest named container: "Compose", "Navigation", a toolbar
    try:
        count = acc.get_child_count()
    except Exception:
        return
    for i in range(count):
        try:
            child = acc.get_child_at_index(i)
        except Exception:
            continue
        if child is not None:
            walk(child, app, pid, frame, within, depth + 1, out, budget)


def main():
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    display = sys.argv[1]
    Atspi.init()
    Atspi.set_timeout(800, 3000)  # ms per call; an unresponsive app must not hang a hand
    out = {"elements": [], "texts": [], "frames": []}
    desktop = Atspi.get_desktop(0)
    for i in range(desktop.get_child_count()):
        try:
            app = desktop.get_child_at_index(i)
            if app is None:
                continue
            pid = app.get_process_id()
            if hand_display_of(pid) != display:
                continue
            walk(app, (app.get_name() or "").strip(), pid, "", "", 0, out, [MAX_NODES])
        except Exception:
            continue
    json.dump(out, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
