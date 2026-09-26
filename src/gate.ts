/**
 * Jev's look at a click's consequences before the clicker makes it, after the teammate's gate (D:/projects/puk/jev
 * gate.ts: 36 of 36 on its fixtures, about 365 ms a look). Five yes/no questions about the exact action, each one plain
 * condition. Only a click whose label reads like a commitment (send, buy, delete...), typing that Return submits, and
 * Return itself are asked about (src/runner.ts commitment), so an ordinary step stays one request; at GATE_AT on any of
 * the five the run stops and hands the action back, for the hand to put to the user or to do itself. The state holds
 * the goal and the action alone: no page text that could argue for it.
 */

import { noul, type TypeSafeClient } from "@typesafe-ai/sdk";

export const RISK_FLAGS = ["irreversible", "spends_money", "destroys_data", "handles_secret", "off_goal"] as const;
export type RiskFlag = (typeof RISK_FLAGS)[number];
export interface Risk {
  flags: Record<RiskFlag, number>;
  worst: RiskFlag;
  level: number;
}

/**
 * A label that reads like it commits something, in any of its forms (Send, Sent, Deleting, Submitted, Checkout).
 * Anything else is a step the next one can take back.
 */
const COMMITS = new RegExp(
  "\\b(" +
    [
      "send(s|ing)?|sent",
      "buy(s|ing)?|bought",
      "pay(s|ing)?|paid",
      "order(s|ed|ing)?",
      "book(s|ed|ing)?",
      "delet(e|es|ed|ing)",
      "remov(e|es|ed|ing)",
      "post(s|ed|ing)?",
      "submit(s|ted|ting)?",
      "confirm(s|ed|ing)?",
      "publish(es|ed|ing)?",
      "purchas(e|es|ed|ing)",
      "check[ -]?out",
      "transfer(s|red|ring)?",
    ].join("|") +
    ")\\b",
  "i",
);
export const consequential = (label: string): boolean => COMMITS.test(label);

// The teammate's questions, word for word but for off_goal, which here has no `avoid` list to read.
const QUESTIONS = {
  irreversible: noul(
    "Doing `action` has an effect that cannot be undone afterwards. Examples: it sends a message or email, submits a form, posts or publishes something, places an order, or confirms a dialog that does one of these.",
    { true: "The effect is permanent or reaches other people.", false: "It only navigates, opens, selects, scrolls, or fills a field that can still be edited." },
  ),
  spends_money: noul("Doing `action` spends money or commits to a payment, a subscription or a purchase."),
  destroys_data: noul("Doing `action` deletes, overwrites or discards something the user may want to keep, such as a file, a message, a draft or unsaved work."),
  handles_secret: noul("Doing `action` enters, reveals or changes a password, passkey, API key, card number or other credential."),
  off_goal: noul("Doing `action` works toward something other than `goal`.", {
    true: "The action is unrelated to the goal.",
    false: "The action is a reasonable step toward the goal.",
  }),
};

/** The five answers for one action, and the worst of them. A missing answer counts as a yes: a doubt must stop, not clear, an action. */
export async function assessRisk(client: TypeSafeClient, context: { goal: string; action: string; app: string; url: string | null }, signal?: AbortSignal): Promise<Risk> {
  const { answers } = await client.systemOne({ state: context, questions: QUESTIONS }, signal ? { signal } : undefined);
  const said = answers as Record<string, { noul?: number } | undefined>;
  const flags = Object.fromEntries(RISK_FLAGS.map((flag) => [flag, typeof said[flag]?.noul === "number" ? said[flag]!.noul! : 1])) as Record<RiskFlag, number>;
  const worst = RISK_FLAGS.reduce((a, b) => (flags[b] > flags[a] ? b : a));
  return { flags, worst, level: flags[worst] };
}
