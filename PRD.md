# IndexedDB-over-SQLite: Implementation Plan

## Overview

Build a TypeScript IndexedDB implementation backed by `better-sqlite3` that passes 90%+ of the WPT IndexedDB tests running unmodified in Node v24.

---

## Project Structure

```
/mnt/
  CLAUDE.md                        # Project conventions for agents
  package.json                     # type: "module", scripts
  tsconfig.json                    # noEmit, strict, ESNext
  src/
    index.ts                       # Public barrel export
    IDBFactory.ts                  # open(), deleteDatabase(), cmp(), databases()
    IDBDatabase.ts                 # IDBDatabase
    IDBTransaction.ts              # IDBTransaction + scheduling
    IDBObjectStore.ts              # IDBObjectStore
    IDBIndex.ts                    # IDBIndex
    IDBRequest.ts                  # IDBRequest, IDBOpenDBRequest
    IDBCursor.ts                   # IDBCursor, IDBCursorWithValue
    IDBKeyRange.ts                 # IDBKeyRange
    IDBVersionChangeEvent.ts       # IDBVersionChangeEvent
    DOMStringList.ts               # DOMStringList
    keys.ts                        # Key validation, comparison, binary encoding
    keypath.ts                     # Key path evaluation and injection
    structured-clone.ts            # Serialize/deserialize values for SQLite
    scheduling.ts                  # Event dispatch timing, request queues
    sqlite-backend.ts              # All better-sqlite3 interaction (only Node-specific file)
    errors.ts                      # DOMException helpers
    types.ts                       # Shared TypeScript interfaces
  test/
    wpt-runner.ts                  # Orchestrates running WPT tests
    wpt-harness-setup.ts           # Browser global shims for subprocess
    wpt-subprocess.ts              # Entry point for child process
    run-all.ts                     # Run all tests, output manifest
    manifest.yaml                  # Generated test results
    unit/                          # Unit tests (node:test)
      keys.test.ts
      keypath.test.ts
      structured-clone.test.ts
```

---

## Key Commands (for CLAUDE.md)

- **Lint**: `npx tsc --noEmit`
- **Run all WPT tests**: `node --experimental-strip-types test/run-all.ts`
- **Run single WPT test**: `node --experimental-strip-types test/wpt-runner.ts wpt/IndexedDB/idbkeyrange.any.js`
- **Run unit tests**: `node --test test/unit/`

---

## SQLite Schema Design

**One SQLite file per IndexedDB database** at `{storageDir}/{dbName}.sqlite`. A metadata file `{storageDir}/_metadata.sqlite` tracks known databases for `indexedDB.databases()`.

### Metadata DB schema:
```sql
CREATE TABLE databases (name TEXT PRIMARY KEY, version INTEGER NOT NULL);
```

### Per-database schema:
```sql
CREATE TABLE object_stores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  key_path TEXT,                    -- JSON: null | string | string[]
  auto_increment INTEGER NOT NULL DEFAULT 0,
  current_key INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE indexes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  object_store_id INTEGER NOT NULL REFERENCES object_stores(id),
  name TEXT NOT NULL,
  key_path TEXT NOT NULL,           -- JSON
  unique_index INTEGER NOT NULL DEFAULT 0,
  multi_entry INTEGER NOT NULL DEFAULT 0,
  UNIQUE(object_store_id, name)
);

CREATE TABLE records (
  object_store_id INTEGER NOT NULL,
  key BLOB NOT NULL,                -- Binary-encoded key (memcmp-sortable)
  value BLOB NOT NULL,              -- Structured-clone serialized
  PRIMARY KEY (object_store_id, key)
) WITHOUT ROWID;

CREATE TABLE index_entries (
  index_id INTEGER NOT NULL,
  key BLOB NOT NULL,                -- Binary-encoded index key
  primary_key BLOB NOT NULL,        -- Binary-encoded primary key
  PRIMARY KEY (index_id, key, primary_key)
) WITHOUT ROWID;
```

### Key Encoding (binary-comparable via memcmp)

Type tag byte determines cross-type ordering (per spec: number < date < string < binary < array):
- `0x10` number: tag + 8-byte IEEE 754 double with sign-bit flip
- `0x20` date: same encoding as number
- `0x30` string: tag + UTF-16 code units as big-endian uint16
- `0x40` binary: tag + raw bytes
- `0x50` array: tag + encoded elements + `0x00` terminator

---

## WPT Test Runner Architecture

### Subprocess model (one Node process per .any.js file)

