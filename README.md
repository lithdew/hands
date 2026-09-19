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
echo 'OPENAI_API_KEY=...' >> .env      # only for `bun live`: the voice is OpenAI's gpt-live-1
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
| `OPENAI_API_KEY` | required by `bun live` | the voice |
| `HANDS_LIVE_MODEL`, `HANDS_LIVE_VOICE`, `HANDS_LIVE_BACKEND` | `gpt-live-1`, `marin`, `gpt-5.6-luna` | the voice, how it sounds, and the Responses model behind it that turns what was said into tool calls |

Grant your terminal **Screen Recording** and **Accessibility** in System Settings > Privacy & Security (and **Microphone**, for `bun live`), and let it control your browser the first time macOS asks. Without the first, captures are wallpaper. Without the second, synthetic clicks are silently dropped, and both commands refuse to drive the machine.

## Use

```
bun hands "prompt"                                   # one task
bun hands --background "prompt"                      # any app or site, without taking your mouse, keyboard or focus
bun hands --name Lefty --color 4f8cff "prompt"       # the hand on screen: its name and colour (--no-hand runs without one)
bun hands                                            # a prompt per line, same conversation
bun live                                             # hold right Option, say what you want, and hands go and do it
bun live --quiet --say "open the calculator and work out 12 times 12"   # the same without a microphone or a speaker
bun clicker "open the Playground"                    # dry run: one step, prints what it would do
bun clicker "open the Playground" --act              # drives the machine, up to 100 steps
bun clicker "log in" --act --steps 20 --delay 3      # longer and slower
bun clicker-inspect "any goal"                       # 3-2-1, capture, open the annotated screen + payload
```

**Stopping a live run.** Ctrl-C, or slam the mouse into the top-left corner of whichever screen it is on. The clicker also stops itself on `done` or `none`, on confidence under `--min-confidence` (0.4), after two consecutive no-ops, or at `--steps`.

**Sharing the seat.** By default the agent uses your mouse, keyboard and focus. If you bring another app forward mid-task, its input tools refuse to act until it has looked at the screen again, so a keystroke meant for a web page does not land in your terminal. It is best left alone while it works, or run in the background.

## The hand

While it runs, the agent is on screen: an emoji hand with its name on a tag underneath, riding on the window it is working in.

| it is | the hand |
| --- | --- |
| starting, or taking a new prompt | 👋 waves, top right of the main display, with the prompt on its tag |
| reading the window (`screen`) | 🖐️ sweeps over it: `looking` |
| waiting on the model, or running a shell or file tool | 👆 bobs: `thinking`, `bash “…”` |
| clicking or pressing | 👆 glides there on a slight arc, taps, and a ring spreads from the fingertip: `click “Sign in”` |
| typing, or writing a file | ✍️ scribbles: `typing “…”` |
| drawing or dragging | ✍️ the pen's point follows the pointer event for event, so the ink comes out of it |
| pressing keys | 👇 taps once per chord |
| scrolling | ✌️ two fingers swipe the way a trackpad would |
| opening an app or a page | 👉 `opening Notes`, `open arxiv.org/…` |
| waiting | ✋ |
| finished, or stopped | 👍 or ✋, which lingers a moment after the process has gone, then fades |

- **Attached to the window.** With `--background` the hand belongs to the window being worked: it is stacked directly above that window in the window server's order (`orderWindow:relativeTo:` takes another app's window number), so whatever of yours covers the window covers the hand too, and it follows the window when it moves, leaves with it when it is minimized or on another desktop, and is put back above it within a frame or two if the window is raised past it. Its coordinates are the capture's own, from the window's corner, so the fingertip lands on the control being pressed. Without `--background` the agent works the whole screen, menus and all, so the hand rides on the display instead, above everything.
- **Any colour.** `--color 4f8cff` (or `'#4f8cff'`, or `HANDS_COLOR`) makes the hand, and the ring it taps with, that colour; without it the hand is the emoji's own yellow. Colour emoji are pictures, so there is no colour to set: each glyph is set in type, photographed into a bitmap, and every pixel given the tint at the brightness it had. The shading survives, the pen stays black, and the skin comes out the colour asked for.
- **It never gets in the way, and it is in your recordings.** The window ignores the mouse, cannot take the focus, and belongs to a process with no Dock icon. The agent must not see its own hand: it would cover the very thing it points at, and its tag would be read back as text. A window is captured by id, which leaves the hand out anyway. A display capture would not, so for exactly as long as one of those takes, the hand's window tells the window server to leave it out of captures, and the agent waits to hear that it has before it shoots (measured: out of 12 of 12 of the agent's captures, in every capture between them). So a screen recording shows the hand throughout a background run, and throughout a foreground run but for a blink at each of the agent's looks. The window also declares itself 99% opaque, which no eye can tell, so that the check for "is my browser window covered?" knows to look through it.
- **How it is drawn.** `src/hand.ts` spawns itself as a second process and sends it one JSON cue per line. That process is an AppKit app driven from `bun:ffi` like everything else here: a transparent window the size of the display, and a few Core Animation layers (the glyph, the ring, the tag). Core Animation plays every motion inside the window server, so nothing draws frames and an idle hand costs about 1% of a core. It is a process of its own because the agent's thread stalls for a second at a time in OCR and tree walks, and because a fault in a drawing must never end a run: if the renderer dies, the cues become no-ops. All timing is the agent's side: it waits out the glide (160 to 520 ms) before it presses, so what is pressed visibly answers to the hand.

