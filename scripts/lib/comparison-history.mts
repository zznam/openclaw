import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// History-sensitive guards must not mistake a shallow boundary for an introduction.
export function requireComparisonHistory(root: string, base: string): void {
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    git("merge-base", "--is-ancestor", base, "HEAD");
    const shallow = git("rev-parse", "--is-shallow-repository");
    if (shallow !== "true" && shallow !== "false") {
      throw new Error("Invalid shallow-repository state");
    }
    if (shallow === "true") {
      const shallowPath = git("rev-parse", "--git-path", "shallow");
      const boundaries = new Set(
        fs.readFileSync(path.resolve(root, shallowPath), "utf8").split(/\s+/u),
      );
      const interval = git("rev-list", `${base}..HEAD`).split(/\s+/u);
      if (interval.some((commit) => boundaries.has(commit))) {
        throw new Error("Shallow boundary inside comparison interval");
      }
    }
  } catch {
    throw new Error(
      "Complete comparison history is required; fetch reachable base and HEAD ancestry before running history guards.",
    );
  }
}
