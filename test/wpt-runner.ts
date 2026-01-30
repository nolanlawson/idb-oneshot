/**
 * WPT test runner - executes a single WPT test file in a subprocess.
 *
 * Usage: node --experimental-strip-types test/wpt-runner.ts <testFile>
 * Example: node --experimental-strip-types test/wpt-runner.ts wpt/IndexedDB/idbkeyrange.any.js
 */

import { fork } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';

const projectRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');

export interface SubtestResult {
  name: string;
  status: number; // 0=PASS, 1=FAIL, 2=TIMEOUT, 3=NOTRUN
  message: string | null;
}

export interface TestFileResult {
  file: string;
  status: 'pass' | 'fail' | 'timeout' | 'error';
  pass: number;
  fail: number;
  timeout: number;
  notrun: number;
  subtests: SubtestResult[];
  error?: string;
}

const STATUS_NAMES = ['PASS', 'FAIL', 'TIMEOUT', 'NOTRUN'] as const;

function parseTimeout(testFile: string): number {
  try {
    const code = readFileSync(resolve(projectRoot, testFile), 'utf-8');
    if (/\/\/\s*META:\s*timeout=long/.test(code)) {
      return 60000;
    }
  } catch {}
  return 10000;
}

export function runWPTTest(testFile: string): Promise<TestFileResult> {
  return new Promise((resolvePromise) => {
    const storagePath = mkdtempSync(join(tmpdir(), 'idb-wpt-'));
    const timeoutMs = parseTimeout(testFile);

    const subprocessPath = resolve(projectRoot, 'test/wpt-subprocess.ts');
    const child = fork(subprocessPath, [testFile, storagePath], {
      execArgv: ['--experimental-strip-types'],
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      cwd: projectRoot,
      timeout: timeoutMs,
      silent: true,
    });

    let stdout = '';
    let stderr = '';

    child.stdout!.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr!.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs + 1000);

    child.on('close', (code, signal) => {
      clearTimeout(timer);

      // Cleanup storage
      try {
        rmSync(storagePath, { recursive: true, force: true });
      } catch {}

      // Parse results from stdout
      const marker = '__WPT_RESULTS__';
      const endMarker = '__WPT_RESULTS_END__';
      const startIdx = stdout.indexOf(marker);
      const endIdx = stdout.indexOf(endMarker);

      if (startIdx === -1 || endIdx === -1) {
        // No results - probably crashed
        resolvePromise({
          file: testFile,
          status: signal === 'SIGKILL' ? 'timeout' : 'error',
          pass: 0,
          fail: 0,
          timeout: 0,
          notrun: 0,
          subtests: [],
          error: stderr || `Process exited with code ${code}, signal ${signal}`,
        });
        return;
      }

      try {
        const json = stdout.slice(startIdx + marker.length, endIdx);
        const results = JSON.parse(json);
        const subtests: SubtestResult[] = results.tests || [];

        let pass = 0,
          fail = 0,
          timeout = 0,
          notrun = 0;
        for (const t of subtests) {
          if (t.status === 0) pass++;
          else if (t.status === 1) fail++;
          else if (t.status === 2) timeout++;
          else notrun++;
        }

        resolvePromise({
          file: testFile,
          status: fail === 0 && timeout === 0 && subtests.length > 0 ? 'pass' : 'fail',
          pass,
          fail,
          timeout,
          notrun,
          subtests,
        });
      } catch (e: any) {
        resolvePromise({
          file: testFile,
          status: 'error',
          pass: 0,
          fail: 0,
          timeout: 0,
          notrun: 0,
          subtests: [],
          error: `Failed to parse results: ${e.message}`,
        });
      }
    });
  });
}

function statusLabel(status: number): string {
  return STATUS_NAMES[status] ?? 'UNKNOWN';
}

// CLI entry point
if (process.argv[1] &&
    (process.argv[1].endsWith('wpt-runner.ts') || process.argv[1].endsWith('wpt-runner'))) {
  const testFile = process.argv[2];
  if (!testFile) {
    console.error('Usage: wpt-runner.ts <testFile>');
    console.error('Example: node --experimental-strip-types test/wpt-runner.ts wpt/IndexedDB/idbkeyrange.any.js');
    process.exit(1);
  }

  runWPTTest(testFile).then((result) => {
    console.log(`\n${result.file}: ${result.status.toUpperCase()}`);
    console.log(`  Pass: ${result.pass}, Fail: ${result.fail}, Timeout: ${result.timeout}, Not Run: ${result.notrun}`);
    if (result.error) {
      console.log(`  Error: ${result.error}`);
    }
    console.log('');
    for (const t of result.subtests) {
      const label = statusLabel(t.status);
      const msg = t.message ? ` - ${t.message}` : '';
      console.log(`  [${label}] ${t.name}${msg}`);
    }
    process.exit(result.status === 'pass' ? 0 : 1);
  });
}
