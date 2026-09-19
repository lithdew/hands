# Puk

A voice-driven agent working in a real nested desktop, with a clickable picture-in-picture preview. Built for Omarchy / Hyprland; Jev coordinates live speech, Pi runs the selected model, and Cua MCP provides computer input and screenshots. Workers also have Bash.

## Run

Install the desktop prerequisites in [Omarchy setup](docs/omarchy-setup.md), then:

```sh
bun install
bun desktop.ts up 2 --terminal
bun start
```

Open **http://127.0.0.1:7777** to type a task, hold the speech button, select a provider, watch the desktop, stop work, or review a proposed action. `PUK_HAND` selects the initial desktop (default `1`); independent voice tasks use other available hands; `PUK_PORT` defaults to `7777`.

Run `bun pip.ts bindings` and add its output to `~/.config/hypr/bindings.lua` after checking for conflicting bindings. Preview movement uses Omarchy's existing mouse shortcuts:

| Control | Action |
| --- | --- |
| Click a corner preview | Enter that desktop; the click is consumed |
| Super + left-drag on a corner preview | Move that preview |
| Super + right-drag on a corner preview | Resize that preview |
| Ctrl+Alt+1 / 2 / 3 | Enter that hand, or return if already inside |
| Ctrl+Alt+0 / the desktop bar's **‹ Desktop** | Restore the preview and previous app |
| Ctrl+Alt+P / **Reset previews** | Restore all previews to their default size and position |
| Hold F8, then release | Start work while speaking; release finalizes the instruction |
| Ctrl+Alt+Escape / **Stop** | Cancel capture and active agent work |

Super is the Windows key. Each preview keeps its adjusted position and size when you enter and return, and when `desktop up` reuses existing hands. New hands use free preview slots. Use **Reset previews** or `bun pip.ts layout` to arrange them again.

A preview shows the hand's whole desktop scaled down. The nested bar adjusts the output scale to preserve the logical desktop width (1280 by default); changing the window's aspect ratio can still change its logical height. Previews appear while a hand is working or awaiting review, with an accent-to-green or amber border. Finishing, stopping or failing hides the preview while keeping its apps open. You can still use **Open desktop** or the keyboard shortcuts to inspect an idle hand; a desktop you opened stays visible until you return. The panel retains its last captured frame while the hand is hidden.

The nested desktop has app tabs and a small themed bar with the same status chip and buttons for opening a terminal, browser, or notes app. The agent discovers the full installed app catalog itself; these buttons do not limit its choices. `bun desktop.ts down` closes the hands. Stopping the agent leaves its opened apps available.

## Keys and providers

Bun loads `.env` automatically; keep keys there. `.env.example` lists canonical names. Existing short aliases are supported:

| Purpose | Key names | Default model |
| --- | --- | --- |
| OpenAI agent and speech | `OPENAI_API_KEY` or `OAI` | `gpt-5.6-luna`; speech: `gpt-live-transcribe` |
| Anthropic agent | `ANTHROPIC_API_KEY` or `ANT` | `claude-sonnet-5` |
| Gemini agent | `GOOGLE_CLOUD_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, or `GEMINI` | `gemini-3.8-flash` |
| Jev routing, decisions and action checks | `TYPESAFE_API_KEY`, `JEV_API_KEY`, `JEV`, or `jev_key` | `jev-latest` |

`PUK_PROVIDER=auto` is the default. Jev chooses a configured model and reasoning effort when each task starts, and checks again between model turns when speech refines it. Selecting OpenAI, Anthropic or Gemini in the panel confines routing to that provider. The panel shows the model, effort, and routing time. A timeout, malformed answer, or uncertain difficulty uses a known standard profile; the action gate still runs normally.

Auto offers three distinct profiles: **Luna / low** for routine work, **Sonnet 5 / medium** for standard work, and **Astra / high** for complex work. It uses available configured providers if a preferred provider is missing. Explicit provider selection stays on that provider: OpenAI uses Luna plus Astra for complex work, Anthropic uses Sonnet 5, and Gemini uses Gemini 3.8 Flash. Jev chooses **low, medium or high** effort; low is always the minimum. Sonnet uses adaptive thinking.

`OPENAI_MODEL`, `ANTHROPIC_MODEL`, or `GEMINI_MODEL` pins a model while Jev still selects effort. Optional `*_COMPLEX_MODEL` changes the complex profile. Explicit overrides must exist in Pi's catalog. An unavailable optional default complex model falls back to that provider's configured model. Actual API access still depends on the key.

For a Vertex key, set **`GEMINI_BACKEND=vertex`**. `GOOGLE_CLOUD_API_KEY` selects Vertex automatically; keys under the other aliases need the explicit setting. AI Studio keys use `GEMINI_BACKEND=ai-studio`. Vertex Express mode API keys do not require a project/location here. Gemini 3.8 uses at least low thinking because Vertex rejects the SDK's implicit minimal setting.

Voice always uses OpenAI transcription, independently of the agent provider. Typed tasks can use any configured provider. `TRANSCRIBE_MODEL` and `JEV_MODEL` are also configurable.

## Behavior

```text
F8 / microphone → live transcript → Jev task coordinator
                                    ├─ Pi worker → Cua MCP + Bash
                                    ├─ Pi worker → another desktop
                                    └─ waiting tasks → next free desktop
