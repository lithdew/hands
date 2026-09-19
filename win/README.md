# win/: hands on Windows

Windows virtual desktops, capture and input live in this folder. The shared Pi runtime, speech coordinator and panel are connected through `createDesktopAgent({ desktop })` and `servePuk({ dependencies })`. `semantic-computer.ts` provides the shared compact-observation interface; `win/semantic.ts` supplies its Windows backend.

```sh
bun install
bun run start:win        # two hands; open http://127.0.0.1:7777, or hold F8 and speak
# bun win/serve.ts 3     # choose a different hand count
```

Both native Windows Bun and WSL startup have been exercised on this machine (WSL starts Windows programs through interop). First run builds `out/win/puk-win-<hash>.exe` with the C# compiler that ships in Windows. Its name includes a source hash because Windows locks a running `.exe`. Install [Cua Driver](https://cua.ai/docs/how-to-guides/driver/install) and keep `cua-driver` on `PATH` (tested with 0.28.2):

```powershell
irm https://cua.ai/driver/install.ps1 | iex
```

The installer registers a `cua-driver-serve` autostart task. Puk does not use it; it starts a private `cua-driver mcp` per hand. Remove the task from an elevated PowerShell with `cua-driver autostart disable`.

Copy `.env.example` to `.env` and add the Jev and model keys. The supported LLM pool is Luna, Gemini 3.8 Flash, and Astra, all routed at low effort. A Vertex key stored under `GEMINI` or `GEMINI_API_KEY` requires `GEMINI_BACKEND=vertex`; `GOOGLE_CLOUD_API_KEY` selects Vertex automatically. See the [root provider setup](../README.md#keys-and-providers) for service tier and voice settings. `bun start` remains the Omarchy entry point.

## The idea

Several workers on one computer, each in their own pane. You keep your desktop, pointer and keyboard. Each hand is a Windows virtual desktop (`Puk hand 1`, `Puk hand 2`) holding the windows its agent opened, and works there in the background. A small always-on-top preview per hand streams what it is doing. Independent spoken tasks go to free hands, as on Omarchy; that part is `jev/listen.ts` and is unchanged.

```text
F8 held -> puk-win mic -> OpenAI realtime -> Jev listener -> Pi worker per free hand
                                                              |- apps / open_app   Start menu, launched into the hand's desktop
                                                              |- computer          Cua window capture + background input
                                                              '- bash              WSL bash, or PowerShell on native Bun
hand state + front window, once a second -> puk-win pip -> live preview (DWM thumbnail)
```

| Control | Action |
| --- | --- |
| Hold F8, release | Speak a task. `PUK_HOTKEY=F9` (F1 to F24, or a virtual-key number) changes the key |
| Ctrl+Alt+Esc | Stop capture and every worker |
| Click a preview | Go to that hand's desktop; click it again (or **‹ Desktop** in the panel) to come back |
| Drag a preview | Move it |

Previews show while a hand is working (blue), waiting for approval (amber) or failed (red), stay green for a few seconds after it finishes, and hide when it is idle, like the Omarchy tiles. A hand with no window yet says so instead of showing a black box. They never take focus.

## Sign the hands in, once

A hand's browser is not your Chrome. It is Puk's own profile (`%LOCALAPPDATA%\Puk\hands\<id>\browser`), so Gmail, Keep, Messages and the rest open signed out until you sign in inside it:

```sh
bun win/desktop.ts login          # every hand, one after another; or: login 1, login 1,2, login bench
bun win/desktop.ts sessions       # which sites each hand is signed in to (shows no window)
```

`login` closes the hand's background browser, opens the same profile as an ordinary window on your desktop, waits until you close it, and says what it found ("Hand 1 is signed in to: Google"). The profile is kept, so this is once per hand, not once per run. While `bun win/serve.ts` is running the command goes through it (`POST /login?hand=1`, state on `GET /login`), because the server owns those browsers; a hand that is working refuses, and a hand whose sign-in window is open tells a task so instead of starting.

Why a window of its own, and not your Chrome:

- **Your Chrome cannot be driven.** It has no DevTools port, Chrome 136 and later ignores `--remote-debugging-port` for the default profile, UI Automation sees next to nothing on another desktop, and acting on your window would take your screen. Its profile is never read, copied or pointed at.
- **The sign-in window has none of the hand's switches.** Google refuses sign-in ("This browser or app may not be secure") to a browser it takes for automated, and a DevTools port is one of the things it looks at. The session it grants is an ordinary cookie; the hand's browser, with DevTools, uses it afterwards like any other. `PUK_WIN_LOGIN_FLAGS` appends switches to that window; the flow was tested end to end with `--headless=new --remote-debugging-port=0` standing in for the person.
- **One profile per hand stays.** One shared profile would mean one Chrome process for all hands: the DevTools target is found by window title (`browser.ts`), so two hands on the same site would drive each other's page, the sweep that clears a leftover browser at first launch would take the other hands' windows with it, and the bench could no longer run beside a server. Copying a signed-in profile to the other hands was rejected too: two browsers rotating the same Google session cookies (`__Secure-1PSIDTS`, device-bound sessions) can sign each other out, and a live cookie database does not copy cleanly.

A hand that still lands on a sign-in page stops and says which command fixes it: `signInWall(url, title, hand)` in `session.ts` knows Google's and Microsoft's sign-in pages, the brochure Google shows signed-out visitors instead of Gmail, the Messages pairing page and sites with a login address of their own; `handWall(hand)` in `desktop.ts` asks the hand's page and looks twice, because a signed-in browser passes through the same addresses for a moment.

"Click on that email" is about *your* window. `userForeground()` / `userWindows()` give its title and app (your foreground window, or what is right behind Puk's panel) for understanding the request only. The hand opens the same site in its own browser and never touches yours.

Pi progress captions are exposed in worker status and used in the preview. They summarize bounded, redacted events with Luna at low effort, or Gemini when no OpenAI key is configured. The output caps are 256 tokens for Luna and 1,024 for Gemini; truncated captions are discarded. Changed events coalesce at six-second intervals; idle/unchanged state makes no model calls. Initial and approval captions are deterministic, and a narration failure does not interrupt work. `PUK_NARRATION=0` disables model narration.

For a log worth reading afterwards: `PUK_DEBUG=1 bun win/serve.ts 2 2> out/win/serve.log`.

## Jev first, Pi when needed

`win/jev.ts` runs `jev/cua.ts` before Pi. Jev can open native apps and drive labelled browser controls; Pi handles native work beyond opening, generated text, images and recovery. Pi now has compact observations and action results as well as screenshots, so it need not request an extra screenshot after every control action:

```text
request -> one Jev call: which app? only open it? does the speaker want an answer?   ~0.5 s warm
   native app    Jev opens it. "Only open it" ends here; more goes to Pi in the open app
   browser work  quickIntent (Jev) builds the intent, the hand's browser goes to its site, then per action:
                   observe.ts   the page's DOM as labelled elements over persistent DevTools
                   decide       ONE Jev request: nine independent move/state/argument questions
                   gate         separate Jev request on the exact proposed action
                   perform      click / type / key over DevTools; reuse the post-action observation
   wants an answer   one vision call on one screenshot. Only NOT_VISIBLE, or Jev giving up, starts a full vision run
```

`Deps` supplies `perform`, `screenshot` and `settleMs` so the shared loop can use each platform's input. The production contract keeps literal query text and target scope, uses readable text even when a page has no controls, and can retry a low-confidence loading observation once before escalation. See the [Jev eval report](../docs/jev-evals.md) for measured decisions and limitations.

An earlier `bun win/bench.ts` smoke run (2026-09-19, on battery, 1.4 GB RAM free, VPN) measured "go to youtube" at 6.8 s, including 5.6 s of page loading and 0.4 s of Jev; "search wikipedia for capybaras" at 22.8 s, including two page loads and an answer-writing call. These are individual real-task observations, separate from the later controlled synthetic contract evals.

**Native applications are Jev's too, through UI Automation** (`uia.cs`, `uia.ts`; 2026-09-19). It was once written off here: asked through its top-level handle, a window on another desktop shows its title bar and nothing else (Paint: 7 nodes). Its content's own child windows, the WinUI islands and the classic controls, still answer, so `uia.cs` reads each child window as a root and merges them: Paint 57 controls with every colour by name, Character Map 345, in one cached request of 5 to 450 ms. Actions are patterns (`Invoke`, `Select`, `Toggle`, `Expand`), which need no pointer and no focus. `bun win/native.eval.ts` (live, on its own desktop): "make red the main colour" in Paint and "put the word hello in the characters to copy box" in Character Map, each one plan, one look, one action, 3 Jev requests, about 3 s after the plan, confirmed from the application's own state, with the user's desktop and focus logged unchanged after every phase. Two things it cost to learn: `ValuePattern.SetValue` on a classic edit control takes the keyboard focus, which activates the hidden window, and Windows then follows it onto the hand's desktop (the user's screen flipped); an edit control with a window of its own is now sent `EM_SETSEL` and `EM_REPLACESEL` instead, and every native action notes the user's desktop and focus first and puts them back if they moved. **UWP applications stay closed**: Calculator, Settings and Clock are detached into a `CoreWindow` that serves one node while hidden; they remain the vision agent's, as does anything made by eye (a canvas ignores posted drags). Not yet tried: menus and dialogs that open as separate windows, Office, Electron apps, a native key press. `PUK_JEV_FIRST=0` turns this off and every task goes to the vision agent.

## Compact tools from the supplied Pi extension

`computer_look` lists the hand's windows or returns a bounded view of its active window. `computer_act` addresses a current reference and returns fresh state; `computer_browser` reads and operates the hand's current browser page. Each observation renews references, and failed observations or actions invalidate them. The output highlights changes and includes current references; a changed screen is not treated as proof that the requested result occurred.

The Windows port uses Cua UI Automation tokens for native controls and the existing persistent DevTools connection for browser input. It checks the observed window and screen before acting and retains the same Jev action gate, cancellation and instruction-revision guards as other Pi tools. Browser target selection fails if several pages match ambiguously. The macOS extension's Retina coordinate conversion, `open -g`, and implicit existing-profile preparation are not copied into this backend.

For coordinate-bearing `computer` calls, Gemini must explicitly declare `coordinate_space="normalized_1000"`; pixels or omitted units produce a corrective error. Luna and Astra default to screenshot pixels and may explicitly choose normalized coordinates. Every point in a batch or drawing path shares the same declaration. The runtime converts against the exact bound capture dimensions and supplies resolved pixels to the gate. Semantic references do not require model-supplied coordinates.

The supplied `pi-tier.ts` setting is also integrated: OpenAI requests default to `service_tier=priority`, configurable through `PUK_SERVICE_TIER` or `PI_TIER`. It is applied through Pi's `onPayload` hook and the standalone Responses adapter. No priority-tier performance gain has been measured here.

## Files

| File | Purpose |
| --- | --- |
| `serve.ts` | Entry point. Runs `servePuk` on a private port with Windows dependencies and fronts it, because `/desktop.png` and `/desktop/*` in `hotkey.ts` call `pip.ts` directly |
| `desktop.ts` | Hands as virtual desktops, app discovery and launch, window state, the Cua connection `ai.ts` expects, signing a hand's browser in, CLI (`up`, `list`, `down`, `login`, `sessions`) |
| `session.ts` | Pure: which page is a sign-in wall, which cookies mean a session, what the user is looking at |
| `browser.ts` | Background input for the hand's browser over DevTools |
| `observe.ts` | The hand's browser page as labelled elements for Jev |
| `semantic.ts` | Compact Pi look/act/browser tools, native Cua references and browser bindings |
| `jev.ts` | Jev-first runtime: Jev opens apps and drives the browser, the vision agent takes the rest |
| `bench.ts` | Time real tasks on a private desktop, next to a live server |
| `helper.cs` | Native helper: microphone PCM, held-key polling, window state, virtual desktops, previews, DevTools relay. C# 5 only |
| `vendor/VirtualDesktop11-24H2.cs` | MIT, Markus Scholtes. Wraps the undocumented shell COM interfaces for virtual desktops |

## What Windows allows, measured on build 26200

The legacy pixel/drawing `computer` tool speaks Cua's Linux surface: one desktop target, foreground delivery, `mouse_button_down` / `mouse_drag` / `mouse_button_up`. `connectCua` in `desktop.ts` turns that into calls against the hand's front window; compact native tools address the window directly. Earlier checks of windows on another desktop determined these limits:

| | Result |
| --- | --- |
| Capture a window on another desktop (`get_window_state`) | Full resolution, live |
| Click real controls: buttons, menus, swatches | Works in the background through UI Automation |
| Posted drag on Paint's canvas | Reported as delivered, draws nothing |
| Posted keys or text into Chromium | Refused by the driver |
| Cua's own CDP typing (`browser_type`) into a background browser | Refused (`route_unavailable`) |
| DevTools `Input.dispatch*` sent directly | Works with no focus: clicks, text, keys, wheel, a held stroke |
| Foreground delivery to a window on another desktop | Lands on the **user's** screen instead. Never used for a hand that is not visible |
| Activating a window on another desktop (a UIA click does) | The shell reassigns it to the current desktop |
| UI Automation tree of a hidden window, from its top-level handle | Title bar only (Paint: 7 nodes) |
| The same, reading each child window as a root | The whole window (Paint: 57 controls, Character Map: 345), 5 to 450 ms |
| UI Automation tree of a hidden UWP window (Calculator) | One node. Its content is detached into a `CoreWindow` that serves nothing |
| `Invoke` / `Select` on a hidden window | Works, takes no focus |
| `ValuePattern.SetValue` on a hidden classic edit control | Sets the text, takes the focus, and Windows switches the user to that desktop. `EM_REPLACESEL` to the control does not |

So:

- **The browser is the hand's strongest tool.** It runs with its own profile (`%LOCALAPPDATA%\Puk\hands\<id>\browser`), `--remote-debugging-port=0`, occlusion checks off so it keeps painting while hidden, and scale 1 so a screenshot holds a full desktop layout. Points inside the page go over DevTools in CSS pixels; the toolbar and tabs go to Cua. The address bar cannot be typed into from the background, so `ctrl+l`, text, `enter` becomes one `Page.navigate` (a URL, or a Google search). WSL cannot reach Windows loopback, so the helper relays the WebSocket; the JSON stays in TypeScript.
- **Hands track each window's lifetime, not just its handle.** The helper verifies HWND, PID and a per-window nonce before reclaiming a stray. State reads are serialized: a temporarily omitted active window remains unavailable for input until it returns or its closure is confirmed, instead of silently selecting another app. Captures, stored app references and buffered strokes carry the same identity. `open_app` explicitly selects a window, a new dialog can take focus, and stacking order is ignored because desktop switches reshuffle it.
- **A hidden browser must be unpaced.** Windows presents no frames for a window on another desktop and Chrome paces a page by its frames: measured, a hidden page got 0 animation frames and 0 timer ticks a second, and YouTube took a minute to load. `--disable-gpu-vsync --disable-frame-rate-limit --disable-background-timer-throttling` give 43 and 99. `PUK_WIN_BROWSER_FLAGS` appends more.
- **Never read Chrome's files per call.** `DevToolsActivePort` takes 0.7 to 1.9 s to read from WSL; it is read once per browser launch. Each hand has its own helper process for DevTools, with a 2.5 s limit, so a page that stops answering cannot hold up window state or another hand. Navigation assigns `location` instead of `Page.navigate`, which only answers once the site has.
- **Capture is the helper's own** (`PrintWindow`, about 100 ms, works on another desktop). Cua's takes 0.5 to 2.5 s and queues behind the 5 s it settles after a launch; it is the fallback for a window that will not draw.
- **Each hand's browser is started at startup** (`PUK_WIN_PREWARM=0` to skip), so `open_app` for any browser is a 20 ms raise. The app list sent to the model is ids and names only (8 KB instead of 37 KB); launches are one at a time, because a new window is recognised by being new on the user's desktop.
- **Spin-up is kept short.** The Start menu listing costs PowerShell about 3 s, so it is cached for five minutes and warmed at startup with each hand's driver. Cua's `launch_app` returns about 5 s after the window exists, so the launch is not awaited: the new window is moved to the hand as soon as it appears (Paint: 7.4 s down to 2.7 s) and spends a blink on your desktop. Windows are closed with `WM_CLOSE`, never by killing a process: `ApplicationFrameHost` hosts Calculator next to your Settings and Sticky Notes.
- **A stroke that changes nothing is an error.** The window is captured before and after a native stroke; if it is identical the model is told to draw in jspaint.app, instead of redrawing until its action budget is gone. Paint's catalog entry says the same up front.
- **Background input is the default.** Input Windows refuses in the background fails with a message telling the model to use the browser, another app or Bash. `PUK_WIN_BORROW=1` opts in to temporarily switching to the hand's desktop for real pointer input, then switching back.
- The model receives a Windows-specific environment description and a `platform` note with each window state, including whether its shell is PowerShell or WSL Bash.

The driver starts with `--grant existing-profile`, but normal hand browsers still use Puk's private profiles and persistent DevTools adapter. That capability grant does not automatically attach the panel to the user's signed-in Chrome profile. A separate, explicitly authorized existing-Chrome connection verified one playing YouTube Short while signed in. Next-video actions were not reliably verified, and the panel has no existing-account selection mode yet.

## Verification and limits

On this Windows 11 machine (build 26200), the earlier WSL checks verified:

- Paint launched into `Puk hand 1`, captured, a swatch clicked in the background, the window reclaimed after the shell moved it. Preview rendered live on the user's desktop without taking focus.
- Chrome in the hand: `ctrl+l` + address + enter, click Wikipedia's search field, type, enter, reached the Capybara article. One held five-point stroke drawn in jspaint.app, pixel-accurate. The user stayed on their desktop with the same focused window throughout.
- `bun win/serve.ts 2`: panel, `/status` and `/desktop.png` served. A typed task using the then-configured model and Jev gate discovered apps, opened Chrome, navigated, searched, and reached the article. The model policy has since changed to Luna, Gemini and Astra.
- F8, the native microphone, realtime transcription and the Jev listener ran end to end; speech that was not a request was classified `no_request`.

Later on 2026-09-19, native Windows Bun served and restarted two hands, the panel and screenshots. A private-profile Shorts task ran, and the separate authorized existing-Chrome check above verified signed-in playback. These do not prove that the panel now uses that account. Live availability calls succeeded for Luna, Vertex Gemini and Astra at low effort; they were single requests, not a three-model latency benchmark.

The compact native adapter remains subject to background UIA/input failures: its live Calculator read returned zero labelled controls. The [eval report](../docs/jev-evals.md) separates these input limitations from successful API evals. Voice with every new adapter, simultaneous live work on both hands, Edge, second-monitor behavior and other display scales still need targeted live checks.

The later native Paint cat task remained incomplete. Its Undo coordinate mismatch led to a small grounding diagnostic on a masked copy of the screenshot: Gemini returned coordinates resembling 0–1000 normalization even when asked for pixels. Explicit coordinate contracts and capture dimensions matter; the [grounding results](../docs/jev-evals.md#paint-coordinate-grounding-diagnostic) do not establish full-task drawing reliability.

Other limits:

- F8 is polled, not grabbed: the key still reaches the focused app, and anything else that uses F8 (a VM running the Omarchy build, a debugger) triggers capture too. Pick another key with `PUK_HOTKEY`.
- Native canvases (Paint) cannot be drawn on from the background. Web canvases can.
- Electron apps refuse background text like Chromium does and have no DevTools port here.
- `bun win/desktop.ts down` removes the hand desktops; Windows then moves their windows to a neighbouring desktop.
- The undocumented desktop interfaces change between Windows builds. `vendor/` holds the 24H2 file, which also works on 25H2 (26200). Other builds need the matching file from the same repository.
- A hand's browser is stopped and restarted on the first `open_app` of a run, so two identical windows never confuse the DevTools target.
- Sign-ins are per hand: two hands, two sign-ins. `sessions` recognises a dozen well-known sites by their session cookie's name (values are never read); a site it does not know may still be signed in. Google Messages pairs through page storage, which it cannot see.
- `login` from the command line while an older `serve.ts` without `/login` is running closes that hand's browser under it; a task sent to the hand meanwhile would take the profile back. Restart the server, or stop it first.
