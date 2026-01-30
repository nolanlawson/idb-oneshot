# IndexedDB-over-SQLite

TypeScript IndexedDB implementation backed by better-sqlite3, targeting 90%+ WPT pass rate in Node v24.

## Commands

- **Lint**: `npx tsc --noEmit`
- **Run all WPT tests**: `node --experimental-strip-types test/run-all.ts`
- **Run single WPT test**: `node --experimental-strip-types test/wpt-runner.ts wpt/IndexedDB/<test>.any.js`
- **Run unit tests**: `node --test test/unit/`

## Conventions

- `type: "module"` — use ESM imports everywhere
- Node v24 with `--experimental-strip-types` — no build step needed
- Only `src/sqlite-backend.ts` imports `better-sqlite3`; all other src files use standard JS APIs
- One SQLite file per IndexedDB database; `_metadata.sqlite` tracks all databases
- Binary-comparable key encoding for correct IndexedDB key ordering via SQLite ORDER BY
- Each IDB transaction maps to a SQLite SAVEPOINT
- Request results computed synchronously (SQLite is sync), events dispatched async via setTimeout(0)
