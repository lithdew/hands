import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as windows from "../src/windows.ts";

// The real helper, built with the compiler that ships in Windows and asked only what changes nothing on screen: it
// compiles (C# 5), frames its replies, answers errors as errors, and leaves when its stdin closes. Opt in with
// HANDS_NATIVE_TESTS=1 on Windows; everywhere else the helper is a script (tests/windows.test.ts).

const run = process.platform === "win32" && process.env.HANDS_NATIVE_TESTS === "1";

describe.skipIf(!run)("the native helper", () => {
  let home: string;
  let saved: string | undefined;
  let exe: string;

  beforeAll(() => {
    saved = process.env.LOCALAPPDATA;
    // A build of its own, in one folder every run shares (the helper runs until this process ends, so the folder
    // cannot go with the test): another hand's exe is never replaced or removed, and each build removes the last.
    home = join(tmpdir(), "hands-test-helper");
    mkdirSync(home, { recursive: true });
    process.env.LOCALAPPDATA = home;
    exe = windows.helperPath();
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = saved;
  });

  test("it builds, and answers over its pipe", () => {
    expect(exe).toMatch(/hands-[0-9a-f]{12}\.exe$/);
    expect(windows.native.call("ping")).toEqual({ ok: true });
    expect(windows.displays().length).toBeGreaterThan(0);
  });

  test("its window list says what owns each window, whether it is minimized, and what process it is", () => {
    const list = windows.native.call("windows") as Record<string, unknown>[];
    for (const window of list) {
      expect(typeof window.owner).toBe("number");
      expect(typeof window.enabled).toBe("boolean");
      expect(typeof window.iconic).toBe("boolean");
      expect(typeof window.exe).toBe("string");
    }
  });

  test("it says how long the user has been idle, what they hold, and whether they may be disturbed", () => {
    const seat = windows.idle();
    expect(seat.idleMs).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(seat.held)).toBe(true);
    expect(typeof seat.quiet).toBe("boolean");
    expect(seat.tick).toBeGreaterThan(0);
  });

  test("an unknown command, and a window that is gone, are answers rather than a dead helper", () => {
    expect(() => windows.native.call("nonsense")).toThrow("unknown command nonsense");
    expect(windows.native.call("capture", { hwnd: 1, format: "jpeg", inline: true, restore: false })).toEqual({ gone: true });
    expect(windows.thumbnail(1, 320)).toBeNull();
    expect(windows.native.call("ping")).toEqual({ ok: true });
  });

  test("it leaves when its stdin closes", async () => {
    const proc = Bun.spawn([exe, "serve"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    await Bun.sleep(300);
    proc.stdin.end();
    const code = await Promise.race([proc.exited, Bun.sleep(5000).then(() => "still running")]);
    expect(code).toBe(0);
  });
});
