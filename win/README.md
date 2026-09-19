# win/: hands on Windows

Everything Windows lives in this folder. `ai.ts`, `hotkey.ts`, `desktop.ts`, `pip.ts` and `panel.html` are untouched: the Windows parts go in through the seams they already have (`createDesktopAgent({ desktop })` and `servePuk({ dependencies })`).

```sh
bun install
bun win/serve.ts 2        # two hands; open http://127.0.0.1:7777, or hold F8 and speak
```

Works from native Windows Bun and from WSL (Windows programs are started through interop). First run builds `out/win/puk-win-<hash>.exe` with the C# compiler that ships in Windows (named after its sources, because Windows locks a running `.exe`), so there is nothing else to install except [Cua Driver](https://cua.ai/docs/how-to-guides/driver/install) (tested with 0.28.2):

```powershell
irm https://cua.ai/driver/install.ps1 | iex
```

The installer registers a `cua-driver-serve` autostart task. Puk does not use it; it starts a private `cua-driver mcp` per hand. Remove the task from an elevated PowerShell with `cua-driver autostart disable`.

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

For a log worth reading afterwards: `PUK_DEBUG=1 bun win/serve.ts 2 2> out/win/serve.log`.

## Jev first, vision second

`ai.ts` asks a vision model for every step (list apps, open one, screenshot, act, screenshot), about two seconds a turn. On Windows `win/jev.ts` puts `jev/cua.ts` in front of it, with the same runtime shape, so `servePuk`, the listener and the panel are unchanged:

```text
request -> one Jev call: which app? only open it? does the speaker want an answer?   ~0.5 s warm
   native app    Jev opens it. "Only open it" ends here; more goes to the vision agent, which starts from the open app
   browser work  quickIntent (Jev) builds the intent, the hand's browser goes to its site, then per action:
                   observe.ts   the page's DOM as labelled elements, one DevTools call        ~0.1 s
                   decide       ONE Jev request: move, goal_met, stuck and every argument     ~0.4-0.5 s (1 s at 70+ elements)
                   gate         Jev again, kept apart so page text cannot talk it down        ~0.4 s
                   perform      click / type / key over DevTools                              ~0.05-0.1 s
   wants an answer   one vision call on one screenshot. Only NOT_VISIBLE, or Jev giving up, starts a full vision run
```

`jev/cua.ts` changed for this, all covered by its tests: `decide` fans every question out in one request instead of asking the arguments in a second round trip, the look taken after an action is reused as the next step's look, and `Deps` gained optional `perform`, `screenshot` and `settleMs` so another desktop can bring its own input. Omarchy behaviour is the default for all three.

Measured with `bun win/bench.ts` (2026-09-19, on battery, 1.4 GB RAM free, VPN): "go to youtube" 6.8 s, of which 5.6 s is the page loading and 0.4 s is Jev; "search wikipedia for capybaras" 22.8 s: one Jev action (0.9 s), 14 s of two page loads, 4.5 s for the vision model to write the answer. The same tasks took 37 to 79 s before.

**Native applications are Jev's too, through UI Automation** (`uia.cs`, `uia.ts`; 2026-09-19). It was once written off here: asked through its top-level handle, a window on another desktop shows its title bar and nothing else (Paint: 7 nodes). Its content's own child windows, the WinUI islands and the classic controls, still answer, so `uia.cs` reads each child window as a root and merges them: Paint 57 controls with every colour by name, Character Map 345, in one cached request of 5 to 450 ms. Actions are patterns (`Invoke`, `Select`, `Toggle`, `Expand`), which need no pointer and no focus. `bun win/native.eval.ts` (live, on its own desktop): "make red the main colour" in Paint and "put the word hello in the characters to copy box" in Character Map, each one plan, one look, one action, 3 Jev requests, about 3 s after the plan, confirmed from the application's own state, with the user's desktop and focus logged unchanged after every phase. Two things it cost to learn: `ValuePattern.SetValue` on a classic edit control takes the keyboard focus, which activates the hidden window, and Windows then follows it onto the hand's desktop (the user's screen flipped); an edit control with a window of its own is now sent `EM_SETSEL` and `EM_REPLACESEL` instead, and every native action notes the user's desktop and focus first and puts them back if they moved. **UWP applications stay closed**: Calculator, Settings and Clock are detached into a `CoreWindow` that serves one node while hidden; they remain the vision agent's, as does anything made by eye (a canvas ignores posted drags). Not yet tried: menus and dialogs that open as separate windows, Office, Electron apps, a native key press. `PUK_JEV_FIRST=0` turns this off and every task goes to the vision agent.

