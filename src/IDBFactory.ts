// IDBFactory implementation

import { valueToKeyOrThrow, compareKeys } from './keys.ts';
import type { IDBValidKey } from './types.ts';
import { IDBOpenDBRequest } from './IDBRequest.ts';
import { IDBDatabase } from './IDBDatabase.ts';
import { IDBTransaction } from './IDBTransaction.ts';
import { IDBVersionChangeEvent } from './IDBVersionChangeEvent.ts';
import { DOMStringList } from './DOMStringList.ts';
import { SQLiteBackend } from './sqlite-backend.ts';
import { queueTask } from './scheduling.ts';

export interface IDBFactoryOptions {
  storagePath: string;
}

export class IDBFactory {
  private _storagePath: string;
  private _backend: SQLiteBackend;
  // Track open connections for versionchange notifications
  private _openConnections: Map<string, Set<IDBDatabase>> = new Map();

  constructor(options: IDBFactoryOptions) {
    this._storagePath = options.storagePath;
    this._backend = new SQLiteBackend(options.storagePath);
  }

  cmp(first: any, second: any): number {
    if (arguments.length < 2) {
      throw new TypeError(
        "Failed to execute 'cmp' on 'IDBFactory': 2 arguments required, but only " +
          arguments.length +
          ' present.'
      );
    }
    const a = valueToKeyOrThrow(first);
    const b = valueToKeyOrThrow(second);
    return compareKeys(a as IDBValidKey, b as IDBValidKey);
  }

  open(name: string, version?: number): IDBOpenDBRequest {
    if (arguments.length < 1) {
      throw new TypeError(
        "Failed to execute 'open' on 'IDBFactory': 1 argument required, but only 0 present."
      );
    }

    // Coerce name to string
    name = String(name);

    // Validate version
    if (version !== undefined) {
      version = Math.floor(Number(version));
      if (Number.isNaN(version) || version < 1 || version > 0x1FFFFFFFFFFFFF) {
        throw new TypeError(
          "Failed to execute 'open' on 'IDBFactory': The optional version argument must be a positive integer."
        );
      }
    }

    const request = new IDBOpenDBRequest();
    request._source = null;

    queueTask(() => {
      this._runOpenSteps(name, version, request);
    });

    return request;
  }

  deleteDatabase(name: string): IDBOpenDBRequest {
    if (arguments.length < 1) {
      throw new TypeError(
        "Failed to execute 'deleteDatabase' on 'IDBFactory': 1 argument required, but only 0 present."
      );
    }

    name = String(name);

    const request = new IDBOpenDBRequest();
    request._source = null;

    queueTask(() => {
      this._runDeleteSteps(name, request);
    });

    return request;
  }

  databases(): Promise<Array<{ name: string; version: number }>> {
    return Promise.resolve(this._backend.listDatabases());
  }

