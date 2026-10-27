import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { requireComparisonHistory } from "./lib/comparison-history.mts";
import { scanClosedMockFactories } from "./lib/mock-factory-scan.mts";
import { createNativeTypeScriptParser } from "./lib/native-typescript.mts";
import {
  compareRatchetSets,
  loadRatchetReference,
  loadRatchetSnapshot,
  loadRatchetSources,
  parseRatchetArgs,
  reportRatchetFailures,
  resolveRatchetBase,
} from "./lib/shrink-ratchet.mts";
import { getImportGraphAliases, resolveImportSpecifiers } from "./test-projects.test-support.mts";

const BASELINE = "config/test-mock-exports-baseline.txt";
const MAX_BUFFER = 256 * 1024 * 1024;
const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const HEADER = [
  "# Exact first-party vi.mock/vi.doMock factories without real-module pass-through.",
  "# New factories require importOriginal/vi.importActual pass-through or an adjacent",
  "# // mock-isolation: reason annotation. Existing entries may only shrink.",
  "# JSON tuple: source path, specifier, factory/target SHA-256, duplicate ordinal.",
  "",
].join("\n");

function parseBaseline(source: string) {
  const entries = new Set<string>();
  for (const line of source.split(/\r?\n/u)) {
    if (!line || line.startsWith("#")) {
      continue;
    }
    const value: unknown = JSON.parse(line);
    if (
      !Array.isArray(value) ||
      value.length !== 4 ||
      typeof value[0] !== "string" ||
      typeof value[1] !== "string" ||
      typeof value[2] !== "string" ||
      !/^[0-9a-f]{64}$/u.test(value[2]) ||
      typeof value[3] !== "number" ||
      !Number.isSafeInteger(value[3]) ||
      value[3] < 1 ||
      entries.has(line) ||
      JSON.stringify(value) !== line
    ) {
      throw new Error(`Invalid ${BASELINE} entry`);
    }
    entries.add(line);
  }
  return entries;
}

function currentFactories(root: string, staged: boolean, ref?: string) {
  const env = ref ? { ...process.env, GIT_NO_LAZY_FETCH: "1" } : process.env;
  const files = execFileSync(
    "git",
    ref
      ? ["ls-tree", "-r", "--name-only", "-z", ref]
      : ["ls-files", "-z", ...(staged ? [] : ["--cached", "--others", "--exclude-standard"])],
    { cwd: root, maxBuffer: MAX_BUFFER, env },
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const inventory = new Set(files);
  const grep = spawnSync(
    "git",
    [
      "grep",
      "-l",
      "-z",
      "-F",
      "-w",
      ...(ref ? [] : staged ? ["--cached"] : ["--untracked"]),
      "-e",
      "mock",
      "-e",
      "doMock",
      ...(ref ? [ref] : []),
      "--",
      ".",
    ],
    { cwd: root, encoding: "utf8", maxBuffer: MAX_BUFFER, env },
  );
  if (grep.error || (grep.status !== 0 && grep.status !== 1)) {
    throw grep.error ?? new Error(grep.stderr || "Could not inventory mock factories");
  }
  const codeFiles = grep.stdout
    .split("\0")
    .filter(Boolean)
    .map((file) => (ref ? file.slice(ref.length + 1) : file))
    .filter((file) => EXTENSIONS.includes(path.extname(file)) && !/\.d\.[cm]?ts$/u.test(file));
  const readSources = (names: string[]) =>
    staged || ref
      ? loadRatchetSources(root, names, ref ?? "")
      : new Map(
          names.flatMap((file): [string, string][] => {
            const full = path.join(root, file);
            return fs.existsSync(full) ? [[file, fs.readFileSync(full, "utf8")]] : [];
          }),
        );
  const sources = readSources(codeFiles);
  const candidates = [...sources];
  const manifests = readSources(
    files.filter(
      (file) =>
        file === "tsconfig.json" ||
        /^(?:(?:packages|extensions)\/[^/]+\/)?package\.json$/u.test(file),
    ),
  );
  const aliases = getImportGraphAliases(root, manifests);
  const aliasResolutions = new Map<string, string[]>();
  using parser = createNativeTypeScriptParser({ cwd: root });
  const entries = new Set<string>();
  const locations = new Map<string, string>();
  // Release syntax trees between batches; CI ratchets run with a 2 GiB Node heap.
  const batchSize = 32;
  for (let offset = 0; offset < candidates.length; offset += batchSize) {
    const batch = candidates.slice(offset, offset + batchSize);
    const syntax = parser.parseSourceFiles(batch.map(([fileName, text]) => ({ fileName, text })));
    const diagnostics = parser.getSyntacticDiagnostics();
    if (diagnostics.length > 0) {
      throw new Error(`Mock factory scan requires valid syntax: ${diagnostics[0]!.text}`);
    }
    syntax.forEach((source, index) => {
      const file = batch[index]![0];
      const resolve = (specifier: string) =>
        resolveImportSpecifiers(
          file,
          specifier,
          inventory,
          EXTENSIONS,
          aliases,
          aliasResolutions,
          true,
        );
      const occurrences = new Map<string, number>();
      for (const finding of scanClosedMockFactories(source, resolve)) {
        const fingerprint = createHash("sha256")
          .update(JSON.stringify([resolve(finding.specifier).toSorted(), finding.fingerprint]))
          .digest("hex");
        const identity = JSON.stringify([file, finding.specifier, fingerprint]);
        const ordinal = (occurrences.get(identity) ?? 0) + 1;
        occurrences.set(identity, ordinal);
        const entry = JSON.stringify([file, finding.specifier, fingerprint, ordinal]);
        entries.add(entry);
        locations.set(entry, `${file}:${finding.line}: ${finding.specifier}`);
      }
    });
  }
  return { entries, locations };
}

function historicalBaseline(root: string, base: string) {
  requireComparisonHistory(root, base);
  const introductions = execFileSync(
    "git",
    [
      "log",
      "--reverse",
      "--topo-order",
      "--diff-filter=A",
      "--format=%H",
      `${base}..HEAD`,
      "--",
      BASELINE,
    ],
    { cwd: root, encoding: "utf8" },
  )
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (introductions.length === 0) {
    return null;
  }
  if (introductions.length !== 1) {
    throw new Error("Mock factory baseline requires one unambiguous policy introduction");
  }
  const introduction = introductions[0]!;
  const parents = execFileSync("git", ["show", "-s", "--format=%P", introduction], {
    cwd: root,
    encoding: "utf8",
  })
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (parents.length !== 1) {
    throw new Error("Mock factory policy introduction requires its complete single-parent history");
  }
  const baseline = loadRatchetReference(root, introduction, BASELINE, parseBaseline);
  if (baseline === null) {
    throw new Error("Could not load historical mock factory policy introduction");
  }
  // Retire every allowance removed after genesis, including removals on a
  // merged parent. Re-adding it later must not resurrect grandfathered debt.
  const allowed = new Set(baseline);
  const patches = execFileSync(
    "git",
    [
      "log",
      "--format=",
      "--full-history",
      "--diff-merges=separate",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "--patch",
      "--unified=0",
      `${base}..HEAD`,
      "--",
      BASELINE,
    ],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
    },
  );
  let removed = new Set<string>();
  let added = new Set<string>();
  const retire = () => {
    for (const entry of removed) {
      if (!added.has(entry)) {
        allowed.delete(entry);
      }
    }
    removed = new Set();
    added = new Set();
  };
  for (const line of patches.split("\n")) {
    if (line.startsWith("diff --git ")) {
      retire();
    } else if (
      (line.startsWith("+") && !line.startsWith("+++")) ||
      (line.startsWith("-") && !line.startsWith("---"))
    ) {
      const destination = line.startsWith("+") ? added : removed;
      for (const entry of parseBaseline(line.slice(1))) {
        destination.add(entry);
      }
    }
  }
  retire();
  // Intersect authority across committed snapshots, including historical reverts.
  // Discarded entries confer no authority; prove only surviving exact parent debt.
  const inherited = currentFactories(root, false, parents[0]!).entries;
  const uninherited = compareRatchetSets(allowed, inherited).added;
  if (uninherited.length > 0) {
    const examples = uninherited.slice(0, 4);
    throw new Error(
      `Initial mock factory baseline may only admit exact factories from its parent (${uninherited.length} unproven entries; ${examples.join("; ")})`,
    );
  }
  return allowed;
}

