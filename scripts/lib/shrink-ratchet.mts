import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Owns file-backed baselines and the per-file count ratchet lifecycle, including
// base allowances, verified renames, pruning, and deterministic failure/shrink guidance.
// The chained-assertion ledger stays in type-assertion-guard-scope.mjs: it is live scope policy
// loaded by plain-JS oxlint, not a baseline, and folding it here would couple oxlint to git/fs.

export type RatchetCountDelta = { allowed: number; current: number; entry: string };

const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const compareEntries = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

export function parseRatchetArgs(argv: string[]) {
  const args: { base?: string; mergeBase: boolean; prune: boolean; staged: boolean } = {
    mergeBase: true,
    prune: false,
    staged: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--prune") {
      args.prune = true;
      continue;
    }
    if (arg === "--staged") {
      args.staged = true;
      continue;
    }
    if (arg === "--no-merge-base") {
      args.mergeBase = false;
      continue;
    }
    if (arg === "--base" && argv[index + 1]) {
      args.base = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error("Unknown or incomplete argument: " + arg);
  }
  if (!args.mergeBase && !args.base) {
    throw new Error("--no-merge-base requires --base <prepared-ref>");
  }
  return args;
}

function readGitText(root: string, args: string[]) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-ratchet-git-"));
  const output = path.join(temporary, "stdout");
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(output, "wx", 0o600);
    // Baseline blobs can exceed execFileSync's pipe limit. Git writes directly
    // to a file; only a successful command may supply the complete snapshot.
    execFileSync("git", args, { cwd: root, stdio: ["ignore", descriptor, "ignore"] });
    return fs.readFileSync(output, "utf8");
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function resolvesCommit(root: string, ref: string) {
  try {
    execFileSync("git", ["rev-parse", "--verify", ref + "^{commit}"], {
      cwd: root,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

export function resolveRatchetBase(
  root: string,
  options: { base?: string; staged: boolean; mergeBase?: boolean },
) {
  if (options.mergeBase === false && !options.base) {
    throw new Error("--no-merge-base requires --base <prepared-ref>");
  }
  const resolved =
    options.base ??
    (options.staged ? ["HEAD"] : ["origin/main", "HEAD"]).find((ref) => resolvesCommit(root, ref));
  if (!resolved) {
    return null;
  }
  if (!resolvesCommit(root, resolved)) {
    throw new Error(`Could not resolve ratchet base ref: ${resolved}`);
  }
  // CI owns an immutable comparison commit even when depth-one tips cannot
  // traverse to it. Only an explicit prepared-base invocation skips ancestry.
  if (options.staged || options.mergeBase === false) {
    return resolved;
  }

  // Branches own their grandfathered debt from the fork. Comparing against a
  // moving base tip turns unrelated cleanup there into a local expansion.
  try {
    return readGitText(root, ["merge-base", "HEAD", resolved]).trim();
  } catch {
    throw new Error(
      `Could not resolve ratchet merge base for ${resolved}; provide reachable history or --base <prepared-ref> --no-merge-base.`,
    );
  }
}

export function loadRatchetSnapshot<T>(
  root: string,
  baselinePath: string,
  staged: boolean,
  parse: (source: string) => T,
) {
  const source = staged
    ? readGitText(root, ["show", ":" + baselinePath])
    : fs.readFileSync(path.join(root, baselinePath), "utf8");
  return parse(source);
}

export function loadRatchetReference<T>(
  root: string,
  ref: string,
  baselinePath: string,
  parse: (source: string) => T,
) {
  const entry = readGitText(root, ["ls-tree", "--name-only", ref, "--", baselinePath]).trim();
  return entry === baselinePath
    ? parse(readGitText(root, ["show", ref + ":" + baselinePath]))
    : null;
}

export function loadRatchetSources(root: string, filePaths: string[], ref = "") {
  if (filePaths.length === 0) {
    return new Map<string, string>();
  }
  const output = execFileSync("git", ["cat-file", "--batch", "-z"], {
    cwd: root,
    input: filePaths.map((filePath) => ref + ":" + filePath).join("\0") + "\0",
    maxBuffer: GIT_MAX_BUFFER,
  });
  const sources = new Map<string, string>();
  let offset = 0;
  // `-z` frames requests only; each response still has a newline header and payload terminator.
  for (const filePath of filePaths) {
    const headerEnd = output.indexOf(10, offset);
    if (headerEnd < 0) {
      throw new Error("Invalid git cat-file response for " + filePath);
    }
    // Missing responses echo the requested path, whose spaces/newlines can spoof a size.
    // Only a complete object header may frame source bytes.
    const header = output.subarray(offset, headerEnd).toString("utf8");
    const size = Number(/^[0-9a-f]+ (?:blob|tree|commit|tag) (\d+)$/u.exec(header)?.[1]);
    if (!Number.isSafeInteger(size)) {
      throw new Error("Could not read " + (ref || "staged") + " source " + filePath);
    }
    const sourceStart = headerEnd + 1;
    const sourceEnd = sourceStart + size;
    if (output[sourceEnd] !== 10) {
      throw new Error("Invalid git cat-file framing for " + filePath);
    }
    sources.set(filePath, output.subarray(sourceStart, sourceEnd).toString("utf8"));
    offset = sourceEnd + 1;
  }
  return sources;
}

export function listRatchetRenames(
  root: string,
  baseRef: string,
  staged: boolean,
  sourceRoots: string[],
) {
  const args = ["diff", "--name-status", "-z", "--find-renames"];
  if (staged) {
    args.push("--cached");
  }
  args.push(baseRef, "--", ...sourceRoots);
  const fields = execFileSync("git", args, { cwd: root, maxBuffer: GIT_MAX_BUFFER })
    .toString("utf8")
    .split("\0");
  const renames: { from: string; to: string }[] = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) {
      break;
    }
    const from = fields[index++];
    if (!status.startsWith("R") && !status.startsWith("C")) {
      continue;
    }
    const to = fields[index++];
    if (status.startsWith("R") && from && to) {
      renames.push({ from, to });
    }
  }
  return renames;
}

export function parseRatchetPaths(source: string) {
  return new Set(
    source
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#")),
  );
}

export function parseRatchetCounts(source: string, baselinePath: string) {
  const counts = new Map<string, number>();
  for (const rawLine of source.split(/\r?\n/u)) {
    if (rawLine === "" || rawLine.startsWith("#")) {
      continue;
    }
    const separator = rawLine.lastIndexOf("\t");
    const entry = rawLine.slice(0, separator);
    const count = Number(rawLine.slice(separator + 1));
    if (separator <= 0 || !Number.isSafeInteger(count) || count <= 0 || counts.has(entry)) {
      throw new Error(`Invalid ${baselinePath} entry: ${rawLine}`);
    }
    counts.set(entry, count);
  }
  return counts;
}

export function parseRatchetScalar(source: string, baselinePath: string) {
  const values = source
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const value = values[0];
  if (values.length !== 1 || value === undefined || !/^\d+$/u.test(value)) {
    throw new Error(`${baselinePath} must contain exactly one non-negative integer`);
  }
  return Number(value);
}

export function compareRatchetSets(
  current: Iterable<string>,
  allowed: ReadonlySet<string>,
  compare: (left: string, right: string) => number = compareEntries,
) {
  const currentSet = new Set(current);
  return {
    added: [...currentSet].filter((entry) => !allowed.has(entry)).toSorted(compare),
    removed: [...allowed].filter((entry) => !currentSet.has(entry)).toSorted(compare),
  };
}

export function compareRatchetCounts(
  current: ReadonlyMap<string, number>,
  allowed: ReadonlyMap<string, number>,
) {
  return {
    increased: collectRatchetDeltas(current, allowed, true),
    decreased: collectRatchetDeltas(allowed, current, false),
  };
}

function collectRatchetDeltas(
  entries: ReadonlyMap<string, number>,
  counterpart: ReadonlyMap<string, number>,
  increased: boolean,
) {
  return [...entries]
    .flatMap(([entry, count]): RatchetCountDelta[] => {
      const other = counterpart.get(entry) ?? 0;
      return count > other
        ? [{ allowed: increased ? other : count, current: increased ? count : other, entry }]
        : [];
    })
    .toSorted((left, right) => compareEntries(left.entry, right.entry));
}

function formatRatchetMessage(title: string, entries: readonly string[]) {
  return [title, ...entries.map((entry) => "  " + entry)].join("\n");
}

export function reportRatchetFailures(
  groups: readonly { entries: readonly string[]; title: string }[],
  guidance?: string,
) {
  const active = groups.filter((group) => group.entries.length > 0);
  for (const group of active) {
    console.error(formatRatchetMessage(group.title, group.entries));
  }
  if (active.length > 0 && guidance) {
    console.error(guidance);
  }
  return active.length > 0;
}

type PerFileCountRatchetOptions = {
  baselinePath: string;
  baselineHeader: string;
  renameSourceRoots: string[];
  collectCurrent: (options: { staged: boolean }) => ReadonlyMap<string, number>;
  // Throws when the file is missing at ref.
  countAtRef: (ref: string, filePath: string) => number;
  messages: {
    increaseTitle: string;
    expansionTitle: string;
    guidance: string;
    countNoun: string;
    successTitle: string;
  };
};

function formatBaseline(counts: ReadonlyMap<string, number>, header: string) {
  const entries = [...counts]
    .filter(([, count]) => count > 0)
    .toSorted(([left], [right]) => compareEntries(left, right))
    .map(([filePath, count]) => `${filePath}\t${count}`);
  return header + entries.join("\n") + (entries.length > 0 ? "\n" : "");
}

// Aggregate diffs across long imports can exceed Git's rename candidate limit.
// Follow only apparent new allowances through small committed rename boundaries;
// never infer identity by hiding competing sources from the aggregate diff.
function committedRatchetRename(
  root: string,
  baseRef: string,
  staged: boolean,
  destination: string,
  baseBaseline: ReadonlyMap<string, number>,
  sourceRoots: string[],
): string | undefined {
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: GIT_MAX_BUFFER,
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
    });
  try {
    git("merge-base", "--is-ancestor", baseRef, "HEAD");
    if (git("rev-parse", "--is-shallow-repository").trim() === "true") {
      return undefined;
    }
    // A committed history cannot vouch for edited worktree/index contents.
    git(
      "diff",
      "--quiet",
      ...(staged ? ["--cached"] : []),
      "HEAD",
      "--",
      `:(literal)${destination}`,
    );
    let tip = "HEAD";
    let cursor = destination;
    for (let hop = 0; hop < 16; hop++) {
      const commit = git(
        "-c",
        "diff.renameLimit=256",
        "log",
        "-1",
        "--follow",
        "--find-renames",
        "--diff-filter=AR",
        "--format=%H",
        `${baseRef}..${tip}`,
        "--",
        `:(literal)${cursor}`,
      ).trim();
      if (!/^[0-9a-f]{40,64}$/u.test(commit)) {
        return undefined;
      }
      const parents = git("show", "-s", "--format=%P", commit).trim().split(/\s+/u);
      if (parents.length !== 1 || !parents[0]) {
        return undefined;
      }
      const parent = parents[0];
      const candidates = git(
        "diff",
        "--no-renames",
        "--diff-filter=AD",
        "--name-only",
        "-z",
        parent,
        commit,
        "--",
        ...sourceRoots,
      )
        .split("\0")
        .filter(Boolean);
      // At most 256 squared similarity comparisons, even for adversarial history.
      if (candidates.length > 512) {
        return undefined;
      }
      const renameArgs = [
        "-c",
        "diff.renameLimit=256",
        "diff",
        "--name-status",
        "-z",
        "--find-renames",
        parent,
        commit,
        "--",
        ...sourceRoots,
      ];
      const fields = git(...renameArgs).split("\0");
      let from: string | undefined;
      for (let index = 0; index < fields.length;) {
        const status = fields[index++];
        const oldPath = fields[index++];
        if (status?.startsWith("R") || status?.startsWith("C")) {
          const newPath = fields[index++];
          if (status.startsWith("R") && newPath === cursor) {
            from = oldPath;
          }
        }
      }
      if (!from) {
        return undefined; // Additions, copies, and recreation do not carry an allowance.
      }
      // If another deleted source can explain the destination, identity is ambiguous.
      const alternatives = git(...renameArgs, `:(exclude,literal)${from}`).split("\0");
      for (let index = 0; index < alternatives.length;) {
        const status = alternatives[index++];
        index++;
        if (status?.startsWith("R") || status?.startsWith("C")) {
          if (alternatives[index++] === cursor) {
            return undefined;
          }
        }
      }
      if (baseBaseline.has(from)) {
        // A fork-only base need not be an ancestor of an imported upstream rename.
        // Its source must still be exactly the source inherited at their common base.
        const common = git("merge-base", "--all", baseRef, parent).trim();
        if (!/^[0-9a-f]{40,64}$/u.test(common)) {
          return undefined;
        }
        const inherited = git("rev-parse", "--verify", `${common}:${from}`).trim();
        if (git("rev-parse", "--verify", `${baseRef}:${from}`).trim() !== inherited) {
          return undefined;
        }
        const retained = staged
          ? git("ls-files", "--stage", "-z", "--", `:(literal)${from}`).length > 0
          : fs.existsSync(path.join(root, from));
        return retained ? undefined : from;
      }
      cursor = from;
      tip = parent;
    }
  } catch {
    // Missing/ambiguous history is not evidence for transferring an allowance.
  }
  return undefined;
}

