# hands2

A TypeScript/Bun port of [typesafe-computer-use](https://github.com/awlevin/typesafe-computer-use), plus an agent built on top of it.

- **`clicker`** is the port: it drives a Mac toward a goal you type in plain English. It reads the screen deterministically (Vision OCR plus the accessibility tree), asks a [TypeSafe](https://docs.typesafe.ai) classifier which action comes next, and only calls a writing model when a field genuinely needs free text.
- **`hands`** is a [pi](https://github.com/earendil-works/pi) agent (`pi-agent-core`) that has pi's coding tools (`read`, `bash`, `edit`, `write`) and computer use side by side: the clicker's own perception and actions as individual tools, and the whole clicker loop as one more tool for the sub-goals a classifier can carry.

```
bun hands "Open up the calculator and check for me what 1337*1337 with it"
bun hands --background "Open up the calculator and check for me what 1337*1337 with it"   # while you keep working
bun clicker "open the Playground" --act
```

## Install

macOS 14 or newer on Apple Silicon or Intel, [Bun](https://bun.com) 1.4 or newer.

```
bun install
echo 'TYPESAFE_API_KEY=...' > .env     # Bun loads .env on its own
pi                                     # then /login, once: signs in the model provider
```

The language model goes through [pi-ai](https://github.com/earendil-works/pi/tree/main/packages/ai) and reuses pi's credential store (`~/.pi/agent/auth.json`), so an OpenAI Codex (ChatGPT) subscription signed in with `pi` works here with no key of its own.

| variable | default | purpose |
|---|---|---|
| `TYPESAFE_API_KEY` | required | every clicker decision |
| `HANDS_MODEL` | `openai-codex/gpt-6-astra` | the agent's model, as `provider/model` |
| `HANDS_THINKING` | `low` | reasoning effort, for the agent and the writer |
| `HANDS_SERVICE_TIER` | `priority` | sent as `service_tier`; `off` sends none |
| `CLICKER_WRITER_MODEL`, `CLICKER_ANSWER_MODEL` | `HANDS_MODEL` | the clicker's per-step writer, and the reader of its last screen |
| `CLICKER_BROWSER` | `Google Chrome` | any Chromium browser with Chrome's scripting dictionary |
| `CLICKER_EMAIL` | none | enables the clicker's `type_email` action |

Grant your terminal **Screen Recording** and **Accessibility** in System Settings > Privacy & Security, and let it control your browser the first time macOS asks. Without the first, captures are wallpaper. Without the second, synthetic clicks are silently dropped, and both commands refuse to drive the machine.

## Use

```
bun hands "prompt"                                   # one task
bun hands --background "prompt"                      # any app or site, without taking your mouse, keyboard or focus
bun hands                                            # a prompt per line, same conversation
bun clicker "open the Playground"                    # dry run: one step, prints what it would do
bun clicker "open the Playground" --act              # drives the machine, up to 100 steps
bun clicker "log in" --act --steps 20 --delay 3      # longer and slower
bun clicker-inspect "any goal"                       # 3-2-1, capture, open the annotated screen + payload
```

**Stopping a live run.** Ctrl-C, or slam the mouse into the top-left corner of whichever screen it is on. The clicker also stops itself on `done` or `none`, on confidence under `--min-confidence` (0.4), after two consecutive no-ops, or at `--steps`.

**Sharing the seat.** By default the agent uses your mouse, keyboard and focus. If you bring another app forward mid-task, its input tools refuse to act until it has looked at the screen again, so a keystroke meant for a web page does not land in your terminal. It is best left alone while it works, or run in the background.

## Background mode

`--background` is for working alongside it, in any app. Nothing it does goes through the seat; everything names its target:

| it | through | you notice |
|---|---|---|
| starts an app | `open -g` (Launch Services, without activation) | nothing |
| reads a window | `screencapture -l <window id>` (the window server composites a covered window whole) and that window's own accessibility subtree | nothing |
| clicks | `AXPress` on the control | nothing |
| fills a field | `AXValue`, confirmed with `AXConfirm` or the form's button | nothing |
| chooses a menu command | `AXPress` on the menu item where it is, by path (`File > New Note`): the menu never opens | nothing |
| types and presses keys in an app | `CGEventPostToPid`: keys go to that process, not to whatever has the focus | nothing |
| scrolls | a scroll area's own page action, or `AXScrollToVisible` on a control from the off-screen list | nothing |
| clicks a bare point, draws, drags | pointer events addressed to one window (below), never the HID stream, so your cursor does not move | nothing, except that a browser window is slid until a strip of it shows at a screen edge |
| browses | a window of its own in your browser and profile, behind yours; links and buttons by `AXPress`, tabs over the tab strip, back/forward/reload by scripting | nothing |
| opens a URL in that window, in its tab or a new one | `location.href` run inside the page, in a bare new tab when one is wanted | nothing, **once you allow it**: View > Developer > Allow JavaScript from Apple Events. Without that, the browser takes the keyboard for about 0.2 s and it is handed back |
| makes that window, once per run | the browser's scripting | at most a 0.2 s flicker, handed back |

Those last two rows are Chrome's doing, and the only part of this mode that can touch your seat. Chrome stamps a navigation that arrives by Apple Event as a user gesture (`OpenURLParams(..., is_renderer_initiated=false)`), answers a user gesture with `window_action = kShowWindow`, and `Show()` on a visible window is `[NSApp activateIgnoringOtherApps:YES]` plus `makeKeyAndOrderFront:`. `make new window` calls `Show()` inside its initializer, before any `with properties {visible:false}` is applied, so no property prevents it. Measured here: 174 ms away for making the window, 213 ms for a URL, nothing for a link pressed over accessibility. A key you type inside that fifth of a second can land in the agent's window. So the agent is told to move through a site by pressing its links, and to keep URLs for getting there.

What removes it, both yours to opt into:

- **View > Developer > Allow JavaScript from Apple Events** in Chrome. `hands` notices by itself: it then navigates with `location.href = ...` run inside the page, and opens a new tab as a bare `make new tab` (which raises nothing) navigated the same way. A page that navigates itself carries no gesture. Measured with it on: a same-tab open and two new-tab opens, the agent's window raised 0 times and the keyboard away for 0 ms. Only making the window can still flicker, once per run.
- An unpacked extension calling `chrome.windows.create({focused: false})`, `chrome.tabs.create` and `chrome.tabs.update`, bridged over native messaging. Chromium's source orders such a window *below* your current one and never makes it key, which makes this the only known way to create a window with no raise at all. Not built here.

There is no way to push another app's window back afterwards without privileges: accessibility has `AXRaise` and no inverse, and window managers that reorder foreign windows (yabai) do it from a scripting addition injected into Dock with SIP partly off.

Measured with the user working in another app throughout, by sampling the frontmost app at 10 Hz: the calculator prompt took 13 s and Calculator was frontmost in 0 of 45 samples; a new Apple Note written from a toolbar press, typed keys and a set value, 0 of 162. In the browser, by sampling Chrome's window stack: a 35 s booking lookup in the browser had the agent's window in front of the user's for 1 of 357; the whole arXiv prompt (search, four papers kept as tabs, a PDF built with the shell, a new Apple Note with the PDF attached) took about three minutes, with Notes frontmost in 0 of 655 samples and the agent's browser window in front for 8 of 1806.

### A pointer that is not yours

Drawing needs a pointer, and the only public one is yours. So this uses the window server's private half (SkyLight), the way cua-driver, Peekaboo, Warp and Notch-Agent do, looked up at run time and never linked: without the symbols the pointer tools simply report themselves unavailable.

- Every mouse event is built as usual, then told which window it is for: `CGEventSetWindowLocation` with the point inside the window, and event fields 40 (target pid), 51, 91 and 92 (the window's id) and 58 (one stamp per gesture). It is posted to the process, `CGEventPostToPid` for AppKit and `SLEventPostToPid` for Chromium and Electron, once: both roads at once arrive twice. It never enters the HID stream, so nothing moves your cursor and nothing reaches the app you are in.
- An AppKit window takes these even when it is completely covered: Calculator's keys click from under a terminal.
- A Chromium page needs two more things, both measured here with a page that reports the events it receives. It must hold the focus, which three records sent with `SLPSPostEventRecordTo` give it (focus, then key window begin and end) **to the target process only**. The better-known recipe also sends a defocus record to the app in front, which is what makes the user's window flicker; this never does, and it hands the app's previous key window back afterwards. And Chrome must consider the page visible: a window covered on every side, by anything, reports `visibilityState: hidden` and is delivered nothing. A strip is enough, so the first pointer action slides the agent's window until a corner of it lies over a spot no window covers, the rest staying behind yours or off the screen. With every screen covered edge to edge there is no such spot, and it says so rather than pretend.

With that, the paint prompt runs in the background too: in one run, about 100 seconds of strokes, tool picks and flood fills changed the frontmost app zero times; the only two changes in the whole run were the two `browser` opens.

What is still not offered in this mode: the clipboard (it is yours) and the `clicker`. Limits worth knowing: an app that is not in front dims the menu commands that need a cursor or a selection, and `menu` refuses those rather than press them to no effect. A menu's keyboard shortcut often does not fire there either, which is why commands go through `menu`. Keys reach a process, not a window, so the browser gets none (they would land in whichever of its windows you are in). And an Electron app can echo a value set through accessibility without applying it, so a field that "took" a value there deserves a second look.

## The agent's tools

| tool | does |
|---|---|
| `read` `bash` `edit` `write` | pi's coding tools, rooted at `--cwd` (default `workspace/`) |
| `screen` | capture the display the frontmost window is on; list every OCR block and accessibility control with an index and its x,y; optionally attach the screenshot |
| `click` | an item by index (pressed through accessibility when the app declared it, so it lands under a cookie banner) or a point; right and double clicks |
| `type` `key` `scroll` `drag` | keystrokes (long text is pasted), chords like `cmd+shift+t`, scrolling under a point, and press-drag-release strokes for canvases and sliders |
| `press_offscreen` | `AXPress` a control the app exposes but does not show |
| `open_app` | open or bring forward a macOS app |
| `browser` | open URLs, list and switch tabs, new windows, back/forward/reload, in **your own running browser and profile** |
| `wait` | for a page or an animation |
| `clicker` | the whole TypeSafe loop on one concrete sub-goal |

Coordinates are pixels of the latest screenshot, which is drawn at one pixel per screen point, so the model never sees a display origin or a Retina scale. Old `screen` results are cut from the transcript in batches, so a long task neither outgrows the context window nor re-uploads every screenshot each turn.

## How a clicker step works

```
accessibility ─► frontmost app and pid          Quartz ─► its window ─► which display
screencapture ─► Vision OCR ─► merge lines into blocks ─► drop lines echoing the goal
accessibility ─► actionable elements (role, label, frame), pruned to the display,
                 the labelled pressable ones it pruned kept as off-screen controls
                     │
                     └─► one numbered list of items, each carrying its source
accessibility ─► focused field          ScriptingBridge ─► active tab URL
clock, dates.ts ─► "dated 2026-10-13 (in 27 days)" on any block containing a date
                     │
                     ▼
        one TypeSafe request, three Choices, four with off-screen controls
        kind | item | site | offscreen
                     │
                     ▼
        deterministic action ─► wait ─► next step
```

The design, the action space, the OCR crop-and-reuse cache, the accessibility pruning rules and the run folder are the original's; its [README](https://github.com/awlevin/typesafe-computer-use#readme) explains each. Every run writes `runs/<timestamp>/` (`run.log`, `run.json`, and per step the raw capture, the annotated capture, the exact payload, and every probability), and a saved capture replays offline:

```
bun clicker "same goal" --image runs/<ts>/step-003-raw.png --app "Google Chrome" --url "https://example.com/"
```

## What the port changed

Everything else is a faithful port, tests included. These are deliberate:

- **Native access is `bun:ffi`**, where the original used pyobjc and ocrmac: CoreGraphics events, the AX C API, Vision through the Objective-C runtime, ScriptingBridge. No compiler and no helper binary. Imaging (the change detector's thumbnails, annotated captures, downscaled screenshots) is `sharp`.
- **The writer is any pi-ai model**, not Anthropic: by default the same `gpt-6-astra` the agent uses. Structured replies are requested in the prompt and validated in code.
- **Any display.** The original captures display 1 at origin 0,0. This captures the display the frontmost window is on and carries its origin, so a window on a second monitor (including one placed above or left of the main one, at negative coordinates) is read and clicked correctly. The abort corner is the top-left of whichever screen the mouse is on.
- **Your browser, by pid.** With a second Chrome running (say, a headless one some automation started with its own `--user-data-dir`), `tell application "Google Chrome"` is ambiguous, and AppleScript and JXA disagree about which instance answers. The browser is therefore found by command line (the instance started *without* a profile of its own) and only ever addressed by pid, over ScriptingBridge. URLs open in your existing profile or not at all.
- **The accessibility walk covers the focused window and the menu bar**, as OCR already did, where the original walks every window of the app. A window stacked behind the front one is on the display by its frame while nothing of it shows, so its controls were being offered, and a press would land where the user cannot see.
- **A dropped connection does not end an agent run.** A transient provider error takes the failed turn back off the transcript and continues, with backoff, as pi itself does.
- **Accessibility attributes are fetched in one round trip per element** (`AXUIElementCopyMultipleAttributeValues`), so the 0.6 s walk budget covers several times as many nodes.
- Three fixes to behaviour the original shares: nested unlabelled layout boxes with one frame are no longer taken for duplicates of each other (which hid Calculator's whole keypad); an empty goal no longer filters out every OCR line as an "echo"; and the frontmost app is named as the workspace knows it (`Google Chrome`), not as its accessibility element titles itself (`Chrome`).

## Layout

```
src/
  macos.ts        the only module that touches Quartz, AX, Vision, ScriptingBridge, AppleScript
  perception.ts   capture, OCR, the read region and the changed-tile cache, block merging,
                  goal-echo filter, the accessibility item source, and the merge of the two
  dates.ts        date parsing and "in N days" hints
  decide.ts       state, criteria, the multi-Choice request, the Noul check
  writer.ts       the writer model, structured replies, URL validation, the final answer
  actions.ts      one handler per action, each returning a history line
  runner.ts       the step loop, run folder, stop rules, the hand-off for the answer
  report.ts       logging, annotated screenshots, payload dump
  timing.ts       phase stopwatches, the timing line, run summary
  cli.ts          `clicker` and `clicker inspect`
  llm.ts          pi-ai model runtime, model resolution, the service tier
  tools.ts        computer use as agent tools
  agent.ts        `hands`: the pi agent, its system prompt, transcript pruning
tests/            pure logic: dates, merging, reading order, echo filter, the OCR cache,
                  decisions, actions, the tree walk against a fake tree
```

## Development

```
bun test
bun run typecheck
```

## Known limits

- Everything on screen goes to the model and into `runs/<timestamp>/agent.log`, including whatever note, mail or key happens to be showing. `runs/` is gitignored; treat it as private.
- OCR only sees text, and the accessibility tree only covers apps that publish one. Electron apps and canvases mostly reach neither, which is what `screen`'s screenshot is for.
- Two identical labels get only a coarse region hint and split the classifier's vote.
- Chords go by US-layout keycodes; typed text does not.
- Passwords are never typed. Rely on the browser's password manager or an SSO button.

## License

MIT, as is the original.
