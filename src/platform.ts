/**
 * The one place that knows there are two platforms. Everything else asks `platform` for the screen, the
 * accessibility tree and the input, and gets macos.ts or windows.ts.
 *
 * `Used` is every export another module calls, so the compiler holds windows.ts to the same signatures.
 * Under `bun test` it is the Mac unless HANDS_PLATFORM says otherwise: the tests fake macos.ts by name
 * (tests/helpers.ts), and that must mean the same thing on every machine that runs them.
 */

import { join } from "node:path";
import * as mac from "./macos.ts";
import { start as macShell } from "./shell.ts";
import { start as windowsShell } from "./shell-windows.ts";
import * as windows from "./windows.ts";

type Used =
  | "accessibilityTrusted" | "activate" | "actionableElements" | "appName" | "appWindows" | "axFocus" | "axPerform" | "axPress" | "axSetValue" | "axValue"
  | "browserLoading" | "browserTabs" | "browserUrl" | "captureAt" | "checkAbort" | "clearField" | "clickAt" | "displayFor" | "displays" | "drag" | "focusedField"
  | "frontmostApp" | "frontmostAppAndPid" | "frontmostWindowBounds" | "interrupt" | "isWebContentApp" | "mainWindowId" | "menu" | "openBackgroundWindow"
  | "openUrl" | "pasteText" | "press" | "recognizeText" | "releaseElements" | "revealWindow" | "runInBackground" | "screenshot" | "screenshotWindow"
  | "scroll" | "scrollPage" | "sleepWatching" | "stageWindow" | "tabCommand" | "typeText" | "windowPointer"; // prettier-ignore

export type Platform = Pick<typeof mac, Used>;

/** Why `accessibilityTrusted()` said no: on the Mac a permission, on Windows the helper the port is built on. */
export const PERMISSION = onWindows()
  ? "the native helper could not be built or started (see src/windows.ts); the agent cannot see or touch the screen without it"
  : "this terminal lacks Accessibility permission; grant it in System Settings > Privacy & Security";

/** HANDS_PLATFORM decides when set; a test is the Mac wherever it runs; otherwise the OS itself. */
export function onWindows(env: NodeJS.ProcessEnv = process.env, os: string = process.platform): boolean {
  if (env.HANDS_PLATFORM) return env.HANDS_PLATFORM === "windows";
  if (env.NODE_ENV === "test") return false;
  return os === "win32";
}

export const platform: Platform = onWindows() ? windows : mac;

// The types the tools name through the namespace (`macos.PinnedWindow`), which a value alone does not carry.
export declare namespace platform {
  type Display = mac.Display;
  type PinnedWindow = mac.PinnedWindow;
  type PointerTarget = mac.PointerTarget;
  type Tab = mac.Tab;
  type TabCommand = mac.TabCommand;
}

/** The panel, microphone and talk key of `hands live`. */
export const startShell = onWindows() ? windowsShell : macShell;

/** The process that draws the hand. On the Mac hand.ts is its own renderer; the path is built here so hand.ts need not import itself. */
export function rendererCommand(): string[] {
  return onWindows() ? windows.rendererCommand() : [process.execPath, join(import.meta.dir, "hand.ts")];
}