## Live: hold a key and say it

`bun live` is the whole thing in one gesture. Hold the **right Option** key, say what you want done, let go. A voice hears it, answers in a few words, and sends out hands: one, or several at once when the parts are independent ("open the calculator and work out twelve times twelve, and have another hand find the top story on Hacker News" is two hands, working side by side, each with its own name and colour). When a hand finishes, the voice tells you what it found.

- **The panel.** In the bottom right corner, one card per hand, headed in that hand's glove colour (the colour its hand wears out on the screen): a live picture of the window it is working in, with its hand drawn over the picture where the real one is, and under it what it is doing this moment, or what came of it. Up to eight hands can be out; as they pile up, the cards that matter least fold down to their headers, the ones at work last, so the column always fits the screen, and a finished hand keeps its answer showing. Click a card for its sheet: what it was told, every tool call as a verb and what it was done to, what it said, and a box to tell it something; `↵` sends, `esc` goes back, `⌘W` closes the hand for good, and there are buttons to pause, stop and close. A card disappears while you have that hand's own window in front of you, since then you are looking at the real thing.
- **The dock.** Under the cards, the voice, in the yellow of the hand emoji itself, and nothing else in the panel is that yellow. While you hold the key it opens up with your words in large type as they are heard, and the fingers of its hand rise with your voice; they drum while it thinks; and when it answers, the same two colours turn the other way round, so you can tell who is talking without reading a label. The type is what ships with every Mac (Superclarendon for names, Avenir Next for what is read), so nothing is fetched.
- **Click a hand to stop it where it is.** The hand on the screen can be clicked: it stops in its place, its card opens, and the box has the keyboard, so you can type what it should do instead. An empty `↵`, or Resume, lets it carry on.
- **Or say it.** "Tell Lefty to also check Friday." "How are the hands getting on?" "Stop Righty." "Close them all." The voice always knows who is out, on what, what each is doing, its last few actions, and what the finished ones found.

How it is put together (`src/live.ts` is the wiring, and none of the three parts knows of the others):

- **The voice** is one `gpt-live-1` session over the `openai` library's `LiveWS`, and the loop is the one in OpenAI's guides with nothing built on top of it. `session.start` names the model, the voice, PCM at 24 kHz, the conversation instructions, and **Responses delegation**: a backend model (`gpt-5.6-luna`) with five function tools, `start_hands`, `steer_hand`, `stop_hands`, `close_hands` and `get_hands`. gpt-live-1 is full duplex and "manages when to listen and speak as audio streams continuously", so an open session is sent `session.input_audio.append` without a break, at the pace it was recorded: the microphone while the key is held, silence while it is not. The key is this application's control of its own microphone; when you have finished, what you want, and whether to delegate it are the model's to decide, from the audio. Its speech, `session.output_audio.delta`, is queued for playback in order (not while the key is held, and what is queued is dropped when the key goes down: that is talking over it). The backend's tool calls arrive as nested `response.event`s: a call is whole at `response.output_item.done`, and when the response is `completed` every call is carried out here, answered with `response.item.create` (a `function_call_output`), and the response continued with `response.create`. Transcript deltas are captions, and nothing else.
  - *The voice is kept current* with the two documented appends: `session.commentary.append`, which it speaks, when a hand finishes or fails, and `session.thinking.append`, which it only knows, with how every hand is getting on: every twenty seconds while they are working and something has changed, and not while anyone is talking. The backend's instructions are updated with `session.update` whenever who is out changes.
  - *Cost and lifetime*: an open session costs $0.05 a minute, so after a minute with nothing said it is closed the documented way (`session.close`, then `session.closed`), and started again when the key is next held (what is said meanwhile is buffered through the connection, as the guide suggests) or a hand has something to report. A session started again is told how the hands stand; they outlive sessions.
  - *Two things learned the hard way, both by departing from the guides*: a note sent just as the user finishes a sentence gets in the way of the voice deciding what to do with it (it then delegated one turn in five by itself; left alone, five in five); and anything that guesses at turns, mutes and unmutes around them, sends audio in bursts, or second-guesses whether the voice "really" delegated makes it worse, not better. An earlier version did all of those.
