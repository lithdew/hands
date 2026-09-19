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
bun hands --listen                                   # Windows: hold F8, say the task, release; it works in the background
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

## Windows

The same two commands run on Windows 11, from Windows itself or from WSL. Nothing is installed: `src/windows.cs` is built on first use with the C# compiler that ships in Windows, and `src/platform.ts` hands every other module `windows.ts` in place of `macos.ts`, export for export. **Written against the Mac's tests and a fake helper; not yet run on a live desktop.** The checks that remain are listed under it.

| it | through | you notice |
|---|---|---|
| starts an app | started minimized, not waited for, then shown without activation under every other window | at most a flicker in the taskbar |
| reads a window | `PrintWindow` (a covered window paints itself whole) and that window's UI Automation tree, its child windows read as roots of their own | nothing |
| clicks | an Invoke, Select, Toggle or Expand pattern on the control | nothing |
| fills a field | `EM_REPLACESEL` to a classic edit control, `ValuePattern` elsewhere | nothing |
| presses keys in an app | `WM_KEYDOWN` posted to its window | nothing; Chromium ignores posted keys |
| scrolls | the largest scroll area's `ScrollPattern`, or `ScrollItemPattern` on a control from the off-screen list | nothing |
| clicks a bare point, draws | mouse messages posted to the deepest child window under the point | nothing; Chromium and XAML read only the real pointer |
| browses | its own Chrome or Edge profile (`%LOCALAPPDATA%\hands\browser`) with a DevTools port: tabs, URLs, back and reload over the port, links and buttons by UI Automation | nothing, after you have signed in to that profile once |

What Windows taught, each of which cost a wrong turn to find:

- **Focus is the seat.** Activating a window puts it in front of you, and on another virtual desktop Windows follows the focus there. So nothing in background mode activates: `axFocus` does nothing, and every action notes your foreground window and puts it back if an app took it.
- **`ValuePattern.SetValue` on a classic edit control takes the keyboard focus first.** Such a control has a window of its own and takes its text as a message instead, which is what typing does, change notifications and undo included.
- **Asked through its top-level handle, a covered window's tree can stop at its title bar** (Paint: 7 nodes). Its child windows, the WinUI islands and the classic controls, still answer (Paint: 84), so each is read as a root.
- **A covered browser stops.** Windows presents no frames for it and Chrome paces a page by its frames: measured, 0 animation frames and 0 timer ticks a second until `--disable-gpu-vsync --disable-frame-rate-limit --disable-background-timer-throttling`.
- **Your own Chrome cannot be driven.** Chrome 136 and later ignores `--remote-debugging-port` for the default profile, hence the profile of its own.
- **A launch is not waited for.** An app reports ready seconds after its window exists, so the window is taken as it appears.
- **A window is closed with `WM_CLOSE`, never by ending its process**: `ApplicationFrameHost` hosts Calculator next to your Settings and Sticky Notes.

There is no Vision on Windows, and no OCR was added in its place: a screen is its UI Automation tree alone (`recognizeText` reads nothing), with Chromium told to publish its page's tree. A control with no label reaches no source, as on the Mac. Menus are not pressed by path: a Win32 menu is not in the tree until it is open, so `menu` says to press the menu bar item from the listing. Every call of the helper is a process start, which keeps the functions `macos.ts` has synchronous synchronous here; a helper that stays running is the obvious next step.

### What drives a task

Off the Mac a task is worked by Jev's own loop first (`src/drive.ts`), and the pi agent above is what it falls back on. On the old tree's simulated apps the loop solved 14 of 14 tasks in 6.7 rounds of Jev and no model call, against 8 of 14 in 15.5 rounds and 1.4 calls for the one-action step contract the `clicker` uses. It needs only the two keys in `.env`: no `pi` sign-in.