```

- Realtime deltas feed Chi's `jev/listen.ts` immediately. Jev identifies startable requests, independent task boundaries, refinements, repetitions and cancellations. A new task starts on a free hand while speech continues. Related steps update that same worker; extra independent tasks queue. Even several requests arriving in one transcript delta can be split by Jev.
- Workers remain attached until speech finishes so corrections can reach them. Rewritten final transcripts cancel superseded work. Stop cancels capture, classification, queued tasks and every active worker. Apps already opened remain available.
- The panel shows tasks and desktop selectors. Select a worker to watch it, click its preview to enter, and review pending actions from any worker. Starting a worker does not disable the speech button while it is held.
- Pi has `apps`, `open_app`, `computer`, `bash`, and `jev` tools. It discovers apps itself, plans GUI/file work, and can batch independent text decisions through Jev. `computer` uses a private Cua MCP process pointed at that hand's Sway socket. Requests to show something must display it in the desktop and inspect the result.
- For freehand drawing, the model plans up to eight strokes at once, with at most 32 points per stroke. Jev checks that exact plan, and Cua holds the left mouse button while following each path. A separate `computer batch` can group up to eight known palette, fill or form actions on the same observed screen. The complete batch is validated and checked once, with a screenshot afterward. Cancellation, instruction changes, focus changes and resizing stop remaining steps; held strokes always release the mouse button. Prefer preset colours when an exact shade is unnecessary.
- Jev is text-only: it returns bounded choices and probabilities, not pixels, coordinates or free-form plans. It coordinates speech, selects model/effort and checks exact proposed actions. Independent questions share one call. The model handles vision, writing, tool arguments and recovery.
- While speech is unfinished, the risk threshold is stricter. A flagged action waits for the completed instruction and is checked again; consequential steps require approval of those exact arguments. A correction expires a stale proposal or approval. Failed checks block execution. Screenshots go to the selected model; Jev gets window metadata, exact arguments and the current instruction.
- Bash shares your files and permissions. Desktop input is separated; the filesystem is not sandboxed. `.env` key aliases and exported credentials are removed from subprocess environments and redacted from outputs. Commands have bounded output, process-group cancellation and timeouts, including when a child keeps a pipe open.
- Runs have a five-minute limit, 30 action calls and 120 total tool calls. Screenshots, app discovery and Jev queries do not consume the action budget. Conversation history stays in memory; switching provider or restarting clears it.
- The HTTP panel trusts processes running as your local user. Host, Origin and Fetch Metadata checks reject ordinary cross-site browser requests; there is no local-process authentication token. `PUK_DEBUG=1` enables bounded, redacted diagnostics.

## Code and checks

The app integration stays in `desktop.ts` (desktop/app tools), `pip.ts` (Hyprland navigation and preview styling), `ai.ts` (Pi/providers/tools), `hotkey.ts` (speech/server), and `panel.html` (the control page). It reuses the merged `jev/listen.ts` task coordinator and `jev/jev.ts` SDK transport. Both the listener and Pi's Jev tools share credentials, timeouts and response validation. Pi starts planning each accepted live task directly, without a second intent-generation LLM. The old app-only warm-up controller is kept only as an eval baseline in `evals.ts`. Standalone Jev planners are loaded lazily and are not pulled into the panel's worker loop. Zod defines the app's tool, HTTP, Jev response and routing schemas; Pi receives JSON Schema generated from the same tool definitions.

Chi's standalone Jev/AT-SPI desktop loop remains available under [`jev/`](jev/README.md). The panel uses Pi for Bash, vision, approvals and all three providers. `jev/cua.ts` is a native desktop experiment, not the external CUA SDK.

```sh
bun test
bun run check
bun run eval --live --rounds=3 --suite=all
```

`evals.ts` keeps synthetic fixtures and the live API harness together. App/shell execution is mocked; runs write model profiles, redacted traces, error-inclusive latency/accuracy, and estimated LLM token cost under ignored `out/evals/`. Suites can be run separately with `--suite=decisions|routing|workflow|streaming|listener|batch`, optionally filtered by `--strategy=NAME`. The listener suite uses the production coordinator with real Jev and mocked Pi execution. These paid API evals measure the configured providers on this connection; they are not latency guarantees or a security certification.

See [handoff](docs/handoff.md) for live verification, limitations, and next steps. Cua Driver MCP is integrated on nested Sway. macOS/Windows desktop backends remain future work. Preview buffers remain tile-sized; Cua capture/input alignment at fractional output scales still needs verification.