1. **Parse `// META:` comments** from the test file to find script dependencies and timeout
2. **Fork child process** running `test/wpt-subprocess.ts`
3. Child process sets up globals, loads testharness.js, loads support scripts, loads test file
4. **Collect JSON results** from stdout (test name, status, message per subtest)
5. **Enforce timeout** (10s default, 60s for `// META: timeout=long`)
6. Aggregate into `manifest.yaml`

### Browser global shims (in wpt-subprocess.ts)

Node v24 already provides: `Event`, `EventTarget`, `DOMException`, `structuredClone`, `Blob`, `MessageChannel`, `setTimeout`, `clearTimeout`.

We must add:
```typescript
globalThis.self = globalThis;
globalThis.location = { pathname: '/IndexedDB/' + testFile, href: '...', toString() { return this.href; } };
// addEventListener/dispatchEvent on globalThis for testharness.js WindowTestEnvironment
const listeners = {};
globalThis.addEventListener = (type, fn) => { ... };
globalThis.removeEventListener = (type, fn) => { ... };
globalThis.dispatchEvent = (event) => { ... };
globalThis.document = { getElementsByTagName: () => [], title: '' };
// After all scripts loaded: globalThis.dispatchEvent(new Event('load'));
```

Inject IndexedDB globals:
```typescript
globalThis.indexedDB = new IDBFactory({ storagePath: tmpDir });
globalThis.IDBDatabase = IDBDatabase;
globalThis.IDBTransaction = IDBTransaction;
// ... all IDB* classes
```

### Result collection

Use `add_completion_callback` from testharness.js to capture results, write JSON to stdout.

---

## Implementation Phases

Each phase targets specific test files. Within each phase, work should be broken into tasks of 1-2 test files at a time.

### Phase 0: Project Scaffolding
**Goal**: `package.json`, `tsconfig.json`, `CLAUDE.md`, empty `src/index.ts`, working test runner that can execute (and fail) one WPT test.

**Files**: `package.json`, `tsconfig.json`, `CLAUDE.md`, `src/index.ts`, `test/wpt-runner.ts`, `test/wpt-subprocess.ts`, `test/wpt-harness-setup.ts`, `test/run-all.ts`

### Phase 1: IDBKeyRange + Key Validation + `historical.any.js`
**Target tests**: `key_valid.any.js`, `key_invalid.any.js`, `keyorder.any.js`, `idbkeyrange.any.js`, `idbkeyrange-includes.any.js`, `idbkeyrange_incorrect.any.js`, `idbfactory_cmp.any.js`, `historical.any.js`

**Files**: `src/keys.ts`, `src/IDBKeyRange.ts`, `src/errors.ts`, `src/types.ts`, `src/DOMStringList.ts`, `src/IDBFactory.ts` (just `cmp()` initially)

These tests are mostly synchronous and don't need full database support — ideal for validating the test runner.

### Phase 2: IDBFactory.open() + Database Lifecycle
**Target tests**: `idbfactory_open.any.js`, `idbfactory-open-request-success.any.js`, `idbfactory-open-request-error.any.js`, `idbfactory-open-error-properties.any.js`, `idbfactory_deleteDatabase.any.js`, `idbfactory-deleteDatabase-request-success.any.js`, `idbversionchangeevent.any.js`

**Files**: `src/IDBFactory.ts`, `src/IDBDatabase.ts`, `src/IDBRequest.ts`, `src/IDBVersionChangeEvent.ts`, `src/sqlite-backend.ts`, `src/scheduling.ts`

Core async infrastructure: event dispatch timing, request lifecycle, version change events.

### Phase 3: Object Store CRUD
**Target tests**: `idbdatabase_createObjectStore.any.js`, `idbdatabase_deleteObjectStore.any.js`, `idbobjectstore_add.any.js`, `idbobjectstore_put.any.js`, `idbobjectstore_get.any.js`, `idbobjectstore_getKey.any.js`, `idbobjectstore_delete.any.js`, `idbobjectstore_clear.any.js`, `idbobjectstore_count.any.js`, `idbobjectstore_keyPath.any.js`

**Files**: `src/IDBObjectStore.ts`, `src/IDBTransaction.ts`, `src/keypath.ts`, `src/structured-clone.ts`

### Phase 4: Indexes
**Target tests**: `idbobjectstore_createIndex.any.js`, `idbobjectstore_deleteIndex.any.js`, `idbobjectstore_index.any.js`, `idbindex_get.any.js`, `idbindex_getKey.any.js`, `idbindex_count.any.js`, `idbindex_keyPath.any.js`, `idbindex_indexNames.any.js`, `idbindex-multientry.any.js`, `idbindex-objectStore-SameObject.any.js`, `idbindex-request-source.any.js`

**Files**: `src/IDBIndex.ts`