- **The hands** are ordinary `hands --background --json` processes, up to eight. `--json` makes a hand something another program can run: commands in on stdin (`prompt`, `steer`, `pause`, `resume`, `stop`), and on stdout a JSON line for everything it does: each tool call and result, what it says, every cue its on-screen hand is sent (which is how the panel draws that hand, and knows its window), a click on the hand, and how each run ended. A `steer` to a working hand is queued by pi and read after its current turn; to an idle one it is a new prompt in the same conversation.
- **The shell** (`src/shell.ts`) is the key, the microphone, the speaker, the panel and a camera, all bun:ffi with no thread of its own: AppKit, WebKit and the microphone's AudioQueue deliver on the main run loop, which is the JS thread, pumped on a timer. The key is polled, so there is no event tap and no permission, and it is read from the modifier flags (`CGEventSourceFlagsState`, where each side's Option has a bit of its own: the key-state table never shows a modifier as down); a keystroke while Option is held means you are typing a character, and cancels. The microphone is kept warm: open all the time, remembering its last third of a second in memory and sending nothing, so that a press hands over audio from just *before* the key went down and never clips the start of a sentence (first audio 0.1 ms after the press, against 55 to 100 ms for a microphone that has to start). The price is the system's microphone light staying on; `--cold-mic` opens it only while the key is held. The speaker is an `AVAudioPlayerNode`, which is the guide's "queue the audio for playback in order" as an object: what is scheduled on it plays after what came before, or at once if nothing is left, on the system's audio thread rather than this one, and it is opened once and left running. gpt-live-1 sends its speech a tenth of a second at a time, exactly as fast as it is spoken, with a stall of 130 to 190 ms every few seconds that it never makes up (measured), and only as fast as it is sent audio itself. So the silence between presses is paced by the clock and not by a timer's ticks (which ran 3% slow, and the speech with them), and the speaker's queue is kept 200 ms ahead with silence: restored in the voice's pauses, where more silence cannot be heard, and let down in them again after a burst from the network. (It was an AudioQueue first, which takes what is queued on a dry queue as already in the past and throws part of it away: crackle, then nothing. It also took half a second to start for each sentence.) The panel is a borderless, non-activating `NSPanel` holding a `WKWebView` on a page served from this process (`src/ui/`), two classes made at run time so that it can take the keyboard and the first click; pictures of the hands' windows come from SkyLight's window capture, about 7 ms each and no file. The page's socket opens only to the key the panel was started with: anything on a Mac can reach a local port, a web page included, and this one steers agents that work the Mac.

Tested with synthesized speech through `--say`, which goes down the same path as the microphone: two hands from one sentence, a correction spoken a second after a request (it became a `steer_hand` to the hand already on it), a clarification ("book a table" … "Dim Sum Library, tomorrow, three people" became one complete task), a status question answered from the notes, closing everything, and a session hung up on and started again mid-conversation. The key is tested against posted key events and the warm microphone on its own; the speaker against a recording of the voice replayed at its measured cadence, stalls and a network hiccup included, with `HANDS_DEBUG` printing every time silence had to go into the middle of speech (in a real exchange: never).

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
                  (hand.ts draws with the Objective-C runtime bound here)
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
  live.ts         `bun live`: the voice (gpt-live-1), the hands it sends out, and the panel that shows them
  shell.ts        the live orchestrator's key, microphone, speaker, web panel and window camera
  ui/             the panel's page: a card per hand, its transcript and steer box, the voice's captions
  hand.ts         the hand on screen: the cues the tools send, and the process that draws them
  agent.ts        `hands`: the pi agent, its system prompt, transcript pruning
tests/            pure logic: dates, merging, reading order, echo filter, the OCR cache,
                  decisions, actions, the tree walk against a fake tree
```

## Development

```
bun test
bun run typecheck
HANDS_DEBUG=1 bun live --quiet --say "…"   # every Live event and panel command on stderr; SIGUSR2 hangs up on the voice
```

## Known limits

- Everything on screen goes to the model and into `runs/<timestamp>/agent.log`, including whatever note, mail or key happens to be showing. `runs/` is gitignored; treat it as private.
- OCR only sees text, and the accessibility tree only covers apps that publish one. Electron apps and canvases mostly reach neither, which is what `screen`'s screenshot is for.
- Two identical labels get only a coarse region hint and split the classifier's vote.
- Chords go by US-layout keycodes; typed text does not.
- What is typed shows on the hand's tag, as it does in the terminal. In a recording of a foreground run the hand drops out for the moment of each of the agent's own screen captures.
- `bun live`: what you say goes to OpenAI, and each hand's screen goes to its own model as above. Option is a modifier too, so the key listens only when nothing is typed while it is held, and the first tenth of a second after it goes down is lost to the microphone starting. Two hands in the same app get in each other's way (the browser excepted: each has its own window), so the voice is told not to do that.
- The OCR crop handed to Vision starts on a 4-pixel boundary on purpose: off it, Core Image reads past the end of ImageIO's buffer, which on a 3840x2160 capture is a guard page and a bus error (macOS 26.5; see `recognizeText`).
- Passwords are never typed. Rely on the browser's password manager or an SSO button.

## License

MIT, as is the original.
