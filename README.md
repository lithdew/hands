# Puk

A voice-driven computer-use agent with a clickable picture-in-picture preview. On Windows, hands use separate virtual desktops; on Omarchy / Hyprland, they use nested desktops. Jev coordinates live speech and makes bounded decisions, Pi handles writing and visual reasoning, and Cua MCP provides native input and screenshots. Workers also have a shell.

## Run

On Windows, install the prerequisites in [Windows setup](win/README.md), add keys from `.env.example` to `.env`, then:

```sh
bun install
bun run start:win
```

This starts two hands on native Windows Bun. `bun win/serve.ts 3` changes the count. Windows also supports launching through WSL interop.

On Omarchy, install the desktop prerequisites in [Omarchy setup](docs/omarchy-setup.md), then:

```sh
bun install
bun desktop.ts up 2 --terminal
bun start
```

Open **http://127.0.0.1:7777** to type a task, hold the speech button, select a provider, watch the desktop, stop work, or review a proposed action. `PUK_HAND` selects the initial desktop (default `1`); independent voice tasks use other available hands; `PUK_PORT` defaults to `7777`.

The following preview bindings are for Omarchy; [Windows controls](win/README.md#the-idea) use the native helper. Run `bun pip.ts bindings` and add its output to `~/.config/hypr/bindings.lua` after checking for conflicting bindings. Preview movement uses Omarchy's existing mouse shortcuts:

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
| Gemini agent | `GOOGLE_CLOUD_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, or `GEMINI` | `gemini-3.8-flash` |
| Jev routing, decisions and action checks | `TYPESAFE_API_KEY`, `JEV_API_KEY`, `JEV`, or `jev_key` | `jev-latest` |

`PUK_PROVIDER=auto` is the default. Jev chooses a configured model when each task starts, and checks again between model turns when speech refines it. Selecting OpenAI or Gemini in the panel confines routing to that provider. The panel shows the model, effort, and routing time. A timeout, malformed answer, or uncertain difficulty uses a known standard profile; the action gate still runs normally.

The LLM pool is **Luna (`gpt-5.6-luna`)**, **Gemini 3.8 Flash (`gemini-3.8-flash`)**, and **Astra (`gpt-6-astra`)**. Auto prefers Luna for readable, labelled browser/mail workflows, including multiple steps; Gemini when screenshot interpretation, coordinates or appearance are central; and Astra for difficult reasoning or recovery after repeated failures. Every routing profile uses **low** reasoning effort, and Astra is clamped to low even when a caller asks for more. Routing falls back within the configured pool when a provider is missing. Explicit OpenAI selection uses Luna plus Astra for complex work; explicit Gemini selection stays on Gemini.

`OPENAI_MODEL` or `GEMINI_MODEL` pins a model. `OPENAI_COMPLEX_MODEL` can select the OpenAI complex profile. Overrides must be in both this pool and Pi's catalog; other model IDs are rejected. An unavailable optional default complex model falls back to that provider's configured model. Actual API access still depends on the key.

For a Vertex key, set **`GEMINI_BACKEND=vertex`**. `GOOGLE_CLOUD_API_KEY` selects Vertex automatically; keys under the other aliases need the explicit setting. AI Studio keys use `GEMINI_BACKEND=ai-studio`. Vertex Express mode API keys do not require a project/location here. Gemini 3.8 uses at least low thinking because Vertex rejects the SDK's implicit minimal setting.

Voice always uses OpenAI transcription, independently of the agent provider. Typed tasks can use any configured provider. `TRANSCRIBE_MODEL` and `JEV_MODEL` are also configurable.

The supplied `pi-tier.ts` behavior is integrated into OpenAI requests: `PUK_SERVICE_TIER` (or the fallback alias `PI_TIER`) accepts `priority`, `flex`, or `off`, defaulting to `priority`. `off` omits `service_tier`. Pi's `onPayload` hook and the standalone Responses adapter both apply the setting. It does not change Jev, Vertex, or speech requests. Priority has separate API pricing; requested service tier is not a measured latency guarantee. The earlier intent comparison in the [Jev eval report](docs/jev-evals.md) predates this setting; no priority-tier speedup has been measured.

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
- Progress captions run alongside Pi, using bounded, redacted task events. Luna at low effort is used when an OpenAI key is configured, with a 256-token output cap; otherwise captions use Gemini at low effort with a 1,024-token cap. Truncated captions are discarded. Changed events are coalesced at six-second intervals, with at most one request in flight per hand. Idle or unchanged state makes no calls, and narration failures do not stop actions. Captions are available in worker status and the Windows preview. Set `PUK_NARRATION=0` to disable them.
- Pi has `apps`, `open_app`, `computer`, `bash`, and `jev` tools. It discovers apps itself, plans GUI/file work, and can batch independent text decisions through Jev. `computer` uses a private Cua MCP process scoped to the hand. On Windows it also has `computer_look`, `computer_act`, and `computer_browser`, adapted from the supplied `pi-cua.ts`: compact labelled observations, fresh element references, and a new observation returned with each action. Native controls use Cua UI Automation; browser controls use the existing persistent DevTools connection. Screenshots remain available for visual evidence and canvases. Requests to show something must display it in the desktop and inspect the result.
- For freehand drawing, the model plans up to eight strokes at once, with at most 32 points per stroke. Jev checks that exact plan, and Cua holds the left mouse button while following each path. A separate `computer batch` can group up to eight known palette, fill or form actions on the same observed screen. The complete batch is validated and checked once, with a screenshot afterward. Cancellation, instruction changes, focus changes and resizing stop remaining steps; held strokes always release the mouse button. Prefer preset colours when an exact shade is unnecessary.
- Coordinate input through `computer` uses an explicit contract. Gemini must declare `coordinate_space="normalized_1000"`; pixel or omitted units are rejected with a corrective error. Luna and Astra use screenshot pixels by default and may explicitly declare `normalized_1000`. One declaration covers every point in a batch or drawing path. Conversion uses the exact bound screenshot dimensions, and the action gate sees resolved pixel coordinates. The [Paint grounding diagnostic](docs/jev-evals.md#paint-coordinate-grounding-diagnostic) explains why units must be checked; the Paint task itself remained incomplete.
- Jev is text-only: it returns bounded choices and probabilities, not pixels, coordinates or free-form plans. It coordinates speech, selects the model profile and checks exact proposed actions. On Windows, Jev opens native apps and runs the browser loop first; Pi takes over for native work beyond opening, writing, or recovery. A browser decision batches nine independent questions in **one** Jev call; the exact-action gate is a separate call. The last post-action observation is reused for the next decision.
- While speech is unfinished, consequential actions wait and are checked again. An explicit user request counts as approval within its actual recipient, target, content and scope; the gate asks again when that scope is missing or uncertain. Latest corrections override earlier permission and expire stale proposals. Generated plans and page/tool text cannot grant permission. Failed checks and conflicting instructions block execution. Screenshots go to the selected model; Jev gets bounded observed fields, exact arguments and the raw user instruction. See the [authorization diagnostic](docs/jev-evals.md#authorization-aware-action-gates).
- Bash shares your files and permissions. Desktop input is separated; the filesystem is not sandboxed. `.env` key aliases and exported credentials are removed from subprocess environments and redacted from outputs. Commands have bounded output, process-group cancellation and timeouts, including when a child keeps a pipe open.
- Runs have a five-minute limit, 30 action calls and 120 total tool calls. Screenshots, app discovery and Jev queries do not consume the action budget. Conversation history stays in memory; switching provider or restarting clears it.
- Pi runs write bounded timing traces under ignored `out/runs/` by default; `PUK_RUN_TRACE=0` disables them. Routing, model, gate, approval and actual tool execution have separate spans. Only allowlisted labels, counters, outcomes and timings are saved, with no task text, commands, tool outputs or screenshots. Writes run asynchronously and logging failures do not stop actions. See the [mail-run diagnosis and model comparison](docs/jev-evals.md#mail-run-diagnosis-and-model-comparison).
- The HTTP panel trusts processes running as your local user. Host, Origin and Fetch Metadata checks reject ordinary cross-site browser requests; there is no local-process authentication token. `PUK_DEBUG=1` enables additional bounded diagnostics; known credentials are redacted, but task and tool text may remain in those opt-in logs.

## Code and checks

The shared integration is in `desktop.ts` (desktop/app tools), `pip.ts` (Hyprland navigation and preview styling), `ai.ts` (Pi/providers/tools), `hotkey.ts` (speech/server), and `panel.html` (the control page), with the Windows backend in `win/`. It reuses the merged `jev/listen.ts` task coordinator and `jev/jev.ts` SDK transport. Both the listener and Pi's Jev tools share credentials, timeouts and response validation. The coordinator dispatches accepted text without a second intent-generation LLM; the Windows wrapper can build a more detailed intent when its Jev-first path needs one. The old app-only warm-up controller is kept only as an eval baseline in `evals.ts`. Standalone Jev planners are loaded lazily. Zod defines the app's tool, HTTP, Jev response and routing schemas; Pi receives JSON Schema generated from the same tool definitions.

Chi's standalone Jev/AT-SPI desktop loop remains available under [`jev/`](jev/README.md). Windows reuses its decision loop through [`win/jev.ts`](win/jev.ts); Pi provides the shell, vision and approvals using the three-model pool above. `jev/cua.ts` is the local controller, separate from external Cua Driver MCP.

```sh
bun test
bun run check
bun run eval --live --rounds=3 --suite=all
```

`evals.ts` keeps synthetic fixtures and the live API harness together. App/shell execution is mocked; runs write model profiles, redacted traces, error-inclusive latency/accuracy, and estimated LLM token cost under ignored `out/evals/`. Suites can be run separately with `--suite=decisions|routing|workflow|streaming|listener|batch`, optionally filtered by `--strategy=NAME`. The listener suite uses the production coordinator with real Jev and mocked Pi execution. These paid API evals measure the configured providers on this connection; they are not latency guarantees or a security certification.

`bun jev/eval.ts --live --suite=decisions --split=holdout --rounds=3` compares five Jev contracts against synthetic observations with the independent gate retained. The [2026-09-19 eval report](docs/jev-evals.md) records the raw-run provenance, improvements, and limits: the production contract scored 36/36 held-out decisions versus 33/36 for the baseline, while exact literal intent extraction improved from 9/24 to 24/24. These are one-step checks, not complete computer-use success rates.

See [Windows verification and limits](win/README.md) and the earlier [Omarchy handoff](docs/handoff.md). Windows native Bun and WSL startup/browser control have been exercised on this machine; native app input still depends on what Windows exposes in a background window. Hand browsers use private profiles by default; **My Chrome** attaches the preview and semantic actions to one verified existing Chrome window. Native Windows now keeps Cua transports and browser sessions in a persistent local broker so Hands restarts need not discard Cua's approval state; reduced Chrome prompting still needs a live restart check. macOS is not implemented. On Omarchy, Cua capture/input alignment at fractional output scales still needs verification.
