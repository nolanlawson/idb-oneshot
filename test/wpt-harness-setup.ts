/**
 * Browser global shims for WPT testharness.js running in Node.
 * This must be called before loading testharness.js.
 */

export function setupGlobals(testFile: string): void {
  // self = globalThis (testharness.js expects `self`)
  (globalThis as any).self = globalThis;

  // Minimal location shim
  const pathname = '/IndexedDB/' + testFile;
  (globalThis as any).location = {
    pathname,
    href: 'http://localhost' + pathname,
    origin: 'http://localhost',
    protocol: 'http:',
    host: 'localhost',
    hostname: 'localhost',
    port: '',
    search: '',
    hash: '',
    toString() {
      return this.href;
    },
  };

  // Do NOT set `document` on globalThis — its presence causes testharness.js
  // to select WindowTestEnvironment which requires a full DOM.
  // Instead we let it fall through to ShellTestEnvironment.

  // Ensure `document` is not present (Node doesn't have it, but be safe)
  delete (globalThis as any).document;

  // fetch shim (some support scripts reference it)
  if (!(globalThis as any).fetch) {
    (globalThis as any).fetch = () =>
      Promise.reject(new Error('fetch not available in Node'));
  }
}

/**
 * Inject IndexedDB globals from our implementation.
 * Called after the implementation modules are loaded.
 */
export function injectIndexedDB(_storagePath: string): void {
  // Will be populated when IDB classes are implemented
  // For now, set stubs so tests can at least load
}
