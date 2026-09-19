import { execFile } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
type GitReader = (workspaceRoot: string, args: string[]) => Promise<string | null>;
export type RuntimeStartup = Readonly<{
  instanceId: string;
  pid: number;
  workspaceRoot: string;
  startedAt: string;
  git: Readonly<{ root: string; branch: string | null; commit: string; observedAt: string }> | null;
}>;
export type RuntimeIdentity = RuntimeStartup & Readonly<{ port: number }>;

const readGit: GitReader = async (workspaceRoot, args) => {
  try {
    // Read the checkout containing the source, not a GIT_DIR/WORK_TREE override.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
    const { stdout } = await execute("git", ["-C", workspaceRoot, ...args], {
      env: { ...env, GIT_OPTIONAL_LOCKS: "0" }, windowsHide: true, timeout: 1500, maxBuffer: 8192,
    });
    return stdout.trim();
  } catch { return null; }
};

/** Checkout metadata at startup, not a digest of executed or uncommitted files.
 * No remote URL, credentials, task contents, dirty filenames or diff is read. */
export async function runtimeStartup(workspace: string, git: GitReader = readGit): Promise<RuntimeStartup> {
  const workspaceRoot = resolve(workspace), instanceId = crypto.randomUUID(), startedAt = new Date().toISOString();
  let checkout: RuntimeStartup["git"] = null;
  try {
    const [root, commit, branch] = await Promise.all([
      git(workspaceRoot, ["rev-parse", "--show-toplevel"]),
      git(workspaceRoot, ["rev-parse", "--verify", "HEAD^{commit}"]),
      git(workspaceRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    ]);
    const path = root && isAbsolute(root) ? relative(root, workspaceRoot) : "..";
    if (root && commit && /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(commit)
      && path !== ".." && !path.startsWith(`..\\`) && !path.startsWith("../") && !isAbsolute(path)
      && (branch === null || branch.length > 0 && branch.length <= 1024 && !/[\x00-\x20\x7f]/.test(branch))) {
      // Reject mixed metadata if HEAD or the branch changed during startup.
      const [sameCommit, sameBranch] = await Promise.all([
        git(workspaceRoot, ["rev-parse", "--verify", "HEAD^{commit}"]),
        git(workspaceRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
      ]);
      if (commit === sameCommit && branch === sameBranch)
        checkout = Object.freeze({ root: resolve(root), branch, commit, observedAt: new Date().toISOString() });
    }
  } catch { /* Unknown metadata is explicit; startup still has a fresh identity. */ }
  return Object.freeze({ instanceId, pid: process.pid, workspaceRoot, startedAt, git: checkout });
}
