/**
 * Compare fake-indexeddb's WPT manifests with ours.
 *
 * Produces four categories:
 *   1. They fail, we pass  (we're better)
 *   2. They pass, we fail  (we're worse)
 *   3. Both fail           (shared failures)
 *   4. Both pass           (not printed, just counted)
 *
 * Also lists timed-out files separately.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const fakeIdbManifests = path.resolve(
  __dirname,
  "../../fakeIndexedDB/src/test/web-platform-tests/manifests",
);
const ourManifests = path.join(__dirname, "manifests");
const testFolder = path.resolve(
  __dirname,
  "../../fakeIndexedDB/src/test/web-platform-tests/converted",
);

function loadManifest(filepath: string): Record<string, any> | undefined {
  if (!fs.existsSync(filepath)) return undefined;
  const text = fs.readFileSync(filepath, "utf-8");
  if (!text.trim()) return undefined;
  return parse(text);
}

// Collect all test files
const allFiles = fs
  .readdirSync(testFolder, { recursive: true })
  .map((f) => (typeof f === "string" ? f : f.toString()))
  .filter(
    (f) =>
      f.endsWith(".js") &&
      !f.startsWith("resources") &&
      !f.startsWith("crashtests"),
  )
  .sort();

const wePassTheyFail: string[] = [];
const theyPassWeFail: string[] = [];
const bothFail: string[] = [];
let bothPass = 0;

const ourTimedOut: string[] = [];
const theirSkipped: string[] = [];

for (const filename of allFiles) {
  const tomlName = filename.replace(/\.js$/, ".toml");
  const theirManifest = loadManifest(path.join(fakeIdbManifests, tomlName));
  const ourManifest = loadManifest(path.join(ourManifests, tomlName));

  // Handle file-level skip/timeout
  if (theirManifest?.skip) {
    theirSkipped.push(filename);
    continue;
  }
  if (ourManifest?.expectTimeout) {
    ourTimedOut.push(filename);
    continue;
  }

  // Collect all test names from both manifests
  const allTestNames = new Set<string>();

  // Tests in their manifest that have expectation entries are tests with known status
  if (theirManifest) {
    for (const key of Object.keys(theirManifest)) {
      if (
        key !== "skip" &&
        key !== "expectTimeout" &&
        typeof theirManifest[key] === "object"
      ) {
        allTestNames.add(key);
      }
    }
  }
  if (ourManifest) {
    for (const key of Object.keys(ourManifest)) {
      if (
        key !== "skip" &&
        key !== "expectTimeout" &&
        typeof ourManifest[key] === "object"
      ) {
        allTestNames.add(key);
      }
    }
  }

  // For tests that appear in neither manifest, both pass — but we don't know
  // individual test names unless they appear in a manifest. We only have names
  // for tests that fail in at least one implementation.

  for (const testName of allTestNames) {
    const theirEntry = theirManifest?.[testName];
    const ourEntry = ourManifest?.[testName];

    const theyFail =
      typeof theirEntry === "object" &&
      (theirEntry as any).expectation === "FAIL";
    const weFail =
      typeof ourEntry === "object" &&
      (ourEntry as any).expectation === "FAIL";

    // Skip unstable
    const theyUnstable =
      typeof theirEntry === "object" &&
      (theirEntry as any).expectation === "UNSTABLE";
    const weUnstable =
      typeof ourEntry === "object" &&
      (ourEntry as any).expectation === "UNSTABLE";
    if (theyUnstable || weUnstable) continue;

    if (theyFail && !weFail) {
      wePassTheyFail.push(`${filename}: ${testName}`);
    } else if (!theyFail && weFail) {
      theyPassWeFail.push(`${filename}: ${testName}`);
    } else if (theyFail && weFail) {
      bothFail.push(`${filename}: ${testName}`);
    }
    // else both pass — counted elsewhere
  }
}

// ── Output ───────────────────────────────────────────────────────────

console.log("=".repeat(70));
console.log("MANIFEST COMPARISON: fake-indexeddb vs. ours");
console.log("=".repeat(70));

console.log(`\n## We PASS, they FAIL (${wePassTheyFail.length} tests)\n`);
for (const t of wePassTheyFail) console.log(`  + ${t}`);

console.log(`\n## They PASS, we FAIL (${theyPassWeFail.length} tests)\n`);
for (const t of theyPassWeFail) console.log(`  - ${t}`);

console.log(`\n## Both FAIL (${bothFail.length} tests)\n`);
for (const t of bothFail) console.log(`  = ${t}`);

console.log(`\n## Our timed-out files (${ourTimedOut.length})\n`);
for (const t of ourTimedOut) console.log(`  ! ${t}`);

console.log(`\n## Their skipped files (${theirSkipped.length})\n`);
for (const t of theirSkipped) console.log(`  ~ ${t}`);

console.log("\n" + "=".repeat(70));
console.log("TOTALS");
console.log("=".repeat(70));
console.log(`We pass, they fail:    ${wePassTheyFail.length}`);
console.log(`They pass, we fail:    ${theyPassWeFail.length}`);
console.log(`Both fail:             ${bothFail.length}`);
console.log(`Our timed-out files:   ${ourTimedOut.length}`);
console.log(`Their skipped files:   ${theirSkipped.length}`);
console.log("=".repeat(70));
