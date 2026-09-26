import { expect, test } from "bun:test";
import { APITimeoutError, AuthenticationError } from "@typesafe-ai/sdk";
import { DEFAULT_JEV_MODEL } from "../src/config.ts";
import { absent, addressed, aimed, ASK_MS, intent, NONE, type Out, plan, progress, SURE, SURE_OTHER, told, WHAT, WHATS, WHICH } from "../src/intent.ts";

// intent.ts against a scripted TypeSafe client: what it asks, and what it makes of the answers; and, with no client at
// all, which hands a reading is for, what doing it comes to, and what the dock says. No call here reaches TypeSafe.

type Asked = { request: { state: { typed: string; hands: Record<string, string> }; questions: Record<string, { type: string; instructions?: unknown; criteria?: Record<string, unknown> }>; model?: string }; options: unknown };

/** A client that answers every request with `reply`, or throws what it throws. */
function jev(reply: () => unknown) {
  const asked: Asked[] = [];
  const fake = {
    systemOne: (request: unknown, options: unknown) => {
      asked.push({ request, options } as Asked);
      return Promise.resolve().then(reply);
    },
  } as never;
  return { client: () => fake, asked };
}

const answers = (what: string, confidence: number, which: string, sure = 0.95) => ({
  model: "jev-1.13.0",
  usage: { input_tokens: 300, output_tokens: 0 },
  answers: {
    what: { type: "choice", choice: what, confidence, probabilities: { [what]: confidence } },
    which: { type: "choice", choice: which, confidence: sure, probabilities: { [which]: sure } },
  },
});

const LEFTY: Out = { id: "lefty", name: "Lefty", status: "working", task: "Find the cheapest flight from Hong Kong to Tokyo", window: true };
const RIGHTY: Out = { id: "righty", name: "Righty", status: "done", task: "Open Notepad and write a haiku about lunch", window: true };
const THUMBS: Out = { id: "thumbs", name: "Thumbs", status: "paused", task: "Summarise the emails from Priya", window: true };
const PINKY: Out = { id: "pinky", name: "Pinky", status: "needs_you", task: "Book a table at Dishoom", window: true, needs: "Sign in to OpenTable, then tell me to carry on." };
const PALM: Out = { id: "palm", name: "Palm", status: "working", task: "When does the Tate close?", kind: "lookup" };
const two = [LEFTY, RIGHTY];

test("one request: the typed line and the hands once, by id, in state; what and which as choices, the hands bare; 1.5 s, no retry, Jev's model pinned", async () => {
  const { client, asked } = jev(() => answers("steer", 0.93, "lefty"));
  const got = await intent(client, "only direct flights", [...two, PINKY]);
  expect(got).toMatchObject({ what: "steer", hand: "lefty", confidence: 0.93 });
  expect(got.ms).toBeGreaterThanOrEqual(0);
  const { request, options } = asked[0]!;
  expect(request.state).toEqual({
    typed: "only direct flights",
    hands: {
      lefty: "Lefty, working: Find the cheapest flight from Hong Kong to Tokyo",
      righty: "Righty, finished: Open Notepad and write a haiku about lunch",
      pinky: "Pinky, waiting for the user to do something for it (Sign in to OpenTable, then tell me to carry on.): Book a table at Dishoom",
    },
  });
  expect(request.questions.what).toEqual({ type: "choice", instructions: WHAT, criteria: WHATS });
  expect(Object.keys(WHATS)).toEqual(["new_task", "steer", "stop", "pause", "resume", "close", "clear", "show", "question", "nothing"]);
  expect(request.questions.which!.instructions).toBe(WHICH);
  expect(request.questions.which!.criteria).toMatchObject({ lefty: null, righty: null, pinky: null, all: expect.any(String), unsaid: expect.any(String), none_of_these: expect.any(String) });
  expect(request.model).toBe(DEFAULT_JEV_MODEL);
  expect(options).toEqual({ timeout: ASK_MS, retry: { maxRetries: 0 } });
  expect(ASK_MS).toBe(1500);
});

