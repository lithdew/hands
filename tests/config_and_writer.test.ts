import { expect, test } from "bun:test";
import { parseReply, validUrl } from "../src/writer.ts";

// test_dotenv_sets_only_missing_keys and test_dotenv_missing_file_is_fine have no port: config.ts has no load_dotenv, Bun loads .env itself.

test("valid url", () => {
  expect(validUrl("https://www.cnn.com")).toBe(true);
  expect(validUrl("https://news.ycombinator.com/newest")).toBe(true);
  expect(validUrl("http://www.cnn.com")).toBe(false);
  expect(validUrl("https://localhost")).toBe(false);
  expect(validUrl("https://www.cnn.com/a b")).toBe(false);
  expect(validUrl("")).toBe(false);
});

test("parse reply finds the object inside prose and a code fence", () => {
  const reply = 'Here is the URL you asked for:\n```json\n{"ok": true, "url": "https://www.brunomars.com", "reason": "the artist\'s own site"}\n```\nAnything else?';
  expect(parseReply(reply, ["ok", "url"])).toEqual({ ok: true, url: "https://www.brunomars.com", reason: "the artist's own site" });
  expect(parseReply('{"fill": false}', ["fill"])).toEqual({ fill: false });
});

test("parse reply refuses a reply that is missing a key, or holds no object at all", () => {
  expect(() => parseReply('{"ok": true}', ["ok", "url"])).toThrow("writer reply is missing url");
  expect(() => parseReply("I cannot help with that.", ["ok"])).toThrow("writer replied without JSON");
  expect(() => parseReply("{not json}", ["ok"])).toThrow(SyntaxError);
});
