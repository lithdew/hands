import { describe, expect, test } from "bun:test";
import { foregroundOf, loginPage, seenByUser, loginTargets, parseDevToolsFile, signedInSites, signInWall, wallInTexts, type SeenWindow } from "./session";

describe("signInWall", () => {
  test("Google's sign-in pages, with the command that fixes it for this hand", () => {
    const wall = signInWall("https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fmail.google.com%2Fmail%2F&service=mail", "Gmail", 1);
    expect(wall).toEqual({ site: "Google", how: "Hand 1's browser is not signed in to Google. Run `bun win/desktop.ts login 1` and sign in once." });
    expect(signInWall("https://accounts.google.com/ServiceLogin?service=memento", "Sign in - Google Accounts", 2)?.how).toContain("login 2");
    expect(signInWall("https://accounts.google.com/v3/signin/challenge/pwd?x=1", "")?.site).toBe("Google");
    expect(signInWall("https://accounts.google.com/v3/signin/rejected", "Couldn't sign you in")?.site).toBe("Google");
    expect(signInWall("https://accounts.google.co.uk/signin/v2/identifier", "")?.site).toBe("Google");
  });
  test("without a hand the message still names the command", () => {
    expect(signInWall("https://accounts.google.com/ServiceLogin", "")?.how).toBe("This hand's browser is not signed in to Google. Run `bun win/desktop.ts login` and sign in once.");
  });
  test("the brochure Google shows a signed-out visitor instead of Gmail or Drive", () => {
    expect(signInWall("https://www.google.com/intl/en-US/gmail/about/", "Gmail: Private and secure email")?.site).toBe("Google");
    expect(signInWall("https://workspace.google.com/intl/en-US/gmail/", "Gmail")?.site).toBe("Google");
    expect(signInWall("https://workspace.google.com/products/calendar/", "Google Calendar")?.site).toBe("Google");
  });
  test("pages a signed-in hand clicks through are not walls", () => {
    expect(signInWall("https://accounts.google.com/v3/signin/accountchooser?continue=x", "Sign in - Google Accounts")).toBeNull();
    expect(signInWall("https://accounts.google.com/o/oauth2/v2/auth/oauthchooseaccount?client_id=1", "Sign in - Google Accounts")).toBeNull();
    expect(signInWall("https://accounts.google.com/signin/oauth/consent?authuser=0", "Sign in - Google Accounts")).toBeNull();
    expect(signInWall("https://accounts.google.com/gsi/select?client_id=1", "Sign in - Google Accounts")).toBeNull();
  });
  test("being signed in is not a wall", () => {
    expect(signInWall("https://mail.google.com/mail/u/0/#inbox", "Inbox (3) - someone@gmail.com - Gmail")).toBeNull();
    expect(signInWall("https://myaccount.google.com/", "Google Account")).toBeNull();
    expect(signInWall("https://www.google.com/search?q=how+to+sign+in+to+gmail", "how to sign in to gmail - Google Search")).toBeNull();
    expect(signInWall("https://github.com/oven-sh/bun", "oven-sh/bun")).toBeNull();
    expect(signInWall("about:blank", "")).toBeNull();
  });
  test("Microsoft, and sites whose sign-in page has its own address", () => {
    expect(signInWall("https://login.live.com/login.srf?wa=wsignin1.0", "Sign in to your Microsoft account", 1)?.site).toBe("Microsoft");
    expect(signInWall("https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=1", "Sign in to your account")?.site).toBe("Microsoft");
    expect(signInWall("https://login.microsoftonline.com/common/oauth2/v2.0/logout", "Sign out")).toBeNull();
    expect(signInWall("https://github.com/login?return_to=%2Fsettings", "Sign in to GitHub")?.site).toBe("GitHub");
    expect(signInWall("https://www.linkedin.com/checkpoint/lg/login", "LinkedIn Login")?.site).toBe("LinkedIn");
    expect(signInWall("https://www.amazon.co.uk/ap/signin?openid=1", "Amazon Sign In")?.site).toBe("Amazon");
    expect(signInWall("https://x.com/i/flow/login", "Log in to X")?.site).toBe("X");
  });
  test("Google Messages asks for pairing, not a password", () => {
    const wall = signInWall("https://messages.google.com/web/authentication", "Messages for web", 1)!;
    expect(wall.site).toBe("Google Messages");
    expect(wall.how).toContain("login 1");
    expect(wall.how).toContain("pair");
    expect(signInWall("https://messages.google.com/web/conversations", "Messages for web")).toBeNull();
  });
  test("anywhere else it takes both the address and the title to say login", () => {
    expect(signInWall("https://app.example.com/login?next=%2Fhome", "Log in | Example")?.site).toBe("app.example.com");
    expect(signInWall("https://login.example.com/sign-in", "Sign in")?.site).toBe("example.com");
    expect(signInWall("https://example.com/auth/signin.php", "Example - Sign In")?.site).toBe("example.com");
    expect(signInWall("https://example.com/login", "Example: recipes for everyone")).toBeNull();
    expect(signInWall("https://example.com/blog/how-to-log-in-faster", "How to log in faster")).toBeNull();
    expect(signInWall("https://example.com/loginhelp", "Login help")).toBeNull();
  });
  test("with only a window title to go on, only the unmistakable ones", () => {
    expect(signInWall("", "Sign in - Google Accounts - Google Chrome", 1)?.site).toBe("Google");
    expect(signInWall("", "Sign in \u2013 Google Accounts")?.site).toBe("Google");
    expect(signInWall("", "Sign in to your account")?.site).toBe("Microsoft");
    expect(signInWall("", "Log in | Example")).toBeNull();
    expect(signInWall("not a url", "Inbox - Gmail")).toBeNull();
  });
});

