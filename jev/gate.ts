// gate.ts — Jev checks every action before a hand performs it.
//
// Risky actions pause and wait for the user. "Risky" is five yes/no questions
// (Nouls) about the one action that is about to happen, asked in parallel in a
// single request, about 100 ms:
//
//   irreversible    sends, submits, publishes, orders
//   spends_money
//   destroys_data   deletes, overwrites, discards
//   handles_secret  passwords, keys, card numbers
//   off_goal        does not serve what the user asked for
//
// The gate's state holds the user's goal and the action, and nothing read off
// the screen except the target's own label. A web page that says "ignore your
// instructions" never reaches the model that decides whether to pause.
//
//   assessRisk(ask, {goal, avoid, action}) -> Risk
//   needsApproval(risk)                    -> boolean
//   terminalApprove                        asks y/N on the terminal

import { noul, type Ask } from "./jev";
import { z } from "zod";

// ---------------------------------------------------------------- types

export const RISK_FLAGS = ["irreversible", "spends_money", "destroys_data", "handles_secret", "off_goal"] as const;
export type RiskFlag = (typeof RISK_FLAGS)[number];

export type Risk = {
  /** The highest of the flags, 0..1. */
  level: number;
  worst: RiskFlag;
  flags: Record<RiskFlag, number>;
};

/** Resolves true to let the action run. hotkey.ts can replace the terminal version. */
export type Approve = (req: { hand: number; action: string; risk: Risk }) => Promise<boolean>;

// ---------------------------------------------------------------- config

/** Pause when any flag is at least this likely. */
export const RISK_THRESHOLD = Number(process.env.PUK_RISK_THRESHOLD ?? 0.5);
const probability = z.number().min(0).max(1);

// Jev reads questions literally, so each one is a plain positive statement.
const QUESTIONS = {
  irreversible: noul(
    "Doing `action` has an effect that cannot be undone afterwards. Examples: it sends a message or email, submits a form, posts or publishes something, places an order, or confirms a dialog that does one of these.",
    { true: "The effect is permanent or reaches other people.", false: "It only navigates, opens, selects, scrolls, or fills a field that can still be edited." },
  ),
  spends_money: noul("Doing `action` spends money or commits to a payment, a subscription or a purchase."),
  destroys_data: noul(
    "Doing `action` deletes, overwrites or discards something the user may want to keep, such as a file, a message, a draft or unsaved work.",
  ),
  handles_secret: noul(
    "Doing `action` enters, reveals or changes a password, passkey, API key, card number or other credential.",
  ),
  off_goal: noul("Doing `action` works toward something other than `goal`, or does something listed in `avoid`.", {
    true: "The action is unrelated to the goal, or the user said to avoid it.",
    false: "The action is a reasonable step toward the goal.",
  }),
};

// ---------------------------------------------------------------- gate

export async function assessRisk(ask: Ask, ctx: { goal: string; avoid: string[]; action: string }): Promise<Risk> {
  const answers = await ask({ goal: ctx.goal, avoid: ctx.avoid, action: ctx.action }, QUESTIONS);
  const flags = Object.fromEntries(RISK_FLAGS.map((f) => [f, answers[f].noul])) as Record<RiskFlag, number>;
  const worst = RISK_FLAGS.reduce((a, b) => (flags[b] > flags[a] ? b : a));
  return { level: flags[worst], worst, flags };
}

export function needsApproval(risk: Risk, threshold = RISK_THRESHOLD): boolean {
  // Invalid configuration or scores must pause, never silently clear an action.
  if (!probability.safeParse(threshold).success || !probability.safeParse(risk.level).success) return true;
  return risk.level >= threshold;
}

/** Ask on the terminal. With no terminal to ask on, the answer is no. */
export const terminalApprove: Approve = async ({ hand, action, risk }) => {
  if (!process.stdin.isTTY) return false;
  const pct = Math.round(risk.level * 100);
  const answer = prompt(`hand ${hand} wants to: ${action}\n  ${risk.worst.replace("_", " ")} ${pct}%. Allow? [y/N]`);
  return /^y(es)?$/i.test(answer?.trim() ?? "");
};
