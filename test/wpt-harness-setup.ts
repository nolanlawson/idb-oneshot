/**
 * Browser global shims for WPT testharness.js running in Node.
 * This must be called before loading testharness.js.
 */

import {
  IDBFactory,
  IDBKeyRange,
  IDBRequest,
  IDBOpenDBRequest,
  IDBDatabase,
  IDBTransaction,
  IDBObjectStore,
  IDBIndex,
  IDBCursor,
  IDBCursorWithValue,
  IDBVersionChangeEvent,
  DOMStringList,
} from '../src/index.ts';

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
export function injectIndexedDB(storagePath: string): void {
  const factory = new IDBFactory({ storagePath });

  (globalThis as any).indexedDB = factory;
  (globalThis as any).IDBFactory = IDBFactory;
  (globalThis as any).IDBKeyRange = IDBKeyRange;
  (globalThis as any).IDBRequest = IDBRequest;
  (globalThis as any).IDBOpenDBRequest = IDBOpenDBRequest;
  (globalThis as any).IDBDatabase = IDBDatabase;
  (globalThis as any).IDBTransaction = IDBTransaction;
  (globalThis as any).IDBObjectStore = IDBObjectStore;
  (globalThis as any).IDBIndex = IDBIndex;
  (globalThis as any).IDBCursor = IDBCursor;
  (globalThis as any).IDBCursorWithValue = IDBCursorWithValue;
  (globalThis as any).IDBVersionChangeEvent = IDBVersionChangeEvent;
  (globalThis as any).DOMStringList = DOMStringList;
}
