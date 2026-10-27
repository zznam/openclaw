import { missingRatchetRenameObjects } from "./lib/shrink-ratchet.mts";
import { TYPE_ASSERTION_PRODUCTION_ROOTS } from "./lib/type-assertion-guard-scope.mjs";

const base = process.argv[2];
if (typeof base !== "string" || !/^[0-9a-f]{40}$/u.test(base)) {
  throw new Error("Expected immutable comparison base");
}
const root = process.cwd();
const missing = new Set([
  ...missingRatchetRenameObjects(
    root,
    base,
    "config/assertion-safety-baseline.txt",
    TYPE_ASSERTION_PRODUCTION_ROOTS,
  ),
  ...missingRatchetRenameObjects(root, base, "config/test-timeout-race-baseline.txt", ["."]),
]);
console.log(JSON.stringify([...missing].toSorted()));