### Phase 5: Cursors
**Target tests**: `idbcursor-continue.any.js`, `idbcursor-advance.any.js`, `idbcursor-direction.any.js`, `idbcursor-direction-index.any.js`, `idbcursor-direction-objectstore.any.js`, `idbcursor-direction-index-keyrange.any.js`, `idbcursor-direction-objectstore-keyrange.any.js`, `idbcursor-key.any.js`, `idbcursor-primarykey.any.js`, `idbcursor-source.any.js`, `idbcursor-reused.any.js`, `idbcursor-request.any.js`, `idbcursor-request-source.any.js`, `idbcursor_advance_index.any.js`, `idbcursor_advance_objectstore.any.js`, `idbcursor_continue_index.any.js`, `idbcursor_continue_objectstore.any.js`, `idbcursor_iterating.any.js`, `cursor-overloads.any.js`, `idbobjectstore_openCursor.any.js`, `idbobjectstore_openCursor_invalid.any.js`, `idbobjectstore_openKeyCursor.any.js`, `idbindex_openCursor.any.js`, `idbindex_openKeyCursor.any.js`, `idbindex_reverse_cursor.any.js`

**Files**: `src/IDBCursor.ts`

### Phase 6: Transaction Lifecycle + Scheduling ✅
**Target tests**: `idbtransaction.any.js`, `idbtransaction-oncomplete.any.js`, `idbtransaction_abort.any.js`, `idbtransaction_objectStoreNames.any.js`, `transaction-lifetime.any.js`, `transaction-lifetime-empty.any.js`, `transaction-deactivation-timing.any.js`, `transaction-requestqueue.any.js`, `transaction-create_in_versionchange.any.js`, `transaction-scheduling-*.any.js` (7 files), `writer-starvation.any.js`, `open-request-queue.any.js`, `delete-request-queue.any.js`

**Files**: `src/transaction-scheduler.ts` (new), `src/IDBTransaction.ts`, `src/IDBDatabase.ts`, `src/IDBObjectStore.ts`, `src/IDBIndex.ts`, `src/IDBCursor.ts`, `src/IDBRequest.ts`

### Phase 7: Transaction Abort + Metadata Revert ✅
**Target tests**: `transaction-abort-generator-revert.any.js`, `transaction-abort-index-metadata-revert.any.js`, `transaction-abort-multiple-metadata-revert.any.js`, `transaction-abort-object-store-metadata-revert.any.js`, `transaction-abort-request-error.any.js`

Uses SQLite `SAVEPOINT` / `ROLLBACK TO SAVEPOINT` for abort semantics.

### Phase 8: Exception Ordering + Rename ✅
**Target tests**: `idb*-exception-order.any.js` (15 files), `idbobjectstore-rename-*.any.js` (3 files), `idbindex-rename-*.any.js` (2 files)

### Phase 9: getAll / getAllKeys / getAllRecords
**Target tests**: `idbobjectstore_getAll.any.js`, `idbobjectstore_getAllKeys.any.js`, `idbobjectstore_getAll-options.any.js`, `idbobjectstore_getAllKeys-options.any.js`, `idbobjectstore_getAllRecords.any.js`, `idbindex_getAll.any.js`, `idbindex_getAllKeys.any.js`, `idbindex_getAll-options.any.js`, `idbindex_getAllKeys-options.any.js`, `idbindex_getAllRecords.any.js`, `*-enforcerange.any.js` (4 files)

### Phase 10: Structured Clone + Key Generator + Key Path Edge Cases
**Target tests**: `structured-clone.any.js`, `structured-clone-transaction-state.any.js`, `clone-before-keypath-eval.any.js`, `nested-cloning-*.any.js` (4 files), `value.any.js`, `value_recursive.any.js`, `keygenerator.any.js`, `keypath.any.js`, `keypath-exceptions.any.js`, `keypath-special-identifiers.any.js`, `keypath_invalid.any.js`, `keypath_maxsize.any.js`

### Phase 11: Event Bubbling + Error Handling
**Target tests**: `event-dispatch-active-flag.any.js`, `fire-error-event-exception.any.js`, `fire-success-event-exception.any.js`, `fire-upgradeneeded-event-exception.any.js`, `error-attributes.any.js`, `request_bubble-and-capture.any.js`, `transaction_bubble-and-capture.any.js`, `idbrequest-onupgradeneeded.any.js`, `idbrequest_error.any.js`, `idbrequest_result.any.js`

### Phase 12: Upgrade Transaction Lifecycle
**Target tests**: `upgrade-transaction-deactivation-timing.any.js`, `upgrade-transaction-lifecycle-backend-aborted.any.js`, `upgrade-transaction-lifecycle-committed.any.js`, `upgrade-transaction-lifecycle-user-aborted.any.js`, `abort-in-initial-upgradeneeded.any.js`, `close-in-upgradeneeded.any.js`

