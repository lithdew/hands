import { describe, expect, test } from "bun:test";
import {
  click,
  keyComboToWtypeArgs,
  moveMouse,
  pressKey,
  screenshot,
  scroll,
  swayConfig,
  typeText,
  type Exec,
  type Hand,
} from "./desktop";

const hand: Hand = { id: 1, pid: 4242, display: "wayland-7", width: 1280, height: 800 };

/** Records every command and returns a canned result. */
function fakeExec(stdout = "") {
  const calls: { argv: string[]; env?: Record<string, string> }[] = [];
  const exec: Exec = async (argv, opts) => {
    calls.push({ argv, env: opts?.env });
    return { exitCode: 0, stdout: new TextEncoder().encode(stdout), stderr: "" };
  };
  return { exec, calls };
}

describe("swayConfig", () => {
  test("sets the output size and reports the socket name", () => {
    const conf = swayConfig({ width: 1024, height: 768, displayFile: "/run/user/1000/hands/hand-1.display" });
    expect(conf).toContain("output * mode 1024x768");
    expect(conf).toContain(`echo "$WAYLAND_DISPLAY" > '/run/user/1000/hands/hand-1.display'`);
  });
});

describe("screenshot", () => {
  test("calls grim against the hand's socket", async () => {
    const { exec, calls } = fakeExec("PNG");
    const png = await screenshot(hand, {}, exec);
    expect(new TextDecoder().decode(png)).toBe("PNG");
    expect(calls[0]!.argv).toEqual(["grim", "-t", "png", "-"]);
    expect(calls[0]!.env).toEqual({ WAYLAND_DISPLAY: "wayland-7" });
  });

  test("passes scale through", async () => {
    const { exec, calls } = fakeExec();
    await screenshot(hand, { scale: 0.5 }, exec);
    expect(calls[0]!.argv).toEqual(["grim", "-s", "0.5", "-t", "png", "-"]);
  });
});

describe("pointer", () => {
  test("moveMouse slams to the corner then moves by the target", async () => {
    const { exec, calls } = fakeExec();
    await moveMouse(hand, 400.4, 299.6, exec);
    expect(calls.map((c) => c.argv)).toEqual([
      ["wlrctl", "pointer", "move", "-100000", "-100000"],
      ["wlrctl", "pointer", "move", "400", "300"],
    ]);
    for (const c of calls) expect(c.env).toEqual({ WAYLAND_DISPLAY: "wayland-7" });
  });

  test("click moves then clicks, once per count", async () => {
    const { exec, calls } = fakeExec();
    await click(hand, 10, 20, { button: "right", count: 2 }, exec);
    expect(calls.map((c) => c.argv.join(" "))).toEqual([
      "wlrctl pointer move -100000 -100000",
      "wlrctl pointer move 10 20",
      "wlrctl pointer click right",
      "wlrctl pointer click right",
    ]);
  });

  test("scroll moves then scrolls", async () => {
    const { exec, calls } = fakeExec();
    await scroll(hand, 5, 6, 3, 0, exec);
    expect(calls.at(-1)!.argv).toEqual(["wlrctl", "pointer", "scroll", "3", "0"]);
  });

  test("a failing command surfaces stderr", async () => {
    const exec: Exec = async () => ({ exitCode: 1, stdout: new Uint8Array(), stderr: "no seat" });
    await expect(moveMouse(hand, 0, 0, exec)).rejects.toThrow(/wlrctl pointer move.*no seat/);
  });
});

describe("keyboard", () => {
  test("typeText uses wtype with a small per-key delay", async () => {
    const { exec, calls } = fakeExec();
    await typeText(hand, "hello world", exec);
    expect(calls[0]!.argv).toEqual(["wtype", "-s", "40", "-d", "8", "hello world"]);
  });

  test("typeText with empty text is a no-op", async () => {
    const { exec, calls } = fakeExec();
    await typeText(hand, "", exec);
    expect(calls).toHaveLength(0);
  });

  test("keyComboToWtypeArgs builds press/release around the key", () => {
    expect(keyComboToWtypeArgs("ctrl+shift+t")).toEqual([
      "-M", "ctrl", "-M", "shift", "-k", "t", "-m", "shift", "-m", "ctrl",
    ]);
    expect(keyComboToWtypeArgs("Return")).toEqual(["-k", "Return"]);
    expect(keyComboToWtypeArgs("enter")).toEqual(["-k", "Return"]);
    expect(keyComboToWtypeArgs("super+l")).toEqual(["-M", "logo", "-k", "l", "-m", "logo"]);
    expect(keyComboToWtypeArgs("pagedown")).toEqual(["-k", "Next"]);
    expect(keyComboToWtypeArgs("f5")).toEqual(["-k", "F5"]);
  });

  test("keyComboToWtypeArgs rejects unknown modifiers", () => {
    expect(() => keyComboToWtypeArgs("hyper+x")).toThrow(/unknown modifier/);
  });

  test("pressKey sends the combo to the hand", async () => {
    const { exec, calls } = fakeExec();
    await pressKey(hand, "ctrl+l", exec);
    expect(calls[0]!.argv).toEqual(["wtype", "-s", "40", "-M", "ctrl", "-k", "l", "-m", "ctrl"]);
    expect(calls[0]!.env).toEqual({ WAYLAND_DISPLAY: "wayland-7" });
  });
});