describe("wallInTexts", () => {
  test("reads the address and title lines win/observe.ts writes", () => {
    const texts = ["page: Sign in - Google Accounts", "address: https://accounts.google.com/v3/signin/identifier?flowName=GlifWebSignIn", "Sign in", "Use your Google Account"];
    expect(wallInTexts(texts, 1)?.how).toBe("Hand 1's browser is not signed in to Google. Run `bun win/desktop.ts login 1` and sign in once.");
    expect(wallInTexts(["page: Capybara - Wikipedia", "address: https://en.wikipedia.org/wiki/Capybara"])).toBeNull();
    expect(wallInTexts([])).toBeNull();
  });
});

describe("signedInSites", () => {
  const now = 1_800_000_000;
  test("recognises a session by its cookie's name and domain", () => {
    expect(signedInSites([
      { name: "SID", domain: ".google.com", expires: now + 1000 },
      { name: "NID", domain: ".google.com", expires: now + 1000 },
      { name: "user_session", domain: "github.com", expires: -1 },
      { name: "li_at", domain: ".www.linkedin.com", expires: now + 5 },
    ], now)).toEqual(["Google", "GitHub", "LinkedIn"]);
  });
  test("a browser that only visited is signed in to nothing", () => {
    expect(signedInSites([{ name: "NID", domain: ".google.com", expires: now + 1000 }, { name: "_gh_sess", domain: "github.com" }, { name: "logged_in", domain: ".github.com", expires: now + 9 }], now)).toEqual([]);
  });
  test("expired cookies and look-alike domains do not count", () => {
    expect(signedInSites([{ name: "SID", domain: ".google.com", expires: now - 1 }, { name: "SID", domain: ".notgoogle.com", expires: now + 9 }, { name: "SID", domain: "google.com.evil.example", expires: now + 9 }], now)).toEqual([]);
  });
});

