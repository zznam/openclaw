#!/usr/bin/env node
import { spawnSync } from "node:child_process";
// Enforces release-train metadata on core gateway methods.
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import * as ts from "typescript/ast";
import { requireComparisonHistory } from "./lib/comparison-history.mts";
import { createNativeTypeScriptParser } from "./lib/native-typescript.mts";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import { getPropertyNameText } from "./lib/ts-guard-utils.mts";

const repoRoot = resolveRepoRoot(import.meta.url);
const descriptorPath = "src/gateway/methods/core-descriptors.ts";

type MethodSpec = {
  line: number;
  name: string;
  since: string | undefined;
  compatibilityRestored: boolean;
};

function runGit(args: string[]): string {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `git exited ${result.status}`;
    throw new Error(
      `${detail}\nRun git fetch origin main so origin/main and its merge-base are available.`,
    );
  }
  return result.stdout.trim();
}

function tryRunGit(args: string[]): string | undefined {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function resolveBaseCommit(): string {
  const explicitBase = process.env.PROTOCOL_SINCE_BASE_SHA?.trim();
  if (explicitBase) {
    if (!/^[0-9a-f]{40}$/u.test(explicitBase)) {
      throw new Error("PROTOCOL_SINCE_BASE_SHA must be a full commit SHA.");
    }
    if (tryRunGit(["cat-file", "-e", `${explicitBase}:${descriptorPath}`]) === undefined) {
      throw new Error(`PROTOCOL_SINCE_BASE_SHA ${explicitBase} is unavailable in this checkout.`);
    }
    return explicitBase;
  }
  const mainMergeBase = tryRunGit(["merge-base", "HEAD", "origin/main"]);
  if (mainMergeBase) {
    return mainMergeBase;
  }
  // Pull-request CI checks out a synthetic merge commit without creating origin/main.
  // Its first parent is the exact base used to build the merge result.
  const parents = (tryRunGit(["show", "-s", "--format=%P", "HEAD"]) ?? "").split(/\s+/u);
  if (parents.length === 2 && parents[0]) {
    return parents[0];
  }
  throw new Error(
    "Could not resolve PROTOCOL_SINCE_BASE_SHA, origin/main, or a two-parent pull-request merge checkout.",
  );
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function stringProperty(object: ts.ObjectLiteralExpression, key: string): string | undefined {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }
    const name = getPropertyNameText(property.name);
    if (name === key && ts.isStringLiteralLikeNode(property.initializer)) {
      return property.initializer.text;
    }
  }
  return undefined;
}

function trueProperty(object: ts.ObjectLiteralExpression, key: string): boolean {
  return object.properties.some((property) => {
    if (!ts.isPropertyAssignment(property)) {
      return false;
    }
    const name = getPropertyNameText(property.name);
    return name === key && property.initializer.kind === ts.SyntaxKind.TrueKeyword;
  });
}

function collectMethodSpec(
  element: ts.Expression,
  sourceFile: ts.SourceFile,
  fileName: string,
): MethodSpec {
  const line = sourceFile.getLineAndCharacterOfPosition(element.getStart(sourceFile)).line + 1;
  if (ts.isObjectLiteralExpression(element)) {
    const name = stringProperty(element, "name");
    if (!name) {
      throw new Error(
        `${fileName}:${line} core method spec names must be string literals so additions can be compared with origin/main.`,
      );
    }
    return {
      name,
      since: stringProperty(element, "since"),
      compatibilityRestored: trueProperty(element, "compatibilityRestored"),
      line,
    };
  }
  if (ts.isArrayLiteralExpression(element)) {
    const name = element.elements[0];
    const since = element.elements[3];
    if (
      !name ||
      !since ||
      !ts.isStringLiteralLikeNode(name) ||
      !ts.isStringLiteralLikeNode(since)
    ) {
      throw new Error(
        `${fileName}:${line} core method spec rows must use string literal names and vintage metadata.`,
      );
    }
    const policy = element.elements[4];
    const compatibilityRestored =
      policy !== undefined && ts.isObjectLiteralExpression(policy)
        ? trueProperty(policy, "compatibilityRestored")
        : false;
    return { name: name.text, since: since.text, compatibilityRestored, line };
  }
  throw new Error(
    `${fileName}:${line} core method specs must be inline object literals or labeled rows so vintage metadata can be enforced.`,
  );
}

