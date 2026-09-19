import { expect, test } from "bun:test";
import { refusal } from "./web";

test("a rate limit or a captcha is a refusal, not an empty result", () => {
  expect(refusal(429, "")).toBe(true);
  expect(refusal(403, "<html>Forbidden</html>")).toBe(true);
  expect(refusal(200, "<p>Your request has been flagged as being suspicious and Brave Search decided to schedule a captcha</p>")).toBe(true);
});

test("a page of results is not a refusal, even when a result mentions captchas", () => {
  expect(refusal(200, `<div class="snippet" data-type="web"><a href="https://example.org">How a captcha works</a></div>`)).toBe(false);
  expect(refusal(200, "<html><body>No results found</body></html>")).toBe(false);
});
