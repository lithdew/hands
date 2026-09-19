/** devtools.ts against a fake helper: the lines it writes, the lines it is told, and every way the far side can go quiet. */

import { expect, test } from "bun:test";
import { attachPage, type CdpEvent, connectCdp } from "../src/devtools.ts";
import type { NativeSession } from "../src/macos.ts";

const VERSION = { Browser: "Chrome/153.0.0.0", webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/b-1" };
const settle = (ms = 20) => Bun.sleep(ms);

/** `devtools <port>` of windows.cs replaced by a pipe. `answer` plays Chrome: what it says back to each message written. */
function relay(answer?: (message: any, say: (reply: object) => void) => void, first: object | null = VERSION) {
  let push!: (bytes: Uint8Array) => void;
  let hangUp!: () => void;
  const written: any[] = [];
  let ended = 0;
  const exited = Promise.withResolvers<number>();
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (bytes) => controller.enqueue(bytes);
      hangUp = () => {
        try {
          controller.close();
        } catch {
          // closed already
        }
        exited.resolve(0);
      };
    },
  });
  const say = (reply: object) => push(new TextEncoder().encode(`${JSON.stringify(reply)}\n`));
  const session: NativeSession = {
    stdout,
    stderr: new ReadableStream(),
    exited: exited.promise,
    write: (line) => {
      const message = JSON.parse(line);
      expect(line.endsWith("\n") && !line.trimEnd().includes("\n")).toBe(true); // one message, one line
      written.push(message);
      answer?.(message, say);
    },
    end: () => void (ended++, hangUp()),
    kill: () => hangUp(),
  };
  if (first) say(first);
  return { open: () => session, written, say, push, hangUp, ended: () => ended };
}

test("a call is answered by the reply with its id, whatever order the replies come in", async () => {
  const held: any[] = [];
  const fake = relay((message) => void held.push(message));
  const cdp = await connectCdp({ open: fake.open });
  const [first, second] = [cdp.send("Browser.getVersion"), cdp.send("Target.getTargets", { filter: [] })];
  await settle();
  expect(fake.written).toEqual([{ id: 1, method: "Browser.getVersion", params: {} }, { id: 2, method: "Target.getTargets", params: { filter: [] } }]); // prettier-ignore
  fake.say({ id: 2, result: { targetInfos: [] } });
  fake.say({ id: 1, result: { product: "Chrome/153" } });
  expect(await first).toEqual({ product: "Chrome/153" });
  expect(await second).toEqual({ targetInfos: [] });
  cdp.close();
});

test("Chrome's refusal rejects the call with Chrome's words, and the connection goes on", async () => {
  const fake = relay((message, say) => say(message.method === "Nope.nothing" ? { id: message.id, error: { code: -32601, message: "'Nope.nothing' wasn't found" } } : { id: message.id, result: { ok: true } }));
  const cdp = await connectCdp({ open: fake.open });
  await expect(cdp.send("Nope.nothing")).rejects.toThrow("Nope.nothing: 'Nope.nothing' wasn't found");
  expect(await cdp.send<object>("Browser.getVersion")).toEqual({ ok: true });
  cdp.close();
});

test("an event goes to every listener until it unsubscribes, and one that throws holds up nobody", async () => {
  const fake = relay();
  const cdp = await connectCdp({ open: fake.open });
  const seen: CdpEvent[] = [];
  cdp.on(() => {
    throw new Error("a listener's own trouble");
  });
  const off = cdp.on((event) => void seen.push(event));
  fake.say({ method: "Target.targetCreated", params: { targetInfo: { targetId: "T1" } } });
  await settle();
  off();
  fake.say({ method: "Target.targetDestroyed", params: { targetId: "T1" } });
  await settle();
  expect(seen).toEqual([{ method: "Target.targetCreated", params: { targetInfo: { targetId: "T1" } } }]);
  cdp.close();
});