function collectMethodSpecs(sourceFile: ts.SourceFile, fileName: string): MethodSpec[] {
  let specs: MethodSpec[] | undefined;

  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "CORE_GATEWAY_METHOD_SPECS" &&
      node.initializer
    ) {
      const initializer = unwrapExpression(node.initializer);
      if (ts.isArrayLiteralExpression(initializer)) {
        specs = initializer.elements.map((element) =>
          collectMethodSpec(element, sourceFile, fileName),
        );
      }
    }
    node.forEachChild(visit);
  }

  visit(sourceFile);
  if (!specs) {
    throw new Error(`Could not find CORE_GATEWAY_METHOD_SPECS in ${fileName}.`);
  }
  return specs;
}

function releaseTrain(source: string): string {
  const packageJson: unknown = JSON.parse(source);
  if (!isRecord(packageJson)) {
    throw new Error("Root package.json must contain an object.");
  }
  const version = typeof packageJson.version === "string" ? packageJson.version : "";
  const match = /^(\d{4})\.(\d{1,2})(?:\.|$)/.exec(version);
  if (!match) {
    throw new Error(`Root package version ${JSON.stringify(packageJson.version)} is not calver.`);
  }
  return `${match[1]!}.${match[2]!}`;
}

function compareTrains(left: string, right: string): number {
  const [leftYear, leftMonth] = left.split(".").map(Number);
  const [rightYear, rightMonth] = right.split(".").map(Number);
  return leftYear! - rightYear! || leftMonth! - rightMonth!;
}