### Phase 13: Remaining Tests (auto-increment, interleaved cursors, binary keys, misc)
**Target tests**: All remaining `.any.js` files not covered above (~30 files), including:
- `reading-autoincrement-*.any.js` (4 files)
- `interleaved-cursors-*.any.js` (2 files)
- `idb-binary-key-*.any.js` (2 files)
- `request-event-ordering-*.any.js` (4 files)
- `idb-explicit-commit*.any.js` (2 files)
- `blob-*.any.js` (6 files)
- `bindings-inject-*.any.js` (2 files)
- `name-scopes.any.js`, `list_ordering.any.js`, `string-list-ordering.any.js`
- `get-databases.any.js`, `globalscope-indexedDB-SameObject.any.js`
- Various cursor update/delete files

### Phase 14: Performance Optimization
- Leverage SQLite indexes and prepared statements
- Batch operations where possible
- Connection pooling across transactions

---

## Tests to Skip (~13 files, browser-only)

These cannot run in Node and should be marked `skip` in the manifest:
- `back-forward-cache-*.window.js` (2) - browser navigation
- `idb-partitioned-*.sub.html` (3) - cross-origin iframes
- `database-names-by-origin.html` - multiple origins
- `idbfactory-deleteDatabase-opaque-origin.html` - opaque origins
- `idbfactory-open-opaque-origin.html` - opaque origins
- `idbfactory-origin-isolation.html` - origin isolation
- `idb_webworkers.htm` - Web Workers HTML
- `file_support.sub.html` - File API
- `serialize-sharedarraybuffer-throws.https.html` - SharedArrayBuffer
- `ready-state-destroyed-execution-context.html` - destroyed context
- `storage-buckets.https.any.js` - Storage Buckets API
- `worker-termination-aborts-upgrade.window.js` - Worker termination
- `idlharness.any.js` - WebIDL infrastructure
- `idbobjectstore-cross-realm-methods.html` - cross-realm
- `idbindex-cross-realm-methods.html` - cross-realm

---

## Key Technical Decisions

1. **Key encoding**: Binary-comparable encoding so SQLite `ORDER BY key` produces correct IndexedDB key ordering. This is the foundation — get it right and cursors/indexes "just work" at the SQL level.

2. **Transaction mapping**: Each IDB transaction = SQLite `SAVEPOINT`. Commit = `RELEASE SAVEPOINT`. Abort = `ROLLBACK TO SAVEPOINT`.

3. **Event dispatch timing**: Request results are computed synchronously (SQLite is sync), then events are dispatched asynchronously via `setTimeout(0)` to match spec's task-based model. Transaction is "active" during event handler + microtasks, then deactivates.

4. **Structured clone**: Custom binary serializer supporting all spec-required types. Start simple (JSON + type tags for Date/RegExp/ArrayBuffer/etc.), evolve as tests demand.

5. **Environment agnosticism**: `src/sqlite-backend.ts` is the only file that imports `better-sqlite3`. It could be swapped for a WASM SQLite later. All other `src/` files use only standard JS APIs.

6. **SameObject caching**: Cache objects returned by property accessors (e.g., `transaction.db`, `objectStore.transaction`) to satisfy `===` checks in tests.

---

## Manifest Format

```yaml
# test/manifest.yaml
generated: "2026-01-29T12:00:00Z"
summary:
  total_tests: 2500    # individual subtests across all files
  pass: 2300
  fail: 150
  timeout: 50
  pass_rate: "92.0%"
files:
  idbkeyrange.any.js:
    status: pass        # pass = all subtests pass, fail = any fail
    pass: 12
    fail: 0
    timeout: 0
    subtests:
      - name: "IDBKeyRange.only() returns an IDBKeyRange"
        status: pass
      # ...
  idbfactory_open.any.js:
    status: fail
    pass: 14
    fail: 1
    timeout: 0
    # comment: "Fails on blocked connection test - needs multi-connection support"
    subtests:
      - name: "IDBFactory.open() - request has no source"
        status: pass
      # ...
```

---

## Verification Plan

1. **Unit tests**: `node --test test/unit/` — validates key encoding, key path evaluation, structured clone independently
2. **Single WPT test**: `node --experimental-strip-types test/wpt-runner.ts wpt/IndexedDB/idbkeyrange.any.js` — validates test runner infrastructure
3. **Full WPT suite**: `node --experimental-strip-types test/run-all.ts` — produces manifest with pass rate
4. **Lint**: `npx tsc --noEmit` — ensures type safety
5. **Target metric**: 90%+ of individual subtests passing across all testable `.any.js` files
