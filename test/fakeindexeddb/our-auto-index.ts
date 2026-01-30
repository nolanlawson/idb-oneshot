import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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
} from "../../src/index.ts";

const storagePath = mkdtempSync(path.join(tmpdir(), "idb-wpt-"));

const factory = new IDBFactory({ storagePath });

const globals: Record<string, any> = {
  indexedDB: factory,
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
  // IDBKeyRange shortcuts used by some tests
  IDBKeyRange_only: IDBKeyRange.only.bind(IDBKeyRange),
};

const descriptors: PropertyDescriptorMap = {};
for (const [key, value] of Object.entries(globals)) {
  descriptors[key] = {
    value,
    writable: true,
    configurable: true,
    enumerable: false,
  };
}
Object.defineProperties(globalThis, descriptors);

process.on("exit", () => {
  try {
    rmSync(storagePath, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});