test("with no hands out a line is a new task, and Jev is not asked", async () => {
  const { client, asked } = jev(() => answers("stop", 0.99, "all"));
  expect(await intent(client, "stop", [])).toMatchObject({ what: "new_task", hand: null, confidence: 0, why: "no hands are out" });
  expect(asked.length).toBe(0);
});

test("a timeout, an error, no key, an answer without its questions, or one Jev is unsure of is a new task, as every typed line was before", async () => {
  const failures: [() => unknown, string][] = [
    [() => { throw new APITimeoutError(1500); }, "Jev could not be asked: "],
    [() => { throw new AuthenticationError(401, { detail: "bad key" }, new Headers()); }, "Jev could not be asked: "],
    [() => ({ answers: {} }), "Jev's answer was not one it was offered"],
    [() => answers("dance", 0.99, "lefty"), "Jev's answer was not one it was offered"],
    [() => answers("stop", 0.59, "lefty"), "Jev leaned to stop, but not surely (0.59)"],
  ]; // prettier-ignore
  for (const [reply, why] of failures) {
    const got = await intent(jev(reply).client, "stop lefty", two);
    expect(got).toMatchObject({ what: "new_task", hand: null });
    expect(got.why).toStartWith(why);
  }
  const keyless = () => {
    throw new Error("No API key was provided");
  };
  expect(await intent(keyless as never, "stop lefty", two)).toMatchObject({ what: "new_task", why: "Jev could not be asked: No API key was provided" });
  expect(SURE).toBe(0.6);
  expect((await intent(jev(() => answers("stop", 0.6, "lefty")).client, "stop lefty", two)).what).toBe("stop"); // at the line, not past it
});

test("the hand: Jev's when it is sure, else the one the line names, else something else when Jev is sure of that", async () => {
  expect((await intent(jev(() => answers("stop", 0.9, "lefty", 0.49)).client, "stop it", two)).hand).toBeNull();
  expect((await intent(jev(() => answers("stop", 0.9, "none_of_these", 0.6)).client, "stop Righty please", two)).hand).toBe("righty"); // the name, over Jev
  expect((await intent(jev(() => answers("close", 0.9, "all")).client, "close everyone", two)).hand).toBe("all");
  expect((await intent(jev(() => answers("stop", 0.9, "thumbs")).client, "stop", two)).hand).toBeNull(); // not a hand that is out
  expect((await intent(jev(() => answers("stop", 0.96, "unsaid", 0.98)).client, "stop", two)).hand).toBeNull();
  // Jev sure the line is about something that is not a hand out: said so, for plan() to make new work of.
  expect(SURE_OTHER).toBe(0.6);
  expect(await intent(jev(() => answers("stop", 0.9, "none_of_these", 0.97)).client, "stop the music", two)).toMatchObject({ what: "stop", hand: NONE });
  expect((await intent(jev(() => answers("pause", 0.9, "none_of_these", 0.59)).client, "hold on a sec", two)).hand).toBeNull(); // not surely
});

