import { expect, test } from "bun:test";
import { browserStorageReason, shellDescription } from "./shell-policy";

test("browser-account recovery cannot mine profile stores through common shell spellings", () => {
  for (const command of [
    'Get-ChildItem "C:\\Users\\test\\AppData\\Local\\Google\\Chrome\\User Data" -Recurse',
    'wsl grep name /mnt/c/Users/test/AppData/Local/Microsoft/Edge/User\\ Data/Default',
    'cp ~/.config/google-chrome/Default/History /tmp/history',
    'cat ~/.mozilla/firefox/profile/logins.json',
    'Get-Content "Login Data"',
    'sqlite3 "Web Data" "select * from autofill"',
  ]) expect(browserStorageReason(command)).toContain("visible contacts");
  expect(browserStorageReason("Get-ChildItem", "C:\\Users\\test\\AppData\\Local\\Google\\Chrome\\User Data")).toBeDefined();
  for (const command of ['Get-Content .\\report.csv', 'rg "Chrome" src', 'git status --short', 'bun test']) expect(browserStorageReason(command)).toBeUndefined();
});

test("the shell contract names the actual interpreter", () => {
  expect(shellDescription("PowerShell")).toContain("this is NOT Bash");
  expect(shellDescription("PowerShell")).toContain("native PowerShell syntax");
  expect(shellDescription("Bash")).toContain("Use Bash syntax");
});