## Files

| File | Purpose |
| --- | --- |
| `serve.ts` | Entry point. Runs `servePuk` on a private port with Windows dependencies and fronts it, because `/desktop.png` and `/desktop/*` in `hotkey.ts` call `pip.ts` directly |
| `desktop.ts` | Hands as virtual desktops, app discovery and launch, window state, the Cua connection `ai.ts` expects, signing a hand's browser in, CLI (`up`, `list`, `down`, `login`, `sessions`) |
| `session.ts` | Pure: which page is a sign-in wall, which cookies mean a session, what the user is looking at |
| `browser.ts` | Background input for the hand's browser over DevTools |
| `observe.ts` | The hand's browser page as labelled elements for Jev |
| `jev.ts` | Jev-first runtime: Jev opens apps and drives the browser, the vision agent takes the rest |
| `bench.ts` | Time real tasks on a private desktop, next to a live server |
| `helper.cs` | Native helper: microphone PCM, held-key polling, window state, virtual desktops, previews, DevTools relay. C# 5 only |
| `vendor/VirtualDesktop11-24H2.cs` | MIT, Markus Scholtes. Wraps the undocumented shell COM interfaces for virtual desktops |

## What Windows allows, measured on build 26200

`ai.ts` speaks Cua's Linux surface: one desktop target, foreground delivery, `mouse_button_down` / `mouse_drag` / `mouse_button_up`. `connectCua` in `desktop.ts` turns that into calls against the hand's front window. What those calls can do while the window sits on another desktop decided the design:

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
- **Hands own window handles, not just a desktop.** The helper moves strays back on every state read and returns your focus if one took it. The front window is tracked explicitly (`frontWindow`): `open_app` sets it, a new dialog takes it, stacking order is ignored because switching desktops reshuffles it.
- **A hidden browser must be unpaced.** Windows presents no frames for a window on another desktop and Chrome paces a page by its frames: measured, a hidden page got 0 animation frames and 0 timer ticks a second, and YouTube took a minute to load. `--disable-gpu-vsync --disable-frame-rate-limit --disable-background-timer-throttling` give 43 and 99. `PUK_WIN_BROWSER_FLAGS` appends more.
- **Never read Chrome's files per call.** `DevToolsActivePort` takes 0.7 to 1.9 s to read from WSL; it is read once per browser launch. Each hand has its own helper process for DevTools, with a 2.5 s limit, so a page that stops answering cannot hold up window state or another hand. Navigation assigns `location` instead of `Page.navigate`, which only answers once the site has.
- **Capture is the helper's own** (`PrintWindow`, about 100 ms, works on another desktop). Cua's takes 0.5 to 2.5 s and queues behind the 5 s it settles after a launch; it is the fallback for a window that will not draw.
- **Each hand's browser is started at startup** (`PUK_WIN_PREWARM=0` to skip), so `open_app` for any browser is a 20 ms raise. The app list sent to the model is ids and names only (8 KB instead of 37 KB); launches are one at a time, because a new window is recognised by being new on the user's desktop.
- **Spin-up is kept short.** The Start menu listing costs PowerShell about 3 s, so it is cached for five minutes and warmed at startup with each hand's driver. Cua's `launch_app` returns about 5 s after the window exists, so the launch is not awaited: the new window is moved to the hand as soon as it appears (Paint: 7.4 s down to 2.7 s) and spends a blink on your desktop. Windows are closed with `WM_CLOSE`, never by killing a process: `ApplicationFrameHost` hosts Calculator next to your Settings and Sticky Notes.
- **A stroke that changes nothing is an error.** The window is captured before and after a native stroke; if it is identical the model is told to draw in jspaint.app, instead of redrawing until its action budget is gone. Paint's catalog entry says the same up front.
- **Nothing takes your screen.** Input Windows refuses in the background fails with a message telling the model to use the browser, another app or Bash. `PUK_WIN_BORROW=1` opts in to the old behaviour: switch to the hand's desktop, deliver real input, switch back.
- The model is told all this in the `platform` note that rides along with every window state, since the system prompt in `ai.ts` describes nested Sway.