test("a line that calls a hand is new work for it; one that only begins with a hand's name is when Jev reads it so", async () => {
  const called = await intent(jev(() => answers("new_task", 0.51, "righty", 0.88)).client, "Righty, now write one about dinner", two);
  expect(called).toMatchObject({ what: "steer", hand: "righty" });
  expect(called.why).toContain("begins with Righty's name");
  expect((await intent(jev(() => answers("new_task", 0.95, "none_of_these")).client, "Righty, now write one about dinner", two)).what).toBe("steer"); // set off: called, whatever Jev reads
  expect((await intent(jev(() => answers("new_task", 0.9, "none_of_these")).client, "find a hotel near Lefty's airport", two)).what).toBe("new_task");
  // Only the name first: "Palm Springs hotels" is a new task, as Jev reads it; "Righty now …" is Righty's when Jev says so.
  expect(await intent(jev(() => answers("new_task", 0.99, "none_of_these", 0.99)).client, "Palm Springs hotels for the weekend", [LEFTY, PALM])).toMatchObject({ what: "new_task", hand: null });
  expect(await intent(jev(() => answers("new_task", 0.9, "righty", 0.8)).client, "Righty now write one about dinner", two)).toMatchObject({ what: "steer", hand: "righty" });
  expect(await intent(jev(() => answers("new_task", 0.55, "none_of_these", 0.5)).client, "Righty now write one about dinner", two)).toMatchObject({ what: "steer", hand: "righty" }); // Jev unsure it is new work
  expect(addressed("hey lefty: only direct ones", two)).toEqual({ hand: LEFTY, surely: true });
  expect(addressed("hey lefty only direct ones", two)).toEqual({ hand: LEFTY, surely: true });
  expect(addressed("Lefty! only direct ones", two)).toEqual({ hand: LEFTY, surely: true });
  expect(addressed("lefty only direct ones", two)).toEqual({ hand: LEFTY, surely: false });
  expect(addressed("Righty's window", two)).toBeUndefined();
  expect(addressed("Leftyish", two)).toBeUndefined();
});

test("a hand's name that is not out: named when the line names no hand that is", () => {
  const cast = ["Lefty", "Righty", "Thumbs", "Palm"];
  expect(absent("close righty", [LEFTY], cast)).toBe("Righty");
  expect(absent("close Righty's window", [LEFTY], cast)).toBe("Righty");
  expect(absent("tell lefty what righty found", [LEFTY], cast)).toBeUndefined(); // names Lefty, who is out
  expect(absent("close righty", two, cast)).toBeUndefined();
  expect(absent("close the palmtop", [LEFTY], cast)).toBeUndefined(); // not the word
});

test("which hands a reading is for: the one named, every one it fits for all, the only one it can be, or none, so the user is asked", () => {
  const ids = (hands: Out[]) => hands.map((one) => one.id);
  expect(ids(aimed("stop", "righty", two))).toEqual(["righty"]); // named: the dock says it has finished
  expect(ids(aimed("stop", "all", [...two, THUMBS]))).toEqual(["lefty", "thumbs"]);
  expect(ids(aimed("close", "all", two))).toEqual(["lefty", "righty"]);
  expect(ids(aimed("pause", "all", [RIGHTY]))).toEqual([]); // it fits none
  // Everyone: a word goes to the hands still at it, not as new work to a finished one, nor to one waiting for the user;
  // carry on goes to the paused and stopped ones. Clearing is of the finished hands, and no others.
  const everyone = [LEFTY, RIGHTY, THUMBS, PINKY, PALM, { ...RIGHTY, id: "digit", name: "Digit", status: "stopped" as const }];
  expect(ids(aimed("steer", "all", everyone))).toEqual(["lefty", "thumbs", "palm"]);
  expect(ids(aimed("resume", "all", everyone))).toEqual(["thumbs", "digit"]);
  expect(ids(aimed("clear", "all", everyone))).toEqual(["righty", "digit"]);
  expect(ids(aimed("clear", null, everyone))).toEqual(["righty", "digit"]);
  expect(ids(aimed("clear", "lefty", everyone))).toEqual(["lefty"]); // named: closed, as close would
  expect(ids(aimed("close", "all", everyone))).toEqual(ids(everyone));
  expect(ids(aimed("question", NONE, two))).toEqual(["lefty", "righty"]); // something else: every hand's news
  expect(ids(aimed("stop", null, [RIGHTY]))).toEqual(["righty"]); // the only hand out
  expect(ids(aimed("stop", null, two))).toEqual(["lefty"]); // the only one at work
  expect(ids(aimed("stop", null, [LEFTY, PALM]))).toEqual([]); // two at work: which?
  expect(ids(aimed("resume", null, [...two, THUMBS]))).toEqual(["thumbs"]);
  expect(ids(aimed("resume", null, [...two, THUMBS, PINKY]))).toEqual([]);
  // A word with no hand named is for the one at work, then the one waiting for the user, then the one paused.
  expect(ids(aimed("steer", null, [RIGHTY, THUMBS, PINKY, LEFTY]))).toEqual(["lefty"]);
  expect(ids(aimed("steer", null, [RIGHTY, THUMBS, PINKY]))).toEqual(["pinky"]);
  expect(ids(aimed("steer", null, [LEFTY, PALM]))).toEqual([]);
  // Jev's hand, even one the action cannot be asked of: the dock says so, rather than acting on another.
  expect(ids(aimed("pause", "thumbs", [LEFTY, THUMBS]))).toEqual(["thumbs"]);
  expect(ids(aimed("question", null, two))).toEqual(["lefty", "righty"]);
  expect(ids(aimed("question", "righty", two))).toEqual(["righty"]);
  expect(aimed("new_task", "lefty", two)).toEqual([]);
});

