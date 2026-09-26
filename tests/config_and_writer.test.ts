import { afterEach, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { documentsFolder, profilePath, shellFolder, workFolder } from "../src/config.ts";
import { parseReply, validUrl } from "../src/writer.ts";

// test_dotenv_sets_only_missing_keys and test_dotenv_missing_file_is_fine have no port: config.ts has no load_dotenv, Bun loads .env itself.

afterEach(() => {
  delete process.env.HANDS_WORK;
  delete process.env.HANDS_PROFILE;
});

test("the hands of `hands live` keep what they make in Documents/Hands, and the voice's notes on the user in ~/.hands, unless told otherwise", () => {
  delete process.env.HANDS_WORK;
  delete process.env.HANDS_PROFILE;
  expect(workFolder()).toBe(join(documentsFolder(), "Hands"));
  if (process.platform !== "win32") expect(documentsFolder()).toBe(join(homedir(), "Documents"));
  expect(profilePath()).toBe(join(homedir(), ".hands", "profile.md"));
  process.env.HANDS_WORK = join("D:", "elsewhere");
  process.env.HANDS_PROFILE = join("D:", "me.md");
  expect(workFolder()).toBe(join("D:", "elsewhere"));
  expect(profilePath()).toBe(join("D:", "me.md"));
});

test("on Windows, Documents is where the user's shell folders say, OneDrive's included, and its variables are filled in", () => {
  const query = (value: string, type = "REG_EXPAND_SZ") => `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders\r\n    Personal    ${type}    ${value}\r\n\r\n`;
  const env = { USERPROFILE: "C:\\Users\\ishaa", OneDrive: "C:\\Users\\ishaa\\OneDrive" };
  expect(shellFolder(query("%USERPROFILE%\\OneDrive\\Documents"), env)).toBe("C:\\Users\\ishaa\\OneDrive\\Documents");
  expect(shellFolder(query("%onedrive%\\Documents"), env)).toBe("C:\\Users\\ishaa\\OneDrive\\Documents"); // Windows' variables are one in any case
  expect(shellFolder(query("D:\\My Documents", "REG_SZ"), env)).toBe("D:\\My Documents");
  expect(shellFolder(query("\\\\server\\home\\Documents"), env)).toBe("\\\\server\\home\\Documents");
  expect(shellFolder(query("%HOMESHARE%\\Documents"), env)).toBeNull(); // a variable that is not set: the profile's own folder, then
  expect(shellFolder(query("Documents"), env)).toBeNull();
  expect(shellFolder("ERROR: The system was unable to find the specified registry key or value.", env)).toBeNull();
  if (process.platform === "win32") expect(documentsFolder()).toMatch(/^(?:[A-Za-z]:\\|\\\\)/);
});

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
