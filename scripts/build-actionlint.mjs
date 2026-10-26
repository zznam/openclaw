import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ACTIONLINT_REVISION = "011a6d15e749bb3f2d771eed9c7aa0e7e3e10ee7";
export const ACTIONLINT_PATCH_PATH = "config/actionlint-job-context.patch";
export const PATCH_SHA256 = "ed6121b4d79b689be6c05d8ff8ef43e63c05f52b621f16e30c5f4a87f6d37b75";
export const ACTIONLINT_VERSION = `openclaw-actionlint-${ACTIONLINT_REVISION.slice(0, 12)}-${PATCH_SHA256.slice(0, 12)}`;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function checked(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(`${command} failed (exit ${result.status})`);
  }
  return result;
}

function makeDirectoriesWritable(directory) {
  fs.chmodSync(directory, 0o755);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      makeDirectoriesWritable(path.join(directory, entry.name));
    }
  }
}

function isQualified(binary) {
  if (!fs.existsSync(binary)) {
    return false;
  }
  const version = spawnSync(binary, ["--version"], { encoding: "utf8" });
  return version.status === 0 && version.stdout.split(/\r?\n/u)[0] === ACTIONLINT_VERSION;
}

export function ensureActionlint() {
  // Upstream PR #707 adds exactly four documented string properties, without
  // weakening unknown-property validation. Its unmerged SHA is not Go-resolvable.
  const patch = path.join(root, ACTIONLINT_PATCH_PATH);
  if (createHash("sha256").update(fs.readFileSync(patch)).digest("hex") !== PATCH_SHA256) {
    throw new Error("actionlint schema patch checksum mismatch");
  }
  const cache = path.join(
    root,
    ".cache",
    "actionlint",
    `${ACTIONLINT_VERSION}-${process.platform}-${process.arch}`,
  );
  const binary = path.join(cache, process.platform === "win32" ? "actionlint.exe" : "actionlint");
  if (isQualified(binary)) {
    return binary;
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-actionlint-build-"));
  try {
    const module = JSON.parse(
      checked(
        "go",
        ["mod", "download", "-json", `github.com/rhysd/actionlint@${ACTIONLINT_REVISION}`],
        { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
      ).stdout,
    );
    const source = path.join(temporary, "source");
    fs.cpSync(module.Dir, source, { recursive: true });
    makeDirectoriesWritable(source);
    checked("git", ["apply", "--unidiff-zero", "--check", patch], { cwd: source });
    checked("git", ["apply", "--unidiff-zero", patch], { cwd: source });
    const built = path.join(temporary, path.basename(binary));
    checked(
      "go",
      [
        "build",
        "-trimpath",
        "-buildvcs=false",
        "-ldflags",
        `-X github.com/rhysd/actionlint.version=${ACTIONLINT_VERSION}`,
        "-o",
        built,
        "./cmd/actionlint",
      ],
      { cwd: source },
    );
    if (!isQualified(built)) {
      throw new Error("Built actionlint identity does not match its source and schema patch");
    }
    fs.mkdirSync(cache, { recursive: true });
    const publication = fs.mkdtempSync(path.join(cache, ".publish-"));
    try {
      const staged = path.join(publication, path.basename(binary));
      fs.copyFileSync(built, staged);
      fs.chmodSync(staged, 0o755);
      if (!isQualified(binary)) {
        try {
          fs.renameSync(staged, binary);
        } catch (error) {
          // Another builder may have published while this one was staging.
          if (!isQualified(binary)) {
            throw error;
          }
        }
      }
    } finally {
      fs.rmSync(publication, { recursive: true, force: true });
    }
    return binary;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === "--identity") {
      process.stdout.write(`${ACTIONLINT_VERSION}\n`);
    } else {
      const binary = ensureActionlint();
      if (args[0] === "--build-only" && args.length === 2) {
        fs.copyFileSync(binary, args[1]);
        fs.chmodSync(args[1], 0o755);
      } else {
        const result = spawnSync(binary, args, { stdio: "inherit" });
        if (result.error) {
          throw result.error;
        }
        process.exitCode = result.status ?? 1;
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