test("what a reading comes to: the backend's tools, the card's buttons, an answer, or only words", () => {
  expect(plan("new_task", null, "find me a hotel", two)).toEqual([{ tool: "start_hands", args: { tasks: ["find me a hotel"] } }]);
  expect(plan("steer", "lefty", "only direct ones", two)).toEqual([{ tool: "steer_hand", args: { hand: "lefty", message: "only direct ones" }, fresh: false }]);
  expect(plan("steer", "righty", "now one about dinner", two)).toEqual([{ tool: "steer_hand", args: { hand: "righty", message: "now one about dinner" }, fresh: true }]);
  expect(plan("stop", "lefty", "stop", two)).toEqual([{ tool: "stop_hands", args: { hands: ["lefty"] } }]);
  expect(plan("stop", "thumbs", "stop thumbs", [LEFTY, THUMBS])).toEqual([{ button: "stop", hand: "thumbs", name: "Thumbs" }]); // paused: as its card's Stop does
  expect(plan("stop", "righty", "stop righty", two)).toEqual([{ say: "Righty has finished." }]);
  expect(plan("pause", "lefty", "hold on", two)).toEqual([{ button: "pause", hand: "lefty", name: "Lefty" }]);
  expect(plan("pause", "palm", "pause palm", [PALM])).toEqual([{ say: "Palm is a web lookup: it can be stopped, not paused." }]);
  expect(plan("resume", "thumbs", "carry on", [THUMBS])).toEqual([{ button: "resume", hand: "thumbs", name: "Thumbs" }]);
  expect(plan("resume", "pinky", "I've signed in, carry on", [PINKY])).toEqual([{ tool: "steer_hand", args: { hand: "pinky", message: "I've signed in, carry on" }, fresh: false }]); // the user's own words
  expect(plan("resume", "lefty", "go on", two)).toEqual([{ say: "Lefty is already at work." }]);
  expect(plan("show", "lefty", "show me", two)).toEqual([{ button: "show", hand: "lefty", name: "Lefty" }]);
  expect(plan("show", "palm", "show me", [PALM])).toEqual([{ say: "Palm has no window to show." }]);
  expect(plan("close", "all", "clear them all", two)).toEqual([{ tool: "close_hands", args: { hands: ["lefty"] } }, { tool: "close_hands", args: { hands: ["righty"] } }]);
  expect(plan("question", null, "how's it going?", two)).toEqual([{ answer: ["lefty", "righty"] }]);
  expect(plan("nothing", null, "thanks!", two)).toEqual([{ say: "Nothing to do." }]);
  expect(plan("stop", null, "stop", [LEFTY, PALM, RIGHTY])).toEqual([{ say: "Which hand? Lefty, Palm or Righty." }]);
});