function baselineWithVerifiedRenames(
  root: string,
  baseRef: string,
  staged: boolean,
  baseline: ReadonlyMap<string, number>,
  baseBaseline: ReadonlyMap<string, number>,
  sourceRoots: string[],
) {
  const allowed = new Map(baseBaseline);
  const renames = listRatchetRenames(root, baseRef, staged, sourceRoots);
  const directDestinations = new Set(renames.map(({ to }) => to));
  const claimedSources = new Set(renames.map(({ from }) => from));
  for (const [to, count] of baseline) {
    if (count <= (baseBaseline.get(to) ?? 0) || directDestinations.has(to)) {
      continue;
    }
    const from = committedRatchetRename(root, baseRef, staged, to, baseBaseline, sourceRoots);
    if (from && !claimedSources.has(from)) {
      renames.push({ from, to });
      claimedSources.add(from);
    }
  }
  for (const { from, to } of renames) {
    const oldCount = baseBaseline.get(from);
    const newCount = baseline.get(to);
    if (
      oldCount !== undefined &&
      newCount !== undefined &&
      newCount <= oldCount &&
      !baseline.has(from)
    ) {
      allowed.delete(from);
      allowed.set(to, oldCount);
    }
  }
  return allowed;
}

function allowanceWithExistingBaseCounts(
  baseRef: string,
  proposed: ReadonlyMap<string, number>,
  allowed: ReadonlyMap<string, number>,
  countAtRef: PerFileCountRatchetOptions["countAtRef"],
) {
  const effective = new Map(allowed);
  for (const [filePath, count] of proposed) {
    if (count <= (effective.get(filePath) ?? 0)) {
      continue;
    }
    try {
      const baseCount = countAtRef(baseRef, filePath);
      if (baseCount > (effective.get(filePath) ?? 0)) {
        effective.set(filePath, baseCount);
      }
    } catch {
      // Missing base paths are branch additions and receive no allowance.
    }
  }
  return effective;
}

