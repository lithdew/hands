import { describe, expect, test } from "bun:test";
import {
  click,
  desktopEntryArgs,
  discoverApps,
  keyComboToWtypeArgs,
  listHands,
  moveMouse,
  pressKey,
  redact,
  rememberSecret,
  screenshot,
  scroll,
  swayConfig,
  parsePalette,
  swayCommand,
  subprocessEnv,
  typeText,
  type Exec,
  type Hand,
} from "./desktop";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const hand: Hand = { id: 1, pid: 4242, display: "wayland-7", width: 1280, height: 800 };

describe("installed applications", () => {
  test("desktop entry arguments preserve spaces and never expand shell expressions", () => {
    expect(desktopEntryArgs('writer "a file.md" %f %c %%', { Name: "My Writer" }, "/apps/writer.desktop")).toEqual(["writer", "a file.md", "My Writer", "%"]);
    expect(desktopEntryArgs('writer "$(whoami)"', {}, "x")).toEqual(["writer", "$(whoami)"]);
    expect(() => desktopEntryArgs("writer %unknown", {}, "x")).toThrow("field code");
    expect(() => desktopEntryArgs('writer "missing', {}, "x")).toThrow("Unclosed");
  });

  test("discovers arbitrary apps and respects hidden user overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "puk-apps-test-"));
    const user = join(root, "user"), system = join(root, "system");
    try {
      await Promise.all([mkdir(user), mkdir(system)]);
      await Bun.write(join(system, "writer.desktop"), "[Desktop Entry]\nType=Application\nName=Novel Writer\nComment=Write notes\nExec=/usr/bin/printf %f\nCategories=Office;\n");
      await Bun.write(join(system, "hidden.desktop"), "[Desktop Entry]\nType=Application\nName=Hidden App\nExec=/usr/bin/printf\n");
      await Bun.write(join(user, "hidden.desktop"), "[Desktop Entry]\nHidden=true\n");
      const apps = await discoverApps([user, system]);
      expect(apps.map((a) => a.id)).toEqual(["writer.desktop"]);
      expect(apps[0]).toMatchObject({ name: "Novel Writer", description: "Write notes", argv: ["/usr/bin/printf"] });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("private environment and registry", () => {
  test("new .env aliases and exported credentials stay out of subprocesses and logs", async () => {
    const root = await mkdtemp(join(tmpdir(), "puk-env-test-"));
    try {
      await Bun.write(join(root, ".env"), "UNUSUAL_ALIAS=test-only-private-alias\nPUK_PORT=8888\n");
      const module = JSON.stringify(join(import.meta.dir, "desktop.ts"));
      const child = Bun.spawn([process.execPath, "-e", `
        import { subprocessEnv, redact } from ${module};
        const env = subprocessEnv();
        console.log(JSON.stringify({
          aliasHidden: env.UNUSUAL_ALIAS === undefined,
          exportedHidden: env.PUK_TEST_ACCESS_TOKEN === undefined,
          configKept: env.PUK_PORT === "8888",
          redacted: redact(process.env.UNUSUAL_ALIAS + " " + process.env.PUK_TEST_ACCESS_TOKEN),
        }));
      `], {
        cwd: root,
        env: { ...subprocessEnv(), PUK_PORT: "8888", PUK_TEST_ACCESS_TOKEN: "test-only-exported-token" },
        stdout: "pipe", stderr: "pipe",
      });
      const [result, code] = await Promise.all([new Response(child.stdout).json(), child.exited]);
      expect(code).toBe(0);
      expect(result).toEqual({ aliasHidden: true, exportedHidden: true, configKept: true, redacted: "[redacted] [redacted]" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("explicit API keys are redacted in plain text and JSON traces", () => {
    const secret = 'test-only-explicit-"key\\value';
    rememberSecret(secret);
    expect(redact(`Provider returned ${secret}`)).toBe("Provider returned [redacted]");
    expect(JSON.parse(redact(JSON.stringify({ error: secret })))).toEqual({ error: "[redacted]" });
  });

  test("corrupt, mismatched and dead registry entries cannot hide running hands", async () => {
    const root = await mkdtemp(join(tmpdir(), "puk-registry-test-"));
    try {
      await Promise.all([
        Bun.write(join(root, "hand-1.json"), "{interrupted"),
        Bun.write(join(root, "hand-2.json"), JSON.stringify({ ...hand, id: 2, pid: 0 })),
        Bun.write(join(root, "hand-3.json"), JSON.stringify({ ...hand, id: 30 })),
        Bun.write(join(root, "hand-4.json"), JSON.stringify({ ...hand, id: 4, pid: 9999 })),
        Bun.write(join(root, "hand-5.json"), JSON.stringify({ ...hand, id: 5 })),
        Bun.write(join(root, "hand-6.json.4242.tmp"), "{in progress"),
      ]);
      expect(await listHands(root, (pid) => pid === hand.pid)).toEqual([{ ...hand, id: 5 }]);
      expect(await Bun.file(join(root, "hand-4.json")).exists()).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

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
    expect(conf).toContain("focus_follows_mouse no");
    expect(conf).toContain("workspace_layout tabbed");
    expect(conf).toContain("output * mode 1024x768");
    expect(conf).toContain(`echo "$WAYLAND_DISPLAY" > '/run/user/1000/hands/hand-1.display'`);
  });

  test("styles the tab strip and bar from the palette", () => {
    const palette = parsePalette('accent = "#0000FF"\nbackground = "#010101"\nbright_foreground = "#fefefe"\nred = "not-a-color"');
    expect(palette.accent).toBe("#0000ff");
    expect(palette.background).toBe("#010101");
    expect(palette.foreground).toBe("#fefefe");
    expect(palette.red).toBe("#f7768e");
    const conf = swayConfig({ width: 1024, height: 768, displayFile: "/tmp/hand-1.display", handId: 1, palette });
    expect(conf).toContain("client.focused #0000ff");
    expect(conf).toContain("output * bg #010101 solid_color");
    expect(conf).toContain("    background #010101");
    expect(conf).toContain("    statusline #fefefe");
    expect(conf).toContain("title_align center");
  });

  test("nested startup does not inherit privileged realtime scheduling", () => {
    expect(swayCommand("/tmp/hand.conf", true)).toEqual(["setpriv", "--no-new-privs", "sway", "-c", "/tmp/hand.conf"]);
    expect(swayCommand("/tmp/hand.conf", false)).toEqual(["sway", "-c", "/tmp/hand.conf"]);
  });

  test("GUI subprocesses do not inherit provider credentials", () => {
    const old = process.env.OAI;
    process.env.OAI = "test-secret";
    try { expect(subprocessEnv().OAI).toBeUndefined(); }
    finally { if (old === undefined) delete process.env.OAI; else process.env.OAI = old; }
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
    expect(calls[0]!.argv).toEqual(["wtype", "-s", "40", "-d", "8", "--", "hello world"]);
  });

  test("leading dashes in typed text are not interpreted as wtype options", async () => {
    const { exec, calls } = fakeExec();
    await typeText(hand, "-M ctrl", exec);
    expect(calls[0]!.argv.slice(-2)).toEqual(["--", "-M ctrl"]);
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
    expect(calls[1]!.argv[0]).toBe("swaymsg");
    expect(calls[1]!.argv.at(-1)).toBe("input type:keyboard repeat_delay 600");
    expect(calls[1]!.env).toEqual({ WAYLAND_DISPLAY: "wayland-7" });
  });
});
