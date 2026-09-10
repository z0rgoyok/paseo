import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { realpath, access } from "node:fs/promises";
import { realpathSync, accessSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
const exec = promisify(execFile);
export interface WorktreeLocation { root: string; database: string; exportPath: string }
const gitArgs = (cwd: string) => ["-C", cwd, "rev-parse", "--path-format=absolute", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"];
function location(output: string, resolve: (path: string) => string): WorktreeLocation {
  const [rootPath, gitPath, commonPath] = output.trim().split("\n");
  if (!rootPath || !gitPath || !commonPath) throw new Error("Git did not return a worktree and git directory");
  const root = resolve(rootPath); const gitDir = resolve(gitPath); const common = resolve(commonPath);
  const key = createHash("sha256").update(gitDir).digest("hex");
  const directory = join(common, "cogerentor", "worktrees", key);
  return { root, database: join(directory, "team.sqlite"), exportPath: join(directory, "team-state.json") };
}
function absent(error: unknown): boolean { return String((error as { stderr?: unknown }).stderr).includes("not a git repository"); }
export async function locateWorktree(cwd: string): Promise<WorktreeLocation | null> {
  let directory: string;
  try { directory = await realpath(cwd); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const { stdout } = await exec("git", gitArgs(directory), { timeout: 5000, maxBuffer: 65536 });
    return location(stdout, realpathSync);
  } catch (error) { if (absent(error)) return null; throw error; }
}
/** streamAgent admits runs synchronously; do not turn that boundary into a lazy generator. */
export function locateWorktreeSync(cwd: string): WorktreeLocation | null {
  let directory: string;
  try { directory = realpathSync(cwd); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try { return location(execFileSync("git", gitArgs(directory), { encoding: "utf8", timeout: 5000, maxBuffer: 65536, stdio: ["ignore", "pipe", "pipe"] }), realpathSync); }
  catch (error) { if (absent(error)) return null; throw error; }
}
export async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
export function existsSync(path: string): boolean {
  try { accessSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
