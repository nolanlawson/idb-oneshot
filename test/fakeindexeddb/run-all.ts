import { fork } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "smol-toml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const registerLoaderPath = path.join(__dirname, "register-loader.mjs");

const generateManifests = !!process.env.GENERATE_MANIFESTS;

// Paths inside the fakeIndexedDB submodule
const fakeIdbRoot = path.resolve(__dirname, "../../fakeIndexedDB");
const wptRoot = path.join(fakeIdbRoot, "src/test/web-platform-tests");
const testFolder = path.join(wptRoot, "converted");
const manifestsFolder = path.join(wptRoot, "manifests");

const timeout = 10_000;

// ── Helpers ──────────────────────────────────────────────────────────

function runTestFile(
  scriptPath: string,
  options: { cwd: string; timeout: number },
): Promise<{ stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = fork(scriptPath, [], {
      cwd: options.cwd,
      silent: true,
      execArgv: [
        "--experimental-strip-types",
        "--disable-warning=ExperimentalWarning",
        "--import",
        registerLoaderPath,
      ],
    });

    let stdout = "";
    let stderr = "";

    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");

    child.stdout!.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr!.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ stdout, stderr, timedOut: true });
    }, options.timeout);

    child.on("error", (error) => {
      clearTimeout(timer);
      // Still resolve so we can inspect stdout
      resolve({ stdout, stderr, timedOut: false });
    });

    child.on("exit", (_code, _signal) => {
      clearTimeout(timer);
      // Always resolve — non-zero exit is common when tests throw
      resolve({ stdout, stderr, timedOut: false });
    });
  });
}

function parseManifest(manifestFilename: string) {
  if (!fs.existsSync(manifestFilename)) return undefined;
  const text = fs.readFileSync(manifestFilename, "utf-8");
  if (!text) return undefined;
  const contents = parse(text);
  const comments = text.split("\n").filter((line) => line.startsWith("#"));
  return { contents, comments };
}

function stringifyManifest(
  generatedManifest: Record<string, any>,
  comments?: string[],
) {
  return (
    (comments && comments.length > 0 ? comments.join("\n") + "\n" : "") +
    stringify(generatedManifest)
  );
}

// ── Collect test files ───────────────────────────────────────────────

const filenames = fs
  .readdirSync(testFolder, { recursive: true })
  .map((f) => (typeof f === "string" ? f : f.toString()))
  .filter(
    (f) =>
      f.endsWith(".js") &&
      !f.startsWith("resources") &&
      !f.startsWith("crashtests"),
  )
  .sort();

// ── Stats ────────────────────────────────────────────────────────────

let totalTests = 0;
let totalPassed = 0;
let totalFailed = 0;
let timedOutFiles = 0;

// Track how many of fake-indexeddb's passing tests we also pass
let fakeIdbPassingTests = 0;
let fakeIdbPassingWeAlsoPass = 0;

// ── Run each test file ───────────────────────────────────────────────

for (const filename of filenames) {
  const absFilename = path.join(testFolder, filename);

  // Load fake-indexeddb's manifest for this file
  const manifestBasename = filename.replace(/\.js$/, ".toml");
  const manifestFilename = path.join(manifestsFolder, manifestBasename);
  const fakeIdbManifest = parseManifest(manifestFilename);

  const skip = fakeIdbManifest?.contents?.skip;
  if (skip) {
    process.stdout.write(`SKIP ${filename}\n`);
    continue;
  }

  const { stdout, stderr, timedOut } = await runTestFile(absFilename, {
    cwd: testFolder,
    timeout,
  });

  if (timedOut) {
    timedOutFiles++;
    process.stdout.write(`TIMEOUT ${filename}\n`);
    continue;
  }

  // Parse test results from stdout
  const results: Record<string, { passed: boolean; error?: string }> = {};
  const resultLines = stdout
    .split("\n")
    .filter((line) => line.includes("testResult"));

  for (const line of resultLines) {
    try {
      const parsed = JSON.parse(line);
      Object.assign(results, parsed.testResult);
    } catch {
      // ignore malformed lines
    }
  }

  if (!Object.keys(results).length) {
    timedOutFiles++;
    process.stdout.write(`NO-OUTPUT ${filename}\n`);
    if (stderr) {
      // Print first few lines of stderr for debugging
      const lines = stderr.split("\n").slice(0, 3);
      for (const l of lines) {
        process.stdout.write(`  stderr: ${l}\n`);
      }
    }
    continue;
  }

  let filePassed = 0;
  let fileFailed = 0;
  const generatedManifest: Record<string, any> = {};

  for (const [name, result] of Object.entries(results)) {
    totalTests++;

    // Check fake-indexeddb's expectation for this test
    const fakeIdbExpectation =
      fakeIdbManifest?.contents?.[name] &&
      typeof fakeIdbManifest.contents[name] === "object" &&
      (fakeIdbManifest.contents[name] as any).expectation;

    // If fake-indexeddb expects this to pass (no entry or no FAIL expectation)
    const fakeIdbExpectsPass =
      fakeIdbExpectation !== "FAIL" && fakeIdbExpectation !== "UNSTABLE";

    if (fakeIdbExpectsPass) {
      fakeIdbPassingTests++;
    }

    if (result.passed) {
      totalPassed++;
      filePassed++;
      if (fakeIdbExpectsPass) {
        fakeIdbPassingWeAlsoPass++;
      }
    } else {
      totalFailed++;
      fileFailed++;
      generatedManifest[name] = { expectation: "FAIL" };
    }
  }

  const statusIcon = fileFailed === 0 ? "PASS" : "FAIL";
  process.stdout.write(
    `${statusIcon} ${filename} (${filePassed}/${filePassed + fileFailed})\n`,
  );

  // Optionally write manifests
  if (generateManifests) {
    const ourManifestDir = path.join(__dirname, "manifests");
    const ourManifestFile = path.join(ourManifestDir, manifestBasename);
    fs.mkdirSync(path.dirname(ourManifestFile), { recursive: true });

    if (Object.keys(generatedManifest).length) {
      const sorted = Object.fromEntries(
        Object.keys(generatedManifest)
          .sort()
          .map((key) => [key, generatedManifest[key]]),
      );
      fs.writeFileSync(ourManifestFile, stringifyManifest(sorted));
    } else {
      // All passed — remove manifest if it exists
      fs.rmSync(ourManifestFile, { force: true });
    }
  }
}

// ── Final summary ────────────────────────────────────────────────────

console.log("\n" + "=".repeat(60));
console.log("RESULTS SUMMARY");
console.log("=".repeat(60));
console.log(`Total tests:       ${totalTests}`);
console.log(`Passed:            ${totalPassed}`);
console.log(`Failed:            ${totalFailed}`);
console.log(`Timed-out files:   ${timedOutFiles}`);
console.log(
  `Overall pass rate: ${totalTests > 0 ? ((100 * totalPassed) / totalTests).toFixed(1) : 0}%`,
);
console.log("");
console.log(
  `fake-indexeddb passing tests: ${fakeIdbPassingTests}`,
);
console.log(
  `Of those, we also pass:       ${fakeIdbPassingWeAlsoPass}`,
);
console.log(
  `Match rate:                   ${fakeIdbPassingTests > 0 ? ((100 * fakeIdbPassingWeAlsoPass) / fakeIdbPassingTests).toFixed(1) : 0}%`,
);
console.log("=".repeat(60));