function releaseTrainHistory(base: string, descriptorCommits: string[]): Map<string, string> {
  const changes = runGit([
    "log",
    "--full-history",
    "--format=%H %P",
    `${base}..HEAD`,
    "--",
    "package.json",
  ])
    .split("\n")
    .filter(Boolean)
    .map((line) => line.trim().split(/\s+/u));
  const commits = [...new Set([...changes.flat(), ...descriptorCommits])];
  const result = spawnSync("git", ["cat-file", "--batch"], {
    cwd: repoRoot,
    input: commits.map((commit) => `${commit}:package.json\n`).join(""),
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error("Could not read package release-train history.");
  }
  const trains = new Map<string, string>();
  let offset = 0;
  for (const commit of commits) {
    const end = result.stdout.indexOf(10, offset);
    const header = result.stdout.subarray(offset, end).toString("utf8");
    const size = Number(/^[0-9a-f]+ blob (\d+)$/u.exec(header)?.[1]);
    if (end < 0 || !Number.isSafeInteger(size) || result.stdout[end + 1 + size] !== 10) {
      throw new Error(
        `Could not read package.json@${commit}; fetch complete release-train history.`,
      );
    }
    trains.set(
      commit,
      releaseTrain(result.stdout.subarray(end + 1, end + 1 + size).toString("utf8")),
    );
    offset = end + 2 + size;
  }
  // Compare actual parent edges: chronological/topological ordering alone would
  // mistake an older parallel branch for a rollback on the advancing branch.
  for (const [commit, ...parents] of changes) {
    const train = trains.get(commit!)!;
    for (const parent of parents) {
      const parentTrain = trains.get(parent)!;
      if (compareTrains(train, parentTrain) < 0) {
        throw new Error(
          `Protocol release train rolled back from ${parentTrain} to ${train} at ${commit}.`,
        );
      }
    }
  }
  return trains;
}

try {
  using parser = createNativeTypeScriptParser({ cwd: repoRoot });
  const train = releaseTrain(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const mergeBase = resolveBaseCommit();
  const currentSource = fs.readFileSync(path.join(repoRoot, descriptorPath), "utf8");
  const currentSpecs = collectMethodSpecs(
    parser.parseSourceFile(descriptorPath, currentSource),
    descriptorPath,
  );
  const baseSource = runGit(["show", `${mergeBase}:${descriptorPath}`]);
  const baseNames = new Set(
    collectMethodSpecs(
      parser.parseSourceFile(descriptorPath, baseSource),
      `${descriptorPath}@${mergeBase}`,
    ).map((s) => s.name),
  );
  const added = currentSpecs.filter((spec) => !baseNames.has(spec.name));
  // A comparison can span release trains. Committed methods retain the train
  // from their first declaration; worktree additions still use today's train.
  const baseTrain = releaseTrain(runGit(["show", `${mergeBase}:package.json`]));
  const introductions = new Map<string, string>();
  if (baseTrain !== train) {
    requireComparisonHistory(repoRoot, mergeBase);
    const pending = new Set(
      added.filter((spec) => !spec.compatibilityRestored).map((spec) => spec.name),
    );
    const commits = runGit([
      "log",
      "--reverse",
      "--topo-order",
      "--full-history",
      "--format=%H",
      `${mergeBase}..HEAD`,
      "--",
      descriptorPath,
    ])
      .split(/\s+/u)
      .filter(Boolean);
    const trains = releaseTrainHistory(mergeBase, commits);
    for (const commit of commits) {
      if (pending.size === 0) {
        break;
      }
      const entry = runGit(["ls-tree", "--name-only", commit, "--", descriptorPath]);
      if (!entry) {
        // A deleted descriptor contributes no method introductions.
        continue;
      }
      const source = runGit(["show", `${commit}:${descriptorPath}`]);
      const specs = collectMethodSpecs(
        parser.parseSourceFile(descriptorPath, source),
        `${descriptorPath}@${commit}`,
      );
      const introduced = specs.filter((spec) => pending.has(spec.name));
      if (introduced.length === 0) {
        continue;
      }
      const introducedTrain = trains.get(commit)!;
      for (const spec of introduced) {
        if (
          compareTrains(introducedTrain, baseTrain) < 0 ||
          compareTrains(introducedTrain, train) > 0
        ) {
          throw new Error(
            `Protocol introduction ${commit} has release train ${introducedTrain} outside ${baseTrain}..${train}.`,
          );
        }
        introductions.set(spec.name, introducedTrain);
        pending.delete(spec.name);
      }
    }
  }
  const restored = added.filter((spec) => spec.compatibilityRestored);
  const newMethods = added.filter((spec) => !spec.compatibilityRestored);
  // Restored shipped methods retain their historical vintage so discovery and
  // generated clients see the original availability contract, not a new API.
  const violations = added.filter((spec) =>
    spec.compatibilityRestored
      ? !spec.since?.startsWith("<=")
      : spec.since !== (introductions.get(spec.name) ?? train),
  );

  if (violations.length > 0) {
    console.error(`Protocol since guard failed for current train ${train}:`);
    for (const spec of violations) {
      const problem = spec.compatibilityRestored
        ? `is marked compatibilityRestored but has non-historical since ${JSON.stringify(spec.since)}`
        : spec.since
          ? `has since ${JSON.stringify(spec.since)}`
          : "is missing since metadata";
      console.error(
        spec.compatibilityRestored
          ? `- ${descriptorPath}:${spec.line} ${spec.name} ${problem}; restored compatibility methods must retain <= vintage metadata.`
          : `- ${descriptorPath}:${spec.line} ${spec.name} ${problem}; add since: ${JSON.stringify(introductions.get(spec.name) ?? train)}.`,
      );
    }
    process.exitCode = 1;
  } else {
    console.log(
      `protocol since guard passed: ${newMethods.length} new core method${newMethods.length === 1 ? "" : "s"} retain their introduction trains through ${train}; ${restored.length} restored compatibility method${restored.length === 1 ? "" : "s"} retain historical vintage`,
    );
  }
} catch (error) {
  console.error(
    `Protocol since guard failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