| step | what happens | costs |
|---|---|---|
| understand | `pilot.ts` reads the request as a recipe, a learned shape, or "open or search one site", and next to it one question of `drive.ts`'s own: does this name an application on this computer (Calculator, Notepad, Paint)? | one round of Jev, four requests side by side |
| plan | only when none of those fit, or for an application: one text call to `HANDS_PLAN_MODEL` for the start link, every text to type, the keys to press and the steps. An application's plan is written while it starts | one model call |
| work | `screen.ts`, a whole screen's worth of actions per look, in the hand's browser (`hand.open`) or the application's window (`hand.launch`): "12 times 31" is six presses of the real Calculator's keys in one look | one round of Jev a look |
| show | every step goes to the feed and to the terminal (`[screen] click button "Equals"`) before it is performed, and is never waited for | nothing |
| ask | an action the gate flags waits for the card's question. Declined or unanswered, the task ends as `stopped` | you |
| answer | when you asked to be told something, Jev picks the line of the last screen that says it (`answer: Display is 372`). It never writes one | one round of Jev |

- **The fallback is guarded.** The pi agent gets the task, with a note of what Jev opened and did, only when Jev gave up or ran out of looks, `HANDS_DRIVER` is not `jev`, and the provider of `HANDS_MODEL` is signed in (`hasConfiguredAuth`, asked before anything is handed over, since pi itself says "Provider is not configured" only once a task is under way). Otherwise the task ends with one line: what Jev could not do, and that `pi`, then `/login`, enables the fallback.
- **A no is never handed on.** What you declined, left unanswered or took back (Ctrl+Alt+Esc, Ctrl-C) ends there, and so does an action that goes against what you asked. Only your own words can allow a consequence: the gate is given the request as you said it, never a goal a model wrote.
- **`--listen` with Jev has no conversation.** What you say while a task runs is printed as `queued:` and is the next task, in the order it was said. What you say next is still planned from the page the hand is on ("open the second one").
- **The pi agent is only made when a task reaches it**, so `bun hands` and `bun hands --listen` start without it. `jev.log` in the run folder has the loop's own notes, a line per look.

| variable | default | purpose |
|---|---|---|
| `HANDS_DRIVER` | `jev` off the Mac, `pi` on it | `jev`: Jev alone, nothing is handed to the pi agent. `pi`: the pi agent alone, as before. Unset: Jev first, then the pi agent if it is signed in |
| `HANDS_PLAN_MODEL` | `openai/gpt-5.6-luna` | the one text call of a plan, and text written for a field, as `provider/model`. An `openai/` model needs only `OPENAI_API_KEY` |
| `HANDS_CONTACTS` | `contacts.json` | a JSON list of `{name, email?}` for "email Sam" |
| `HANDS_LEARNED` | `~/.hands/learned.json` | the shapes a plan that worked was generalised into, so the next request like it needs no model |

### Voice

`bun hands --listen` takes its tasks by voice. Hold F8, say what you want, and let go: the words show on the feed's card as you say them (on one line of the terminal with `HANDS_FEED=off`), and the finished transcript is the task. Someone speaking to it is at the machine, so `--listen` always works in the background.

