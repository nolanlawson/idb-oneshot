/**
 * WPT test subprocess entry point.
 * Executed as a child process by wpt-runner.ts.
 *
 * Usage: node --experimental-strip-types test/wpt-subprocess.ts <testFile> <storagePath>
 *
 * Outputs JSON results to stdout.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { runInThisContext } from 'node:vm';
import { setupGlobals, injectIndexedDB } from './wpt-harness-setup.ts';

const args = process.argv.slice(2);
const testFilePath = args[0]; // e.g., wpt/IndexedDB/idbkeyrange.any.js
const storagePath = args[1]; // temp directory for SQLite files

if (!testFilePath || !storagePath) {
  console.error('Usage: wpt-subprocess.ts <testFile> <storagePath>');
  process.exit(1);
}

const testFileName = basename(testFilePath);
const projectRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');

// 1. Setup browser globals
setupGlobals(testFileName);

// 2. Inject IndexedDB implementation
injectIndexedDB(storagePath);

// 3. Load testharness.js
const testharnessPath = resolve(projectRoot, 'wpt/resources/testharness.js');
const testharnessCode = readFileSync(testharnessPath, 'utf-8');
runInThisContext(testharnessCode, { filename: testharnessPath });

// Configure testharness for non-browser
(globalThis as any).setup({ explicit_done: false, explicit_timeout: false });

// 4. Parse META comments from test file to find script dependencies
const testCode = readFileSync(resolve(projectRoot, testFilePath), 'utf-8');
const metaScripts = parseMetaScripts(testCode);

// 5. Load support scripts
for (const scriptPath of metaScripts) {
  const resolved = resolveScriptPath(scriptPath, testFilePath);
  const code = readFileSync(resolved, 'utf-8');
  runInThisContext(code, { filename: resolved });
}

// 6. Register completion callback to output results
// Keep the event loop alive until tests complete (async tests use setTimeout)
const keepAliveInterval = setInterval(() => {}, 500);

const harness = (globalThis as any);
harness.add_completion_callback(
  (tests: Array<{ name: string; status: number; message: string | null }>, harnessStatus: { status: number; message: string | null }) => {
    clearInterval(keepAliveInterval);
    const results = {
      status: harnessStatus.status,
      message: harnessStatus.message,
      tests: tests.map((t) => ({
        name: t.name,
        status: t.status, // 0=PASS, 1=FAIL, 2=TIMEOUT, 3=NOTRUN
        message: t.message,
      })),
    };
    // Write results as JSON to stdout
    process.stdout.write('\n__WPT_RESULTS__' + JSON.stringify(results) + '__WPT_RESULTS_END__\n');
  }
);

// 7. Execute the test file
runInThisContext(testCode, { filename: resolve(projectRoot, testFilePath) });

// 8. Dispatch load event (triggers testharness to start async tests)
if (typeof (globalThis as any).dispatchEvent === 'function') {
  (globalThis as any).dispatchEvent(new Event('load'));
}

// Helper functions
function parseMetaScripts(code: string): string[] {
  const scripts: string[] = [];
  const regex = /\/\/\s*META:\s*script=(.+)/g;
  let match;
  while ((match = regex.exec(code)) !== null) {
    scripts.push(match[1].trim());
  }
  return scripts;
}

function resolveScriptPath(scriptRef: string, testFile: string): string {
  const testDir = dirname(resolve(projectRoot, testFile));
  if (scriptRef.startsWith('/')) {
    // Absolute path relative to wpt root
    return resolve(projectRoot, 'wpt', scriptRef.slice(1));
  }
  return resolve(testDir, scriptRef);
}