test("what a reading comes to for every hand: clear only the finished, a word only to the ones at it, and a line when it is for none", () => {
  const close = (id: string) => ({ tool: "close_hands" as const, args: { hands: [id] } });
  const palm = { ...RIGHTY, id: "palm", name: "Palm" }; // finished too
  expect(plan("clear", "all", "clear the finished ones", [LEFTY, RIGHTY, THUMBS, PINKY, palm])).toEqual([close("righty"), close("palm")]);
  expect(plan("clear", null, "clear the done ones away", [LEFTY, RIGHTY, palm])).toEqual([close("righty"), close("palm")]);
  expect(plan("clear", null, "clear the finished ones", [LEFTY, THUMBS])).toEqual([{ say: "No hand has finished." }]);
  expect(plan("steer", "all", "everyone, use Edge not Chrome", [LEFTY, RIGHTY, THUMBS, PINKY])).toEqual([
    { tool: "steer_hand", args: { hand: "lefty", message: "everyone, use Edge not Chrome" }, fresh: false },
    { tool: "steer_hand", args: { hand: "thumbs", message: "everyone, use Edge not Chrome" }, fresh: false },
  ]);
  expect(plan("steer", "all", "everyone, use Edge", [RIGHTY, PINKY])).toEqual([{ say: "No hand is at work to tell." }]);
  expect(plan("resume", "all", "carry on everyone", [LEFTY, THUMBS, PINKY])).toEqual([{ button: "resume", hand: "thumbs", name: "Thumbs" }]);
  expect(plan("resume", "all", "carry on everyone", [LEFTY, PINKY])).toEqual([{ say: "No hand is paused or stopped." }]);
  expect(plan("pause", "all", "pause everyone", [RIGHTY, PALM])).toEqual([{ say: "No hand is at work to pause." }]);
  expect(plan("stop", "all", "stop everything", [RIGHTY])).toEqual([{ say: "No hand is at work." }]);
});

test("a reading of something that is not a hand out is not done to one: a name not out is said, anything else is new work", () => {
  const cast = ["Lefty", "Righty", "Thumbs"];
  const start = (typed: string) => [{ tool: "start_hands" as const, args: { tasks: [typed] } }];
  // Righty was closed: "close righty" does not fall on Lefty, the only hand out.
  expect(plan("close", NONE, "close righty", [LEFTY], cast)).toEqual([{ say: "No hand called Righty is out." }]);
  expect(plan("close", null, "close righty", [LEFTY], cast)).toEqual([{ say: "No hand called Righty is out." }]);
  expect(plan("question", null, "how's thumbs doing?", [LEFTY], cast)).toEqual([{ say: "No hand called Thumbs is out." }]);
  expect(plan("steer", NONE, "righty, now one about dinner", [LEFTY], cast)).toEqual([{ say: "No hand called Righty is out." }]);
  // An app, music, a video: new work, as every typed line was before, not stop or close of the hand the action fits.
  for (const what of ["stop", "pause", "resume", "close", "clear", "show"] as const) expect(plan(what, NONE, "close Notepad", [LEFTY, RIGHTY], cast)).toEqual(start("close Notepad"));
  expect(plan("stop", NONE, "stop the music", [LEFTY], cast)).toEqual(start("stop the music"));
  // A word for a hand and a question are about the hands whatever Jev says of which: the one at work, every hand.
  expect(plan("steer", NONE, "don't forget the leak in the bathroom", two, cast)).toEqual([{ tool: "steer_hand", args: { hand: "lefty", message: "don't forget the leak in the bathroom" }, fresh: false }]);
  expect(plan("question", NONE, "how's it going?", two, cast)).toEqual([{ answer: ["lefty", "righty"] }]);
  // A steer with no hand named does not look for names: "the index page" is not Index.
  expect(plan("steer", null, "also check the index page", [LEFTY], ["Lefty", "Index"])).toEqual([{ tool: "steer_hand", args: { hand: "lefty", message: "also check the index page" }, fresh: false }]);
});