  private _runOpenSteps(name: string, version: number | undefined, request: IDBOpenDBRequest): void {
    try {
      const existingVersion = this._backend.getDatabaseVersion(name);
      const dbExists = this._backend.databaseExists(name);

      // If version is undefined, use existing version or 1 for new databases
      let requestedVersion: number;
      if (version === undefined) {
        requestedVersion = dbExists ? existingVersion : 1;
      } else {
        requestedVersion = version;
      }

      // If the database exists and version is lower than current, fire error
      if (dbExists && requestedVersion < existingVersion) {
        request._readyState = 'done';
        request._error = new DOMException(
          `The requested version (${requestedVersion}) is less than the existing version (${existingVersion}).`,
          'VersionError'
        );
        const errorEvent = new Event('error', { bubbles: true, cancelable: true });
        request.dispatchEvent(errorEvent);
        return;
      }

      // Ensure database is initialized in SQLite
      this._backend.getDatabase(name);

      // Create the database connection
      const db = new IDBDatabase(name, requestedVersion, this._backend);

      // Track this connection
      if (!this._openConnections.has(name)) {
        this._openConnections.set(name, new Set());
      }

      const needsUpgrade = !dbExists || requestedVersion > existingVersion;

      if (needsUpgrade) {
        // Run upgrade transaction
        const oldVersion = dbExists ? existingVersion : 0;

        // Get current store names for the upgrade transaction scope
        const storeNames = this._backend.getObjectStoreNames(name);

        // Create versionchange transaction
        const tx = new IDBTransaction(db, storeNames, 'versionchange' as IDBTransactionMode);
        db._upgradeTransaction = tx;
        request._transaction = tx;
        request._readyState = 'done';
        request._result = db;

        // Set up completion handling
        db._onVersionChangeComplete = (aborted: boolean) => {
          db._upgradeTransaction = null;
          request._transaction = null;

          if (aborted) {
            // Fire error on the request
            request._result = undefined;
            request._error = new DOMException('The transaction was aborted.', 'AbortError');
            const errorEvent = new Event('error', { bubbles: true, cancelable: true });
            request.dispatchEvent(errorEvent);
          } else {
            // Commit the version to metadata
            this._backend.setDatabaseVersion(name, requestedVersion);
            db._version = requestedVersion;

            // Add to open connections
            this._openConnections.get(name)!.add(db);

            // Fire success
            const successEvent = new Event('success', { bubbles: false, cancelable: false });
            request.dispatchEvent(successEvent);
          }
        };

        // Fire upgradeneeded event
        const upgradeEvent = new IDBVersionChangeEvent('upgradeneeded', {
          oldVersion,
          newVersion: requestedVersion,
        });
        request.dispatchEvent(upgradeEvent);

        // After upgradeneeded handlers run, deactivate transaction
        // Use queueMicrotask to allow sync handlers to complete
        queueMicrotask(() => {
          if (tx._state === 'active' && !tx._aborted) {
            tx._deactivate();
            tx._maybeAutoCommit();
          }
        });
      } else {
        // No upgrade needed - just open
        request._readyState = 'done';
        request._result = db;

        // Add to open connections
        this._openConnections.get(name)!.add(db);

        // Fire success
        const successEvent = new Event('success', { bubbles: false, cancelable: false });
        request.dispatchEvent(successEvent);
      }
    } catch (err) {
      request._readyState = 'done';
      request._error = err instanceof DOMException
        ? err
        : new DOMException(String(err), 'UnknownError');
      const errorEvent = new Event('error', { bubbles: true, cancelable: true });
      request.dispatchEvent(errorEvent);
    }
  }

  private _runDeleteSteps(name: string, request: IDBOpenDBRequest): void {
    try {
      const existingVersion = this._backend.getDatabaseVersion(name);
      const dbExists = this._backend.databaseExists(name);

      const oldVersion = dbExists ? existingVersion : 0;

      // Send versionchange events to open (non-closed) connections
      const connections = this._openConnections.get(name);
      if (connections) {
        for (const conn of connections) {
          if (conn._closePending) continue;
          const versionChangeEvent = new IDBVersionChangeEvent('versionchange', {
            oldVersion: conn._version,
            newVersion: null,
          });
          conn.dispatchEvent(versionChangeEvent);
        }
      }

      // Delete the database
      if (dbExists) {
        this._backend.deleteDatabaseRecord(name);
      }

      // Clear tracked connections
      if (connections) {
        connections.clear();
      }

      request._readyState = 'done';
      request._result = undefined;

      // Fire success as a versionchange event
      const successEvent = new IDBVersionChangeEvent('success', {
        oldVersion,
        newVersion: null,
      });
      request.dispatchEvent(successEvent);
    } catch (err) {
      request._readyState = 'done';
      request._error = err instanceof DOMException
        ? err
        : new DOMException(String(err), 'UnknownError');
      const errorEvent = new Event('error', { bubbles: true, cancelable: true });
      request.dispatchEvent(errorEvent);
    }
  }
}
