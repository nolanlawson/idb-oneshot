/**
 * Run all WPT IndexedDB tests and produce a manifest.
 *
 * Usage: node --experimental-strip-types test/run-all.ts
 */

import { readdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { runWPTTest, type TestFileResult } from './wpt-runner.ts';

const projectRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');

// Tests to skip (browser-only)
const SKIP_FILES = new Set([
  'idlharness.any.js',
  'storage-buckets.https.any.js',
]);

// Patterns that indicate browser-only tests
const SKIP_PATTERNS = [
  /\.window\.js$/,
  /\.html$/,
  /\.htm$/,
  /\.sub\./,
  /opaque-origin/,
  /origin-isolation/,
  /cross-realm/,
];

function shouldSkip(filename: string): boolean {
  if (SKIP_FILES.has(filename)) return true;
  return SKIP_PATTERNS.some((p) => p.test(filename));
}

async function main() {
  const testDir = resolve(projectRoot, 'wpt/IndexedDB');
  const allFiles = readdirSync(testDir)
    .filter((f) => f.endsWith('.any.js'))
    .sort();

  const testFiles = allFiles.filter((f) => !shouldSkip(f));
  const skippedFiles = allFiles.filter((f) => shouldSkip(f));

  console.log(`Found ${allFiles.length} .any.js test files`);
  console.log(`Running ${testFiles.length}, skipping ${skippedFiles.length}\n`);

  const results: TestFileResult[] = [];

  for (let i = 0; i < testFiles.length; i++) {
    const file = testFiles[i];
    const testPath = `wpt/IndexedDB/${file}`;
    process.stdout.write(`[${i + 1}/${testFiles.length}] ${file} ... `);

    const result = await runWPTTest(testPath);
    results.push(result);

    const statusStr = result.status.toUpperCase().padEnd(7);
    console.log(`${statusStr} (${result.pass}/${result.pass + result.fail + result.timeout + result.notrun})`);
  }

  // Compute summary
  let totalPass = 0,
    totalFail = 0,
    totalTimeout = 0,
    totalNotrun = 0;
  for (const r of results) {
    totalPass += r.pass;
    totalFail += r.fail;
    totalTimeout += r.timeout;
    totalNotrun += r.notrun;
  }
  const total = totalPass + totalFail + totalTimeout + totalNotrun;
  const passRate = total > 0 ? ((totalPass / total) * 100).toFixed(1) : '0.0';

  console.log('\n=== Summary ===');
  console.log(`Total subtests: ${total}`);
  console.log(`Pass: ${totalPass}, Fail: ${totalFail}, Timeout: ${totalTimeout}, Not Run: ${totalNotrun}`);
  console.log(`Pass rate: ${passRate}%`);

  // Generate manifest
  const manifest: any = {
    generated: new Date().toISOString(),
    summary: {
      total_tests: total,
      pass: totalPass,
      fail: totalFail,
      timeout: totalTimeout,
      notrun: totalNotrun,
      pass_rate: passRate + '%',
    },
    files: {} as any,
  };

  for (const r of results) {
    const filename = r.file.replace('wpt/IndexedDB/', '');
    manifest.files[filename] = {
      status: r.status,
      pass: r.pass,
      fail: r.fail,
      timeout: r.timeout,
      ...(r.error ? { error: r.error } : {}),
      subtests: r.subtests.map((s) => ({
        name: s.name,
        status: ['pass', 'fail', 'timeout', 'notrun'][s.status] || 'unknown',
        ...(s.message ? { message: s.message } : {}),
      })),
    };
  }

  for (const f of skippedFiles) {
    manifest.files[f] = { status: 'skip' };
  }

  const manifestPath = resolve(projectRoot, 'test/manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`\nManifest written to ${manifestPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