test("what the dock says came of it: a few words, one outcome said once for several hands, an error as it came", () => {
  expect(told([{ hand: "Lefty", state: "started", result: "pending" } as never])).toBe("Lefty is on it.");
  expect(told([{ hand: "Lefty", state: "started" }, { hand: "Righty", state: "started" }])).toBe("Lefty and Righty are on it.");
  expect(told([{ hand: "Lefty", state: "already on it" }])).toBe("Lefty is already on it.");
  expect(told([{ hand: "Lefty", state: "instruction delivered" }])).toBe("Told Lefty.");
  expect(told([{ hand: "Righty", state: "instruction delivered", fresh: true }])).toBe("Righty is on it.");
  expect(told([{ hand: "Lefty", state: "stop requested" }, { hand: "Thumbs", state: "stop" }])).toBe("Stopping Lefty and Thumbs.");
  expect(told([{ hand: "Palm", state: "stopped" }])).toBe("Stopped Palm.");
  expect(told([{ hand: "Righty", state: "not working: done" }])).toBe("Righty has finished.");
  expect(told([{ hand: "Lefty", state: "dismissed" }, { hand: "Righty", state: "dismissed" }, { hand: "Thumbs", state: "dismissed" }])).toBe("Closed Lefty, Righty and Thumbs.");
  expect(told([{ hand: "Lefty", state: "pause" }])).toBe("Pausing Lefty.");
  expect(told([{ hand: "Thumbs", state: "resume" }])).toBe("Thumbs carries on.");
  expect(told([{ hand: "Lefty", state: "show" }])).toBe("Brought Lefty's window to you.");
  expect(told([{ task: "find a hotel", error: "8 hands are out and none has finished: stop or close one first" }])).toBe("8 hands are out and none has finished: stop or close one first.");
  expect(told([{ error: "no such hand. Out now: Lefty" }])).toBe("No such hand. Out now: Lefty.");
});

test("how things are going, in the dock: a line a hand from what the voice knows, short for several, and past three how many more", () => {
  const lefty = { hand: "Lefty", status: "working" as const, minutes: 2, now: "click “Search”" };
  const righty = { hand: "Righty", status: "done" as const, answer: "Wrote the haiku: Lunch waits in warm light." };
  expect(progress([lefty])).toBe("Lefty is working (2 min): click “Search”.");
  expect(progress([lefty, righty])).toBe("Lefty is working: click “Search”.\nRighty is done: Wrote the haiku: Lunch waits in warm light."); // a line each
  expect(progress([lefty, { ...righty, answer: "Wrote the haiku, saved it on the desktop as haiku.txt, and left Notepad open for you." }]).split("\n")[1]).toBe("Righty is done: Wrote the haiku, saved it on the desktop as…"); // cut at a word
  expect(progress([{ hand: "Pinky", status: "needs_you", needs: "Sign in to OpenTable." }])).toBe("Pinky needs you: Sign in to OpenTable.");
  expect(progress([{ hand: "Thumbs", status: "failed", reason: "Calculator would not open." }])).toBe("Thumbs couldn't finish: Calculator would not open.");
  expect(progress([{ hand: "Palm", status: "working", lookup: true }])).toBe("Palm is looking it up.");
  expect(progress([{ hand: "Palm", status: "done", lookup: true, answer: "Until 10pm on Fridays." }])).toBe("Palm looked it up: Until 10pm on Fridays.");
  expect(progress([{ hand: "Index", status: "starting" }, { hand: "Digit", status: "paused" }, { hand: "Knuckles", status: "stopped" }])).toBe("Index is getting ready.\nDigit is paused.\nKnuckles is stopped.");
  const five = ["Lefty", "Righty", "Thumbs", "Pinky", "Palm"].map((hand) => ({ hand, status: "paused" as const }));
  expect(progress(five)).toBe("Lefty is paused.\nRighty is paused.\n3 more: Thumbs, Pinky and Palm.");
  expect(progress([])).toBe("No hands are out.");
});