describe("foregroundOf", () => {
  const w = (containerId: number, app: string, title: string, focused = false, iconic = false): SeenWindow => ({ containerId, app, title, focused, iconic });
  test("the user's foreground window, without the browser's name on the end", () => {
    expect(foregroundOf([w(1, "chrome", "Inbox (3) - someone@gmail.com - Gmail - Google Chrome", true), w(2, "Code", "desktop.ts - puk - Visual Studio Code")]))
      .toEqual({ title: "Inbox (3) - someone@gmail.com - Gmail", app: "chrome", browser: true });
    expect(foregroundOf([w(1, "msedge", "Mail - Outlook and 2 more pages - Personal - Microsoft\u200b Edge", true)])?.title).toBe("Mail - Outlook and 2 more pages - Personal");
    expect(foregroundOf([w(1, "chrome", "Trip plan - Google Docs - Google Chrome - Work", true)])?.title).toBe("Trip plan - Google Docs");
    expect(foregroundOf([w(2, "Code", "desktop.ts - puk - Visual Studio Code", true)])).toEqual({ title: "desktop.ts - puk - Visual Studio Code", app: "Code", browser: false });
  });
  test("typing into Puk's panel: what they mean is the window right behind it", () => {
    const seen = [w(5, "chrome", "Puk \u00b7 Agent desktop - Google Chrome", true), w(9, "explorer", "Program Manager"), w(1, "chrome", "Inbox - Gmail - Google Chrome"), w(2, "Code", "x")];
    expect(foregroundOf(seen)?.title).toBe("Inbox - Gmail");
  });
  test("a hand's window, a minimized one and the shell are never it", () => {
    const seen = [w(7, "chrome", "about:blank - Google Chrome", true), w(3, "notepad", "notes.txt - Notepad", false, true), w(4, "explorer", ""), w(2, "Code", "x")];
    expect(foregroundOf(seen, new Set([7]))?.app).toBe("Code");
    expect(foregroundOf([w(7, "chrome", "about:blank - Google Chrome", true)], new Set([7]))).toBeNull();
  });
  test("nothing when the user is looking at a hand's desktop", () => {
    expect(foregroundOf([w(1, "chrome", "Inbox - Gmail - Google Chrome", true)], new Set(), "Puk hand 1")).toBeNull();
    expect(foregroundOf([w(1, "chrome", "Inbox - Gmail - Google Chrome", true)], new Set(), "Desktop 1")?.title).toBe("Inbox - Gmail");
  });
  test("what is behind it too, front to back: a terminal may be in front with Gmail right behind", () => {
    const seen = [w(2, "Code", "x"), w(8, "WindowsTerminal", "bun win/serve.ts", true), w(7, "chrome", "about:blank - Google Chrome"), w(1, "chrome", "Inbox - Gmail - Google Chrome")];
    expect(seenByUser(seen, new Set([7])).map((s) => s.title)).toEqual(["bun win/serve.ts", "Inbox - Gmail", "x"]);
    expect(seenByUser(seen, new Set(), "Puk bench")).toEqual([]);
  });
  test("without a focused window, the top of the stack", () => {
    expect(foregroundOf([w(1, "chrome", "A - Google Chrome"), w(2, "Code", "B")])?.title).toBe("A");
    expect(foregroundOf([])).toBeNull();
  });
});

describe("parseDevToolsFile", () => {
  test("the port, then the browser's own DevTools path", () => {
    expect(parseDevToolsFile("54302\r\n/devtools/browser/3f0c8a0e-1b2c-4d5e-8f90-aabbccddeeff\r\n")).toEqual({ port: 54302, browser: "/devtools/browser/3f0c8a0e-1b2c-4d5e-8f90-aabbccddeeff" });
  });
  test("anything else is no browser", () => {
    expect(parseDevToolsFile("")).toBeNull();
    expect(parseDevToolsFile("54302")).toBeNull();
    expect(parseDevToolsFile("0\n/devtools/browser/x")).toBeNull();
    expect(parseDevToolsFile("54302\n/devtools/page/x")).toBeNull();
    expect(parseDevToolsFile("54302\n/devtools/browser/x y")).toBeNull();
  });
});

describe("loginTargets", () => {
  test("nothing or all: the hands that exist, else the usual two", () => {
    expect(loginTargets([], [1, 2, 3])).toEqual([1, 2, 3]);
    expect(loginTargets(["all"], [])).toEqual([1, 2]);
    expect(loginTargets([""], [], 1)).toEqual([1]);
  });
  test("numbers, lists and the bench", () => {
    expect(loginTargets(["2"], [1, 2])).toEqual([2]);
    expect(loginTargets(["1,2", "2", "bench"], [])).toEqual([1, 2, 99]);
  });
  test("refuses what is not a hand", () => {
    expect(() => loginTargets(["gmail"], [1])).toThrow("not a hand");
    expect(() => loginTargets(["0"], [1])).toThrow("not a hand");
    expect(() => loginTargets(["1.5"], [1])).toThrow("not a hand");
  });
});

describe("loginPage", () => {
  test("says which hand this is and escapes what it is given", () => {
    const html = loginPage(2, [{ name: "A & <B>", url: "https://example.com/?a=1&b=\"2\"" }]);
    expect(html).toContain("hand 2");
    expect(html).toContain("close this window");
    expect(html).toContain("A &#38; &#60;B&#62;");
    expect(html).not.toContain("<B>");
    expect(html).toContain("https://example.com/?a=1&#38;b=&#34;2&#34;");
  });
});