/** Chrome with a service worker, two pages and flattened sessions. */
const browser = () =>
  relay((message, say) => {
    const reply = (result: object) => say({ id: message.id, ...(message.sessionId ? { sessionId: message.sessionId } : {}), result });
    if (message.method === "Target.getTargets") return reply({ targetInfos: [{ targetId: "W", type: "service_worker", title: "", url: "" }, { targetId: "D", type: "page", title: "DevTools", url: "devtools://devtools/x" }, { targetId: "T1", type: "page", title: "One", url: "https://one.example/" }, { targetId: "T2", type: "page", title: "Two", url: "https://two.example/" }] }); // prettier-ignore
    if (message.method === "Target.attachToTarget") return reply({ sessionId: `S-${message.params.targetId}` });
    if (message.method === "Runtime.evaluate" && message.params.expression === "nope()") return reply({ result: { type: "object" }, exceptionDetails: { text: "Uncaught", exception: { description: "ReferenceError: nope is not defined\n    at <anonymous>:1:1" } } }); // prettier-ignore
    if (message.method === "Runtime.evaluate") return reply({ result: { type: "number", value: 2 } });
    reply({});
  });

test("a page is a flattened session on the browser's socket: the first page when none is named, and its calls carry its session", async () => {
  const fake = browser();
  const cdp = await connectCdp({ open: fake.open });
  const page = await attachPage(cdp);
  expect(page).toMatchObject({ targetId: "T1", sessionId: "S-T1" });
  expect(fake.written.at(-1)).toEqual({ id: 2, method: "Target.attachToTarget", params: { targetId: "T1", flatten: true } });
  expect(await page.evaluate<number>("1+1")).toBe(2);
  expect(fake.written.at(-1)).toEqual({ id: 3, method: "Runtime.evaluate", params: { expression: "1+1", returnByValue: true, awaitPromise: true }, sessionId: "S-T1" });
  await expect(page.evaluate("nope()")).rejects.toThrow("ReferenceError: nope is not defined");
  expect((await attachPage(cdp, "T2")).sessionId).toBe("S-T2");
  cdp.close();
});

test("a page hears its own events only", async () => {
  const fake = browser();
  const cdp = await connectCdp({ open: fake.open });
  const [one, two] = [await attachPage(cdp, "T1"), await attachPage(cdp, "T2")];
  const heard: string[] = [];
  one.on((event) => void heard.push(`one ${event.method}`));
  const off = two.on((event) => void heard.push(`two ${event.method}`));
  fake.say({ method: "Page.loadEventFired", params: {}, sessionId: "S-T1" });
  fake.say({ method: "Page.frameNavigated", params: {}, sessionId: "S-T2" });
  fake.say({ method: "Target.targetInfoChanged", params: {} });
  await settle();
  off();
  fake.say({ method: "Page.loadEventFired", params: {}, sessionId: "S-T2" });
  await settle();
  expect(heard).toEqual(["one Page.loadEventFired", "two Page.frameNavigated"]);
  cdp.close();
});

test("with no page there is nothing to attach to", async () => {
  const fake = relay((message, say) => say({ id: message.id, result: { targetInfos: [] } }));
  const cdp = await connectCdp({ open: fake.open });
  await expect(attachPage(cdp)).rejects.toThrow("the browser has no page to attach to");
  cdp.close();
});

test("when nothing listens the helper's one line is the rejection, once, and the helper is let go", async () => {
  const fake = relay(undefined, { error: "nothing listens on DevTools port 9444" });
  await expect(connectCdp({ port: 9444, open: fake.open })).rejects.toThrow("nothing listens on DevTools port 9444");
  expect(fake.ended()).toBe(1);
  expect(fake.written).toEqual([]);
});

test("a helper that dies before it says anything is a rejection too", async () => {
  const fake = relay(undefined, null);
  const connecting = connectCdp({ open: fake.open });
  fake.hangUp();
  await expect(connecting).rejects.toThrow("the DevTools relay ended");
});