The driver starts with `--grant existing-profile` so Cua may attach to a browser it did not launch. Nothing in this folder calls Cua's `browser_*` tools any more; drop the flag if that stays true.

## Verified on the real machine (2026-09-19, from WSL)

- Paint launched into `Puk hand 1`, captured, a swatch clicked in the background, the window reclaimed after the shell moved it. Preview rendered live on the user's desktop without taking focus.
- Chrome in the hand: `ctrl+l` + address + enter, click Wikipedia's search field, type, enter, reached the Capybara article. One held five-point stroke drawn in jspaint.app, pixel-accurate. The user stayed on their desktop with the same focused window throughout.
- `bun win/serve.ts 2`: panel, `/status` and `/desktop.png` served. A typed task ran through unmodified `ai.ts` with Sonnet 5 and the Jev gate (4 checks, all allowed): discovered 222 apps, opened Chrome, navigated with a 3-step batch, searched, reached the article.
- F8, the native microphone, realtime transcription and the Jev listener ran end to end; speech that was not a request was classified `no_request`.

Not verified: two hands working at once, approvals from the panel on Windows, native Windows Bun (only WSL was used), Edge, a second monitor, display scaling other than this machine's.

## Handoff (2026-09-19)

On `desktop-pip`, on top of `33d39ef`. Outside `win/` it touches only `jev/cua.ts` and its test (the fan-out `decide`, the reused look, three optional `Deps`).

State: everything under "Verified" below ran on a real Windows 11 machine from WSL. After the last round of changes (Jev-first runtime, unpaced browser, native capture) the pieces were measured with `bun win/bench.ts`, but **`bun win/serve.ts` was not re-run end to end with voice**; do that first.

Open, in the order I would take them:

1. **Voice + Jev-first together.** `refine` rebuilds the intent while the speaker talks and `runIntent` holds typing until speech ends; exercised by types and the Omarchy tests, not yet by a real utterance on Windows.
2. **One sentence became two tasks.** "Could you open Paint" arrived from the transcriber as `"Could you open Pay? Paint"` and the listener's cut split it across two hands. That is calibration in `jev/listen.ts`, shared with Omarchy, left unchanged.
3. **Approvals from Jev** reach the panel as `tool: "jev"` with the action text. Seen pausing correctly (`click "Minimize"`, `off_goal 0.89`); approving one from the panel is untested.
4. **UWP applications and anything made by eye** go to the vision agent. Other native windows are read and operated through UI Automation (`uia.ts`); see above for what that was measured on.
5. **Two hands at once** is untested. Launches are serialized; everything else is per hand.
6. Page loads were slow on the test machine (battery, 1.4 GB free RAM, VPN). Opting the hand's browser out of Windows power throttling (`SetProcessInformation`, `ProcessPowerThrottling`) was sketched and deliberately not done: Jev's own speed was the goal.
7. `jev/listen.test.ts` has one test that fails on `/mnt/c` (it waits a fixed time for a lazy import on a slow filesystem). It passes on the Omarchy machine and is unrelated to this branch.

Machine notes: the Cua installer registers a `cua-driver-serve` autostart task that Puk does not use; removing it needs an elevated shell. Anything else on the machine that uses F8 (the Omarchy VM) triggers capture here too, so set `PUK_HOTKEY`.

## Known limits

- F8 is polled, not grabbed: the key still reaches the focused app, and anything else that uses F8 (a VM running the Omarchy build, a debugger) triggers capture too. Pick another key with `PUK_HOTKEY`.
- Native canvases (Paint) cannot be drawn on from the background. Web canvases can.
- Electron apps refuse background text like Chromium does and have no DevTools port here.
- `bun win/desktop.ts down` removes the hand desktops; Windows then moves their windows to a neighbouring desktop.
- The undocumented desktop interfaces change between Windows builds. `vendor/` holds the 24H2 file, which also works on 25H2 (26200). Other builds need the matching file from the same repository.
- A hand's browser is stopped and restarted on the first `open_app` of a run, so two identical windows never confuse the DevTools target.
- Sign-ins are per hand: two hands, two sign-ins. `sessions` recognises a dozen well-known sites by their session cookie's name (values are never read); a site it does not know may still be signed in. Google Messages pairs through page storage, which it cannot see.
- `login` from the command line while an older `serve.ts` without `/login` is running closes that hand's browser under it; a task sent to the hand meanwhile would take the profile back. Restart the server, or stop it first.