function formatDeltas(entries: RatchetCountDelta[], comparison: ">" | "<") {
  return entries.map((entry) => `${entry.entry}: ${entry.current} ${comparison} ${entry.allowed}`);
}

function totalCount(counts: ReadonlyMap<string, number>) {
  return [...counts.values()].reduce((total, count) => total + count, 0);
}

export function runPerFileCountRatchet(
  root: string,
  argv: string[],
  options: PerFileCountRatchetOptions,
) {
  const { baselinePath, messages } = options;
  const parseBaseline = (source: string) => parseRatchetCounts(source, baselinePath);
  const writeBaseline = (counts: ReadonlyMap<string, number>) =>
    fs.writeFileSync(path.join(root, baselinePath), formatBaseline(counts, options.baselineHeader));
  try {
    const args = parseRatchetArgs(argv);
    if (args.staged && args.prune) {
      throw new Error("--prune cannot be combined with --staged");
    }

    const baseRef = resolveRatchetBase(root, args);
    const baseBaseline = baseRef
      ? loadRatchetReference(root, baseRef, baselinePath, parseBaseline)
      : null;
    const current = options.collectCurrent({ staged: args.staged });

    let baseline;
    try {
      baseline = loadRatchetSnapshot(root, baselinePath, args.staged, parseBaseline);
    } catch {
      if (args.prune && !args.staged && baseBaseline === null) {
        writeBaseline(current);
        console.log(
          `Initialized ${baselinePath}: ${current.size} files, ${totalCount(current)} ${messages.countNoun}.`,
        );
        return 0;
      }
      throw new Error("Missing " + baselinePath + (args.staged ? " in the index" : ""));
    }

    if (args.prune && !args.staged && baseBaseline === null) {
      writeBaseline(current);
      console.log(
        `Refreshed initial ${baselinePath}: ${current.size} files, ${totalCount(current)} ${messages.countNoun}.`,
      );
      return 0;
    }
    const allowedBaseline =
      baseRef && baseBaseline
        ? baselineWithVerifiedRenames(
            root,
            baseRef,
            args.staged,
            baseline,
            baseBaseline,
            options.renameSourceRoots,
          )
        : baseBaseline;
    const currentAllowance =
      baseRef && baseBaseline
        ? allowanceWithExistingBaseCounts(baseRef, current, baseline, options.countAtRef)
        : baseline;
    const expansionAllowance =
      baseRef && allowedBaseline
        ? allowanceWithExistingBaseCounts(baseRef, baseline, allowedBaseline, options.countAtRef)
        : allowedBaseline;
    const increases = compareRatchetCounts(current, currentAllowance).increased;
    const expanded = expansionAllowance
      ? compareRatchetCounts(baseline, expansionAllowance).increased
      : [];

    if (
      reportRatchetFailures(
        [
          {
            entries: formatDeltas(increases, ">"),
            title: messages.increaseTitle,
          },
          {
            entries: formatDeltas(expanded, ">"),
            title: messages.expansionTitle,
          },
        ],
        messages.guidance,
      )
    ) {
      return 1;
    }

    if (args.prune) {
      const oldFiles = baseline.size;
      const oldCount = totalCount(baseline);
      writeBaseline(current);
      console.log(
        `Pruned ${baselinePath}: ${oldFiles} -> ${current.size} files; ${oldCount} -> ${totalCount(current)} ${messages.countNoun}.`,
      );
      return 0;
    }

    const stale = compareRatchetCounts(current, baseline).decreased;
    if (
      reportRatchetFailures([
        {
          entries: formatDeltas(stale, "<"),
          title: `Shrink ${baselinePath} entries (or run with --prune):`,
        },
      ])
    ) {
      return 1;
    }

    console.log(
      `${messages.successTitle}: ${current.size} files, ${totalCount(current)} grandfathered ${messages.countNoun}.`,
    );
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