- **One conversation.** What you say next follows on from what you said before, as a line typed at the `hands` prompt does.
- **Said while it is working, a task is queued** behind the one in hand (the next task for Jev, pi's `followUp` for the pi agent) rather than refused or barged in: half a task is worse than a late one. **Ctrl+Alt+Esc** drops a hold in progress, and if a task is running it stops it and empties the queue. Ctrl-C and the corner still work.
- **The key is watched, not taken.** `RegisterHotKey` reports a press and never the release, and a hold is the whole gesture, so the helper reads the key's state about 60 times a second. The key therefore still reaches the app in front: pick one it does not bind.
- **The ears are two modes of `windows.cs` that stay running**, unlike the rest of it: `mic` writes the default microphone to stdout as mono 24 kHz 16-bit PCM, and `hotkey` writes `down`, `up` and `cancel` lines. Each ends when its stdin closes, since a signal does not cross WSL interop.
- **Transcription is one OpenAI Realtime session per hold**, with no turn detection: the release is what commits the audio. The microphone starts at once and its audio queues while the socket connects, so the first word is not lost to the handshake. It needs `OPENAI_API_KEY`; pi's subscription sign-in does not reach that API.
- **Left for later**: acting on half a sentence (asking TypeSafe on every word whether there is an intent yet, so work starts while you are still talking). `onPartial` in `src/voice.ts` is where that plugs in. On the Mac `--listen` stops with one line saying so; `microphone` and `heldKey` in `macos.ts` are the two functions to fill in.

| variable | default | purpose |
|---|---|---|
| `HANDS_PLATFORM` | by `process.platform` | `windows` or `macos`; under `bun test` it is `macos` unless set |
| `HANDS_DEVTOOLS_PORT` | `9333` | the DevTools port of the agent's browser |
| `HANDS_BROWSER_PATH` | Chrome, else Edge, where they install | any other Chromium |
| `OPENAI_API_KEY` | required for `--listen` | the Realtime transcription session |
| `TRANSCRIBE_MODEL` | `gpt-live-transcribe` | the transcription model |
| `HANDS_HOTKEY` | `F8` | the key held to speak: a key name as the `key` tool takes it (`f1` to `f12`, `space`, a letter) |

Not yet checked on a live desktop, in the order worth checking:

```
bun clicker-inspect "open the Playground"                    # builds windows.cs; the capture and the item list of the front window
bun clicker "press the seven key" --act                      # Calculator in front: a press by pattern, the seat untouched
bun hands --background "Open up the calculator and check for me what 1337*1337 with it"    # while typing in another window: focus must never move
bun hands --background "go to wikipedia and find the capybara article"                     # the agent's own browser, behind yours
bun hands --listen                                           # hold F8 and say "open the calculator and work out 12 times 31": the words appear
                                                             # as you speak, the task starts on release, and your focus never moves
```

For `--listen`, also worth checking: a tap of F8 starts nothing; a second hold while it works prints `queued:` and runs after; Ctrl+Alt+Esc mid-hold drops it and mid-task stops it; with the microphone switched off in Settings > Privacy & security, the hold fails with the helper's own line.

### Feed

What you see of a hand is drawn by one more mode of the helper, `feed` (`src/feed.cs`), which stays running and only draws. Its windows cannot take the focus, the pointer, or a click meant for something else: all are `WS_EX_NOACTIVATE`, and the pointer overlay and the card are click-through as well.

| when | you see |
|---|---|
| you hold F8 | a card at the bottom of the screen: a green dot and "Listening" |
| you speak | your words on the card as they are said, the newest always in view. Hands already at work stay listed under them |
| you let go | "Got it", then, once the transcript is final, a row for the task: `H1 running` and what you asked |
| it works | a tile in the bottom right corner: a live picture of the hand's window (a DWM thumbnail, which costs nothing and shows a covered window) with the hand's pointer drawn over it. It glides to each control, ripples on a click, lights a field and spells the text in its tag as it types, flashes a control it pressed in place, and names where it is going in a chip along the bottom edge. Under the task's row a line says how far along it is, the first after about two seconds. A second hand gets a tile above the first, in a colour of its own |
| it is about to do something sensitive | the card turns amber and asks: who, what, to what, and a countdown. **Ctrl+Alt+Y** allows it, **Ctrl+Alt+N** declines, and 30 seconds of nothing declines. A no is final: the action is not done, and is not handed to another agent |
| it is done | the row says `done` (or `failed`, `stopped`). The card leaves after 4 seconds; the tile stays 20, for a look at the result, and then gives the corner back |

- **Nothing in the feed can hold a hand up.** A driver reports a `Step` (`src/steps.ts`) before each action and never waits on it. A helper that has died takes the same calls and does nothing, and with `HANDS_FEED=off` the terminal gets the words (one line, which anything printed meanwhile goes above rather than over), the progress lines, and the question as `[y/N]`.
- **The C# only draws.** How fast a pointer moves (a glide is 140 to 300 ms, a new target bends the glide under way, nothing queues), where a ripple is and how the picture is letterboxed are decided in `timeline.ts`, `fit.ts` and `paint.ts`, where they are tested with no window. It draws about 30 times a second, and only while something moves.
- **The progress line is a fast model reading the last eight steps against what you asked** (`src/narrate.ts`): one call at a time, none for an unchanged log, 1 to 2 seconds each as measured, and a failed or late one is dropped without a word. It is told the line you are reading now and says nothing when there is no news. It cannot say the task is done; the driver says that.
- **A secret is masked before it goes anywhere.** A `Step` marked `secret` is `••••••` in the pointer's tag, on the tile's strip, and in what the narrator is given, even when the driver's own label quotes it.
- **The chords exist only while a question stands** (`RegisterHotKey`), so they never reach the app in front; if another program owns them the keys are watched instead, as the hold key is. Two hands that ask at once are asked one at a time, and closing the feed answers no.

| variable | default | purpose |
|---|---|---|
| `HANDS_FEED` | on | `off` keeps everything in the terminal |
| `HANDS_NARRATOR_MODEL` | `openai/gpt-5.6-luna` | who writes the progress line, as `provider/model`; `off` says nothing. An `openai/` model needs only `OPENAI_API_KEY`, no `pi` sign-in |

Left for hands on a virtual desktop of their own, which is where they belong:

- The tile must not assume the hand's window is on your desktop. The thumbnail already does not (DWM composes a window wherever it is), but nothing here moves a hand's window to another desktop yet, and whether the feed's own windows follow you when you switch has not been checked: if they do not, they have to be pinned to every desktop.
- Activating a window on another virtual desktop makes the shell move it to yours, so everything done there has to stay free of activation, as it is here.
- As the older tree measured: a Chrome there needs `--disable-gpu-vsync --disable-frame-rate-limit` or its page stops, and a UWP app serves an almost empty UI Automation tree there.

### DevTools

The agent's browser is worked over its DevTools port, and WSL cannot reach a port on the Windows loopback. So nothing on the TypeScript side opens a socket: one more mode of the helper, `devtools <port>`, holds a single WebSocket to the browser's endpoint and carries lines. A line down its stdin is one message to Chrome, a line up its stdout is one message from Chrome, and it ends when its stdin closes. It is a relay and not a client: every message is composed and read in `src/devtools.ts`, the same from WSL and from Windows.

- **One socket, many pages.** `connectCdp()` opens the relay; `attachPage(cdp, targetId?)` makes a page a flattened session on it (`Target.attachToTarget`, `flatten: true`), so every tab a hand works costs one process start between them. `windows.ts` keeps one connection for the process (`browserCdp()`), opened on first use and once more after it has closed, and it does not keep the process alive.
- **When nothing listens** the helper writes one line, `{"error":"nothing listens on DevTools port 9333"}`, and `connectCdp` rejects once with it, in about half a second: a refused loopback connection is otherwise retried by Windows for two.
- **Measured** from WSL against a headless Chrome 153: connect 330 ms, an `evaluate` round trip 0.8 ms (median; 1.3 ms at p95), 200 calls in flight at once 31 ms, a 5 MB reply 115 ms, a 2 MB request 67 ms.
- **Nothing here brings the browser forward.** Chrome activates a tab's window along with the tab (`Target.activateTarget`, `Page.bringToFront`, a tab made in front), so in the background a url opens in the tab that shows, a new tab is made behind it, and `switch_tab` is refused with a sentence. The agent's window is found by the browser process DevTools reports (`SystemInfo.getProcessInfo`), since your own Chrome has the same name and the same kind of title.
- **For some 15 ms after a navigation Chrome lists the tab with no address**, so `browserUrl` asks the page when the listing has none.
- `HANDS_BROWSER_PROFILE` names the profile folder (default `%LOCALAPPDATA%\hands\browser`, found from WSL by asking Windows).

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
  windows.ts      the same exports for Windows: PrintWindow, UI Automation, posted input, DevTools
  windows.cs      its native half, built on first use with the C# compiler Windows ships
  devtools.ts     the browser's DevTools protocol in lines through the helper, the same from WSL and Windows
  platform.ts     picks one of the two; everything else asks it
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
  voice.ts        `hands --listen`: the held key, the Realtime transcription session, the loop that feeds the agent
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
