/**
 * The one place that knows there are two platforms. Everything else asks `platform` for the screen, the
 * accessibility tree and the input, and gets macos.ts or windows.ts.
 *
 * `Used` is every export another module calls, so the compiler holds windows.ts to the same signatures.
 * Under `bun test` it is the Mac unless HANDS_PLATFORM says otherwise: the tests fake macos.ts by name
 * (tests/helpers.ts), and that must mean the same thing on every machine that runs them.
 */

import * as mac from "./macos.ts";
import * as windows from "./windows.ts";

type Used =
  | "accessibilityTrusted" | "activate" | "actionableElements" | "appName" | "appWindows" | "axFocus" | "axPerform" | "axPress" | "axSetValue" | "axValue"
  | "browserLoading" | "browserTabs" | "browserUrl" | "captureAt" | "checkAbort" | "clearField" | "clickAt" | "displayFor" | "drag" | "focusedField"
  | "feed" | "frontmostApp" | "frontmostAppAndPid" | "frontmostWindowBounds" | "heldKey" | "interrupt" | "isWebContentApp" | "mainWindowId" | "menu" | "microphone" | "openBackgroundWindow"
  | "openUrl" | "pasteText" | "press" | "recognizeText" | "releaseElements" | "revealWindow" | "runInBackground" | "screenshot" | "screenshotWindow"
  | "scroll" | "scrollPage" | "sleepWatching" | "tabCommand" | "typeText" | "windowPointer"; // prettier-ignore

export type Platform = Pick<typeof mac, Used>;

/** Windows, from Windows itself or from WSL, where Windows programs start all the same. */
export function onWindows(env = process.env, os: string = process.platform): boolean {
  if (env.HANDS_PLATFORM) return env.HANDS_PLATFORM === "windows";
  if (env.NODE_ENV === "test") return false;
  return os === "win32" || (os === "linux" && Boolean(env.WSL_DISTRO_NAME));
}

export const platform: Platform = onWindows() ? windows : mac;

// The types the tools name through the namespace (`macos.PinnedWindow`), which a value alone does not carry.
export declare namespace platform {
  type NativeStream = mac.NativeStream;
  type PinnedWindow = mac.PinnedWindow;
  type PointerTarget = mac.PointerTarget;
  type TabCommand = mac.TabCommand;
}
