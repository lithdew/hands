#!/usr/bin/env bun
/** Command-line entry points: `clicker` and `clicker inspect`. */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import * as config from "./config.ts";
import * as macos from "./macos.ts";
import { repr } from "./models.ts";
import { capture, perceive } from "./perception.ts";
import { annotate, axCount, renderPayload } from "./report.ts";
import { run } from "./runner.ts";
import { formatTiming, type Timing } from "./timing.ts";
import { makeWriter } from "./writer.ts";

const pad = (n: number) => String(n).padStart(2, "0");
/** A folder name that sorts by time: 20260920-004100. */
export function timestamp(now = new Date()): string {
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const USAGE = `usage: clicker <goal> [--act] [--steps N] [--min-confidence P] [--delay S] [--out DIR] [--image PNG --app NAME --url URL]
       clicker inspect [goal] [--countdown N] [--no-open] [--out DIR]

Drive this computer toward a goal: screen OCR, a TypeSafe classifier, deterministic actions.

  --act              actually click and type (default: dry run, one step)
  --steps            max actions before stopping (default ${config.DEFAULT_STEPS})
  --min-confidence   stop below this confidence (default ${config.DEFAULT_MIN_CONFIDENCE})
  --delay            seconds to wait after each action (default ${config.DEFAULT_DELAY})
  --out              run folder (default runs/<timestamp>)
  --image            replay a saved capture instead of the live screen (never acts)
  --app, --url       frontmost app and browser URL to report during replay`;

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      act: { type: "boolean", default: false },
      steps: { type: "string", default: String(config.DEFAULT_STEPS) },
      "min-confidence": { type: "string", default: String(config.DEFAULT_MIN_CONFIDENCE) },
      delay: { type: "string", default: String(config.DEFAULT_DELAY) },
      out: { type: "string", default: join("runs", timestamp()) },
      image: { type: "string" },
      app: { type: "string" },
      url: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const goal = positionals.join(" ");
  if (values.help || !goal) return void console.log(USAGE);
  if (!process.env.TYPESAFE_API_KEY) fail("TYPESAFE_API_KEY is not set (export it or put it in .env)");
  if (values.act && !macos.accessibilityTrusted()) fail("this terminal lacks Accessibility permission; grant it in System Settings > Privacy & Security");
  const writer = await makeWriter();
  if (!writer) console.log("writer disabled: no credentials for the writer model; type_text, writer-proposed URLs and the final answer need it");

  const state = await run(
    {
      goal,
      out: values.out,
      act: values.act,
      steps: Number(values.steps),
      minConfidence: Number(values["min-confidence"]),
      delay: Number(values.delay),
      image: values.image,
      app: values.app,
      url: values.url,
    },
    (typesafe, history) => ({ goal, browser: config.browser(), email: config.email(), typesafe, writer, history }),
  );
  if (state.outcome.startsWith("aborted")) process.exit(130);
}

/** Count down, capture the screen, and show exactly what the clicker would send to TypeSafe. */
async function inspect(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      countdown: { type: "string", default: "3" },
      "no-open": { type: "boolean", default: false },
      out: { type: "string", default: join("inspections", timestamp()) },
    },
  });
  const goal = positionals.join(" ") || "(no goal given)";
  mkdirSync(values.out, { recursive: true });

  for (let n = Number(values.countdown); n > 0; n--) {
    process.stdout.write(`${n}... `);
    await Bun.sleep(1000);
  }
  console.log("capture");

  const browser = config.browser();
  const timing: Timing = {};
  const screen = await capture({ out: join(values.out, "raw.png"), browser, timing });
  const items = await perceive(screen, config.MAX_OPTIONS, goal, timing);
  const [annotated, state] = [join(values.out, "annotated.png"), join(values.out, "state.txt")];
  await annotate(screen, items, "", annotated);
  await Bun.write(state, renderPayload(goal, screen, items, [], browser, config.email()));

  console.log(
    `app=${repr(screen.app)} url=${screen.url === null ? "None" : repr(screen.url)} items=${items.length} ax=${axCount(items)} ` +
      `offscreen=${screen.offscreen.length} field=${screen.field?.role ?? "None"}`,
  );
  console.log(formatTiming(timing));
  console.log(`  ${annotated}\n  ${state}`);
  if (!values["no-open"]) {
    Bun.spawn(["open", annotated]);
    Bun.spawn(["open", "-t", state]);
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  await (argv[0] === "inspect" ? inspect(argv.slice(1)) : main(argv));
}
