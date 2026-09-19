/** The writer model: the only place free text is generated, when the classifier asks for it and once when the run ends. */

import type { ImageContent, TextContent, ThinkingLevel } from "@earendil-works/pi-ai";
import sharp from "sharp";
import { answerModel, thinking, writerModel } from "./config.ts";
import { nowContext } from "./dates.ts";
import { onPayload, resolveModel, runtime } from "./llm.ts";
import { type Capture, fieldSummary, type Item, type Screen } from "./models.ts";
import { nearField } from "./perception.ts";

export interface WriterRequest {
  system: string;
  packet: object;
  properties: Record<string, { type: "boolean" | "string" }>;
  model?: string; // provider/model; the per-step writer model when left out
  image?: Capture;
}
/** One structured reply: an object holding every key of `properties`. */
export type Writer = (request: WriterRequest) => Promise<Record<string, unknown>>;

export const ANSWER_IMAGE_EDGE = 1568; // the longest edge a vision model reads without shrinking the image itself

/** A writer, or null when the writer model's provider has no credentials. */
export async function makeWriter(): Promise<Writer | null> {
  const provider = writerModel().split("/")[0]!;
  return (await runtime()).hasConfiguredAuth(provider) ? structured : null;
}

async function structured({ system, packet, properties, model, image }: WriterRequest): Promise<Record<string, unknown>> {
  const shape = Object.entries(properties).map(([key, { type }]) => `${JSON.stringify(key)}: ${type}`);
  const content: (TextContent | ImageContent)[] = [{ type: "text", text: JSON.stringify(packet) }];
  if (image) content.unshift(await imageBlock(image));
  const reply = await (await runtime()).completeSimple(
    await resolveModel(model ?? writerModel()),
    {
      systemPrompt: `${system}\n\nReply with one JSON object and nothing else, holding exactly these keys: {${shape.join(", ")}}.`,
      messages: [{ role: "user", content, timestamp: Date.now() }],
    },
    { reasoning: thinking() as ThinkingLevel, onPayload },
  );
  if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage || `writer ${reply.stopReason}`);
  return parseReply(reply.content.map((block) => (block.type === "text" ? block.text : "")).join(""), Object.keys(properties));
}

/** The object in a reply, whatever prose or code fence the model wrapped around it. */
export function parseReply(reply: string, keys: string[]): Record<string, unknown> {
  const [start, end] = [reply.indexOf("{"), reply.lastIndexOf("}")];
  if (start < 0 || end < start) throw new Error(`writer replied without JSON: ${reply.slice(0, 120)}`);
  const data = JSON.parse(reply.slice(start, end + 1)) as Record<string, unknown>;
  const missing = keys.filter((key) => !(key in data));
  if (missing.length) throw new Error(`writer reply is missing ${missing.join(", ")}`);
  return data;
}

/** The capture as a PNG the model can read. PNG because screen text does not survive JPEG well. */
async function imageBlock(image: Capture): Promise<ImageContent> {
  const png = await sharp(image.path).resize(ANSWER_IMAGE_EDGE, ANSWER_IMAGE_EDGE, { fit: "inside", withoutEnlargement: true }).png().toBuffer();
  return { type: "image", data: png.toString("base64"), mimeType: "image/png" };
}

/** The exact string to type into the focused field. Empty means the writer declined. */
export async function composeText(writer: Writer, goal: string, screen: Screen, items: Item[], history: string[]): Promise<string> {
  const data = await writer({
    system:
      "You fill in one text field on a user's screen. You receive the user's goal, recent " +
      "actions, the focused field's label and placeholder, and nearby screen text. Decide the " +
      "exact string to type. Never invent credentials, passwords, or personal data; for such " +
      "fields, or when the field should not be filled, set fill to false.",
    packet: {
      goal,
      now: nowContext(),
      frontmost_app: screen.app,
      previous_actions: history.slice(-8),
      focused_field: screen.field ? fieldSummary(screen.field) : null,
      text_near_field: nearField(screen, items),
      all_screen_text: items.map((it) => it.text).slice(0, 120),
    },
    properties: { fill: { type: "boolean" }, text: { type: "string" }, reason: { type: "string" } },
  });
  return data.fill ? String(data.text).trim() : "";
}

export function validUrl(url: string): boolean {
  if (/\s/.test(url)) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.host.includes(".");
  } catch {
    return false;
  }
}

/** The URL to open for this goal. Empty means no sensible site, or an invalid proposal. */
export async function composeUrl(writer: Writer, goal: string, history: string[]): Promise<string> {
  const data = await writer({
    system:
      "Given a user's goal for their web browser, give the single best https URL to open first. " +
      "Prefer the site's homepage or the most direct public page. If no website is implied, set ok to false.",
    packet: { goal, now: nowContext(), previous_actions: history.slice(-8) },
    properties: { ok: { type: "boolean" }, url: { type: "string" }, reason: { type: "string" } },
  });
  const url = data.ok ? String(data.url).trim() : "";
  return validUrl(url) ? url : "";
}

export interface Answer {
  text: string;
  achieved: boolean; // whether the screen itself shows the goal reached, in the writer's judgement
}

/**
 * What to tell the user now that the run is over: the result when the screen holds it, where things stand when not.
 *
 * The classifier can stop on the right page but cannot say what the page says. The writer reads the
 * capture itself as well as its text, since OCR misreads a letter here and there and drops layout.
 */
export async function composeAnswer(writer: Writer, goal: string, screen: Screen, items: Item[], history: string[], stopped: string): Promise<Answer> {
  const data = await writer({
    system:
      "An agent drove a user's computer toward the user's goal and has now stopped. You receive " +
      "the goal, the actions it took, why it stopped, a capture of the screen as it is now, and " +
      "the text read from that screen. Tell the user the result. When the goal asks for " +
      "information, lead with that information, taken only from the screen: never from memory, " +
      "and never a guess. When the goal asks for something to be done, say whether the screen " +
      "shows it done. When the screen does not hold the result, say so plainly, then say what is " +
      "on screen and the one next step that would get there. Trust the capture over the text " +
      "where the two disagree. Plain text, no markdown, four sentences at most. Set achieved to " +
      "true only when the screen itself shows the goal reached.",
    packet: {
      goal,
      now: nowContext(),
      why_the_run_stopped: stopped,
      actions_taken: history,
      frontmost_app: screen.app,
      browser_active_tab_url: screen.url,
      screen_text_in_reading_order: items.map((it) => it.text),
    },
    properties: { achieved: { type: "boolean" }, answer: { type: "string" } },
    model: answerModel(),
    image: screen.image,
  });
  return { text: String(data.answer).trim(), achieved: Boolean(data.achieved) };
}