test("when Chrome goes, every call still waiting is rejected, `closed` resolves, and nothing more is sent", async () => {
  const fake = relay();
  const cdp = await connectCdp({ open: fake.open });
  let closed = false;
  void cdp.closed.then(() => (closed = true));
  const waiting = [cdp.send("Page.navigate", { url: "https://example.com/" }, "S-T1"), cdp.send("Browser.close")];
  const rejected = Promise.all(waiting.map((call) => call.then(() => "answered", (error: Error) => error.message))); // prettier-ignore
  await settle();
  expect(closed).toBe(false);
  fake.say({ error: "the browser closed its DevTools socket" });
  expect(await rejected).toEqual(["Page.navigate was not answered: the browser closed its DevTools socket", "Browser.close was not answered: the browser closed its DevTools socket"]);
  await cdp.closed;
  expect(fake.ended()).toBe(1); // WSL keeps the helper open while its stdin is
  await expect(cdp.send("Browser.getVersion")).rejects.toThrow("Browser.getVersion was not sent: the browser closed its DevTools socket");
  expect(fake.written).toHaveLength(2);
});

test("a helper that is killed ends the same way", async () => {
  const fake = relay();
  const cdp = await connectCdp({ open: fake.open });
  const waiting = cdp.send("Runtime.evaluate", { expression: "1" }, "S-T1").then(() => "answered", (error: Error) => error.message); // prettier-ignore
  fake.hangUp();
  expect(await waiting).toBe("Runtime.evaluate was not answered: the DevTools relay ended");
  await cdp.closed;
});

test("close ends the helper, and no listener hears anything after it", async () => {
  const fake = relay();
  const cdp = await connectCdp({ open: fake.open });
  const heard: string[] = [];
  cdp.on((event) => void heard.push(event.method));
  cdp.close();
  await cdp.closed;
  expect(fake.ended()).toBe(1);
  cdp.close(); // twice is once
  expect(fake.ended()).toBe(1);
  expect(heard).toEqual([]);
});

test("a call that is never answered gives up on its own, and an answer that comes late is dropped", async () => {
  const fake = relay();
  const cdp = await connectCdp({ open: fake.open, timeoutMs: 30 });
  await expect(cdp.send("Runtime.evaluate", { expression: "new Promise(() => {})" }, "S-T1")).rejects.toThrow("Runtime.evaluate was not answered in 0.03 s");
  fake.say({ id: 1, result: { late: true } });
  fake.say({ id: 2, result: { ok: true } });
  const next = cdp.send("Browser.getVersion");
  expect(await next).toEqual({ ok: true });
  cdp.close();
});

test("a message of megabytes comes whole, however the pipe cut it up, and two in one piece are two", async () => {
  const fake = relay();
  const cdp = await connectCdp({ open: fake.open });
  const big = `${"é€🙂".repeat(400_000)}`; // multi-byte, so a cut lands inside a character
  const events: CdpEvent[] = [];
  cdp.on((event) => void events.push(event));
  const asked = cdp.send<{ result: { value: string } }>("Runtime.evaluate", { expression: "big" }, "S-T1");
  const bytes = new TextEncoder().encode(`${JSON.stringify({ id: 1, sessionId: "S-T1", result: { result: { type: "string", value: big } } })}\n${JSON.stringify({ method: "Page.loadEventFired", params: {} })}\n${JSON.stringify({ method: "Page.frameStoppedLoading", params: {} })}\n`);
  expect(bytes.length).toBeGreaterThan(3 * 1024 * 1024);
  for (let at = 0; at < bytes.length; at += 65_521) fake.push(bytes.slice(at, at + 65_521));
  expect((await asked).result.value).toBe(big);
  await settle();
  expect(events.map((event) => event.method)).toEqual(["Page.loadEventFired", "Page.frameStoppedLoading"]);
  cdp.close();
});