export function main(root = process.cwd(), argv = process.argv.slice(2)) {
  try {
    const args = parseRatchetArgs(argv);
    if (args.staged && args.prune) {
      throw new Error("--prune cannot be combined with --staged");
    }
    const base = resolveRatchetBase(root, args);
    if (!base) {
      throw new Error("Mock factory ratchet requires a Git base commit");
    }
    const reference = loadRatchetReference(root, base, BASELINE, parseBaseline);
    // A long-lived branch may predate the policy. Admit its historical genesis
    // only after proving every allowance existed before the policy was added.
    const allowed =
      reference ?? historicalBaseline(root, base) ?? currentFactories(root, false, base).entries;
    const current = currentFactories(root, args.staged);
    const write = (entries: Set<string>) =>
      fs.writeFileSync(
        path.join(root, BASELINE),
        HEADER + [...entries].toSorted().join("\n") + "\n",
      );
    if (args.prune && reference === null) {
      const additions = compareRatchetSets(current.entries, allowed).added;
      if (
        reportRatchetFailures([
          {
            title: "New mock factories cannot enter the initial baseline:",
            entries: additions.map((entry) => current.locations.get(entry)!),
          },
        ])
      ) {
        return 1;
      }
      write(current.entries);
      console.log(`Initialized ${BASELINE}: ${current.entries.size} exact factories.`);
      return 0;
    }
    const baseline = loadRatchetSnapshot(root, BASELINE, args.staged, parseBaseline);
    const delta = compareRatchetSets(current.entries, baseline);
    const expanded = compareRatchetSets(baseline, allowed).added;
    if (
      reportRatchetFailures(
        [
          {
            title: "First-party mock factories must preserve real exports or explain isolation:",
            entries: delta.added.map((entry) => current.locations.get(entry)!),
          },
          { title: "The mock factory baseline may only shrink:", entries: expanded },
        ],
        "Spread the real module via importOriginal/vi.importActual, or place // mock-isolation: reason immediately above the mock call when real state must stay isolated.",
      )
    ) {
      return 1;
    }
    if (args.prune) {
      write(current.entries);
      console.log(
        `Pruned ${BASELINE}: ${baseline.size} -> ${current.entries.size} exact factories.`,
      );
      return 0;
    }
    if (
      reportRatchetFailures([
        { title: `Shrink ${BASELINE} (run with --prune):`, entries: delta.removed },
      ])
    ) {
      return 1;
    }
    console.log(`Mock factory ratchet OK: ${current.entries.size} grandfathered factories.`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main();
}
