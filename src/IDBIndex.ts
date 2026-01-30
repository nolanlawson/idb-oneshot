// IDBIndex implementation

import { openIndexCursor } from './IDBCursor.ts';
import { IDBKeyRange } from './IDBKeyRange.ts';
import { IDBRecord } from './IDBRecord.ts';
import { IDBRequest } from './IDBRequest.ts';
import { encodeKey, valueToKeyOrThrow, decodeKey } from './keys.ts';
import type { IDBValidKey } from './types.ts';

const decodeKeyFromBuffer = decodeKey;

/**
 * Validate a count parameter per WebIDL [EnforceRange] for unsigned long.
 */
function enforceRangeCount(count: any): number | undefined {
  if (count === undefined) return undefined;
  const n = Number(count);
  if (!Number.isFinite(n) || n < 0 || n > 4294967295 || Number.isNaN(n)) {
    throw new TypeError(
      `Failed to execute 'getAll' on 'IDBIndex': Value is outside the 'unsigned long' value range.`
    );
  }
  return n >>> 0;
}

/**
 * Parse getAll/getAllKeys/getAllRecords arguments.
 */
function parseGetAllArgs(
  queryOrOptions: any,
  countArg?: any,
  supportDictionary: boolean = false
): {
  lower: Uint8Array | null;
  upper: Uint8Array | null;
  lowerOpen: boolean;
  upperOpen: boolean;
  count: number | undefined;
  direction: string;
} {
  let query: any = undefined;
  let count: number | undefined;
  let direction: string = 'next';

  if (supportDictionary && queryOrOptions !== null && queryOrOptions !== undefined &&
      typeof queryOrOptions === 'object' && !(queryOrOptions instanceof IDBKeyRange) &&
      !Array.isArray(queryOrOptions) && !(queryOrOptions instanceof ArrayBuffer) &&
      !ArrayBuffer.isView(queryOrOptions) && !(queryOrOptions instanceof Date)) {
    query = queryOrOptions.query;
    count = enforceRangeCount(queryOrOptions.count);
    if (queryOrOptions.direction !== undefined) {
      direction = queryOrOptions.direction;
    }
  } else {
    query = queryOrOptions;
    count = enforceRangeCount(countArg);
  }

  let lower: Uint8Array | null = null;
  let upper: Uint8Array | null = null;
  let lowerOpen = false;
  let upperOpen = false;

  if (query !== undefined && query !== null) {
    if (query instanceof IDBKeyRange) {
      lower = query.lower !== undefined ? encodeKey(query.lower) : null;
      upper = query.upper !== undefined ? encodeKey(query.upper) : null;
      lowerOpen = query.lowerOpen;
      upperOpen = query.upperOpen;
    } else {
      const key = valueToKeyOrThrow(query);
      const encoded = encodeKey(key);
      lower = encoded;
      upper = encoded;
      lowerOpen = false;
      upperOpen = false;
    }
  }

  return { lower, upper, lowerOpen, upperOpen, count, direction };
}

/**
 * Convert a query parameter to either an exact key or key range for index queries.
 */
function queryToRange(query: any): { lower: Uint8Array | null; upper: Uint8Array | null; lowerOpen: boolean; upperOpen: boolean } | { exact: Uint8Array } {
  if (query instanceof IDBKeyRange) {
    return {
      lower: query.lower !== undefined ? encodeKey(query.lower) : null,
      upper: query.upper !== undefined ? encodeKey(query.upper) : null,
      lowerOpen: query.lowerOpen,
      upperOpen: query.upperOpen,
    };
  }
  const key = valueToKeyOrThrow(query);
  return { exact: encodeKey(key) };
}

export class IDBIndex {
  get [Symbol.toStringTag]() { return 'IDBIndex'; }

  _objectStore: any; // IDBObjectStore
  _name: string;
  _keyPath: string | string[];
  _unique: boolean;
  _multiEntry: boolean;
  _indexId: number;
  _deleted: boolean = false;
  _keyPathCache: any = undefined; // for SameObject on keyPath
  _createdInTransaction: any = null; // Track which versionchange transaction created this index

  constructor(objectStore: any, name: string, indexId: number, keyPath: string | string[], unique: boolean, multiEntry: boolean) {
    this._objectStore = objectStore;
    this._name = name;
    this._indexId = indexId;
    this._keyPath = keyPath;
    this._unique = unique;
    this._multiEntry = multiEntry;
  }

  get name(): string {
    return this._name;
  }

  set name(newName: string) {
    const txn = this._objectStore._transaction;

    // Per spec exception ordering:
    // 1. InvalidStateError if not in a versionchange transaction
    if (txn._mode !== 'versionchange') {
      throw new DOMException(
        "Failed to set the 'name' property on 'IDBIndex': The database is not running a version change transaction.",
        'InvalidStateError'
      );
    }

    // 2. InvalidStateError if the index has been deleted
    const isDeletedByAbort = this._createdInTransaction !== null && this._createdInTransaction._aborted;
    if (this._deleted || isDeletedByAbort) {
      throw new DOMException(
        "Failed to set the 'name' property on 'IDBIndex': The index has been deleted.",
        'InvalidStateError'
      );
    }

    // 3. TransactionInactiveError if transaction is not active
    if (txn._state !== 'active') {
      throw new DOMException(
        "Failed to set the 'name' property on 'IDBIndex': The transaction is not active.",
        'TransactionInactiveError'
      );
    }

    // Stringify the name (may throw if toString() throws)
    newName = String(newName);

    // If same name, no-op
    if (newName === this._name) {
      return;
    }

    // 4. ConstraintError if another index on the same store already has this name
    const existingNames = txn._db._backend.getIndexNames(
      txn._db._name,
      this._objectStore._storeId
    );
    if (existingNames.includes(newName)) {
      throw new DOMException(
        `An index with the name '${newName}' already exists.`,
        'ConstraintError'
      );
    }

    txn._ensureSavepoint();

    const oldName = this._name;

    // Update in SQLite
    txn._db._backend.renameIndex(
      txn._db._name,
      this._objectStore._storeId,
      oldName,
      newName
    );

    // Update in-memory state
    this._name = newName;

    // Update object store's index cache
    this._objectStore._indexCache.delete(oldName);
    this._objectStore._indexCache.set(newName, this);

    // Invalidate index names cache
    this._objectStore._indexNamesCache = null;

    // Track rename for abort revert
    if (!txn._renamedIndexes) {
      txn._renamedIndexes = [];
    }
    txn._renamedIndexes.push({ index: this, store: this._objectStore, oldName, newName });
  }

  get objectStore(): any {
    return this._objectStore;
  }

  get keyPath(): string | string[] {
    if (Array.isArray(this._keyPath)) {
      if (this._keyPathCache === undefined) {
        this._keyPathCache = [...this._keyPath];
      }
      return this._keyPathCache;
    }
    return this._keyPath;
  }

  get multiEntry(): boolean {
    return this._multiEntry;
  }

  get unique(): boolean {
    return this._unique;
  }

  private _ensureValid(): void {
    // Check if the index was created during a versionchange that was subsequently aborted
    const isDeletedByAbort = this._createdInTransaction !== null &&
      this._createdInTransaction._aborted;
    if (this._deleted || isDeletedByAbort) {
      throw new DOMException(
        'The index has been deleted.',
        'InvalidStateError'
      );
    }
    if (this._objectStore._deleted) {
      throw new DOMException(
        'The object store has been deleted.',
        'InvalidStateError'
      );
    }
    if (this._objectStore._transaction._state !== 'active') {
      throw new DOMException(
        'The transaction is not active.',
        'TransactionInactiveError'
      );
    }
  }

  private get _transaction(): any {
    return this._objectStore._transaction;
  }

  private get _backend(): any {
    return this._objectStore._transaction._db._backend;
  }

  private get _dbName(): string {
    return this._objectStore._transaction._db._name;
  }

  get(query: any): IDBRequest {
    this._ensureValid();

    if (arguments.length === 0) {
      throw new TypeError("Failed to execute 'get' on 'IDBIndex': 1 argument required, but only 0 present.");
    }

    const range = queryToRange(query);
    const request = this._transaction._createRequest(this);
    const idx = this;

    this._transaction._queueOperation(
      () => {
        let resultValue: any;
        if ('exact' in range) {
          const record = idx._backend.getRecordByIndexKey(
            idx._dbName, idx._indexId, range.exact
          );
          resultValue = record ? JSON.parse(record.value.toString()) : undefined;
        } else {
          const record = idx._backend.getRecordByIndexRange(
            idx._dbName, idx._indexId,
            range.lower, range.upper, range.lowerOpen, range.upperOpen
          );
          resultValue = record ? JSON.parse(record.value.toString()) : undefined;
        }
        request._readyState = 'done';
        request._result = resultValue;
      },
      () => {
        idx._transaction._state = 'active';
        const event = new Event('success', { bubbles: false, cancelable: false });
        request.dispatchEvent(event);
        idx._transaction._deactivate();
        idx._transaction._requestFinished();
      }
    );

    return request;
  }

  getKey(query: any): IDBRequest {
    this._ensureValid();

    if (arguments.length === 0) {
      throw new TypeError("Failed to execute 'getKey' on 'IDBIndex': 1 argument required, but only 0 present.");
    }

    const range = queryToRange(query);
    const request = this._transaction._createRequest(this);
    const idx = this;

    this._transaction._queueOperation(
      () => {
        let resultKey: any;
        if ('exact' in range) {
          const record = idx._backend.getRecordByIndexKey(
            idx._dbName, idx._indexId, range.exact
          );
          resultKey = record ? decodeKeyFromBuffer(record.primaryKey) : undefined;
        } else {
          const record = idx._backend.getRecordByIndexRange(
            idx._dbName, idx._indexId,
            range.lower, range.upper, range.lowerOpen, range.upperOpen
          );
          resultKey = record ? decodeKeyFromBuffer(record.primaryKey) : undefined;
        }
        request._readyState = 'done';
        request._result = resultKey;
      },
      () => {
        idx._transaction._state = 'active';
        const event = new Event('success', { bubbles: false, cancelable: false });
        request.dispatchEvent(event);
        idx._transaction._deactivate();
        idx._transaction._requestFinished();
      }
    );

    return request;
  }

  count(query?: any): IDBRequest {
    this._ensureValid();

    const request = this._transaction._createRequest(this);
    const idx = this;

    // Pre-compute query params synchronously
    let queryParams: any;
    if (query === undefined) {
      queryParams = { type: 'all' };
    } else if (query instanceof IDBKeyRange) {
      queryParams = {
        type: 'range',
        lower: query.lower !== undefined ? encodeKey(query.lower) : null,
        upper: query.upper !== undefined ? encodeKey(query.upper) : null,
        lowerOpen: query.lowerOpen,
        upperOpen: query.upperOpen,
      };
    } else {
      const key = valueToKeyOrThrow(query);
      const encodedKey = encodeKey(key);
      queryParams = { type: 'exact', key: encodedKey };
    }

    this._transaction._queueOperation(
      () => {
        let cnt: number;
        if (queryParams.type === 'all') {
          cnt = idx._backend.countIndexEntries(idx._dbName, idx._indexId);
        } else if (queryParams.type === 'range') {
          cnt = idx._backend.countIndexEntries(
            idx._dbName, idx._indexId,
            queryParams.lower, queryParams.upper, queryParams.lowerOpen, queryParams.upperOpen
          );
        } else {
          cnt = idx._backend.countIndexEntries(
            idx._dbName, idx._indexId,
            queryParams.key, queryParams.key, false, false
          );
        }
        request._readyState = 'done';
        request._result = cnt;
      },
      () => {
        idx._transaction._state = 'active';
        const event = new Event('success', { bubbles: false, cancelable: false });
        request.dispatchEvent(event);
        idx._transaction._deactivate();
        idx._transaction._requestFinished();
      }
    );

    return request;
  }

  getAll(queryOrOptions?: any, count?: number): IDBRequest {
    this._ensureValid();

    const hasDictSupport = typeof this.getAllRecords === 'function';
    const parsed = parseGetAllArgs(queryOrOptions, count, hasDictSupport);

    const request = this._transaction._createRequest(this);
    const idx = this;

    this._transaction._queueOperation(
      () => {
        const direction = (parsed.direction as any) || 'next';
        const storeId = idx._objectStore._storeId;
        const rows = idx._backend.getAllIndexEntries(
          idx._dbName,
          idx._indexId,
          storeId,
          parsed.lower,
          parsed.upper,
          parsed.lowerOpen,
          parsed.upperOpen,
          direction,
          // For unique directions, we don't limit at SQL level
          (parsed.count !== undefined && parsed.count > 0 &&
           direction !== 'nextunique' && direction !== 'prevunique')
            ? parsed.count : undefined
        );
        const results: any[] = [];
        // Apply unique filtering if needed
        let filteredRows = rows;
        if (direction === 'nextunique' || direction === 'prevunique') {
          const seen = new Set<string>();
          filteredRows = [];
          for (const row of rows) {
            const keyHex = Buffer.from(row.index_key).toString('hex');
            if (!seen.has(keyHex)) {
              seen.add(keyHex);
              filteredRows.push(row);
            }
          }
        }
        const limit = (parsed.count !== undefined && parsed.count > 0) ? parsed.count : filteredRows.length;
        for (let i = 0; i < Math.min(limit, filteredRows.length); i++) {
          results.push(JSON.parse(filteredRows[i].value.toString()));
        }
        request._readyState = 'done';
        request._result = results;
      },
      () => {
        idx._transaction._state = 'active';
        const event = new Event('success', { bubbles: false, cancelable: false });
        request.dispatchEvent(event);
        idx._transaction._deactivate();
        idx._transaction._requestFinished();
      }
    );

    return request;
  }

  getAllKeys(queryOrOptions?: any, count?: number): IDBRequest {
    this._ensureValid();

    const hasDictSupport = typeof this.getAllRecords === 'function';
    const parsed = parseGetAllArgs(queryOrOptions, count, hasDictSupport);

    const request = this._transaction._createRequest(this);
    const idx = this;

    this._transaction._queueOperation(
      () => {
        const direction = (parsed.direction as any) || 'next';
        const storeId = idx._objectStore._storeId;
        const rows = idx._backend.getAllIndexEntries(
          idx._dbName,
          idx._indexId,
          storeId,
          parsed.lower,
          parsed.upper,
          parsed.lowerOpen,
          parsed.upperOpen,
          direction,
          (parsed.count !== undefined && parsed.count > 0 &&
           direction !== 'nextunique' && direction !== 'prevunique')
            ? parsed.count : undefined
        );
        const results: any[] = [];
        let filteredRows = rows;
        if (direction === 'nextunique' || direction === 'prevunique') {
          const seen = new Set<string>();
          filteredRows = [];
          for (const row of rows) {
            const keyHex = Buffer.from(row.index_key).toString('hex');
            if (!seen.has(keyHex)) {
              seen.add(keyHex);
              filteredRows.push(row);
            }
          }
        }
        const limit = (parsed.count !== undefined && parsed.count > 0) ? parsed.count : filteredRows.length;
        for (let i = 0; i < Math.min(limit, filteredRows.length); i++) {
          results.push(decodeKeyFromBuffer(filteredRows[i].primary_key));
        }
        request._readyState = 'done';
        request._result = results;
      },
      () => {
        idx._transaction._state = 'active';
        const event = new Event('success', { bubbles: false, cancelable: false });
        request.dispatchEvent(event);
        idx._transaction._deactivate();
        idx._transaction._requestFinished();
      }
    );

    return request;
  }

  getAllRecords(options?: any): IDBRequest {
    this._ensureValid();

    const parsed = parseGetAllArgs(options, undefined, true);

    const request = this._transaction._createRequest(this);
    const idx = this;

    this._transaction._queueOperation(
      () => {
        const direction = (parsed.direction as any) || 'next';
        const storeId = idx._objectStore._storeId;
        const rows = idx._backend.getAllIndexEntries(
          idx._dbName,
          idx._indexId,
          storeId,
          parsed.lower,
          parsed.upper,
          parsed.lowerOpen,
          parsed.upperOpen,
          direction
        );
        const results: any[] = [];
        let filteredRows = rows;
        if (direction === 'nextunique' || direction === 'prevunique') {
          const seen = new Set<string>();
          filteredRows = [];
          for (const row of rows) {
            const keyHex = Buffer.from(row.index_key).toString('hex');
            if (!seen.has(keyHex)) {
              seen.add(keyHex);
              filteredRows.push(row);
            }
          }
        }
        const limit = (parsed.count !== undefined && parsed.count > 0) ? parsed.count : filteredRows.length;
        for (let i = 0; i < Math.min(limit, filteredRows.length); i++) {
          const row = filteredRows[i];
          const key = decodeKeyFromBuffer(row.index_key);
          const primaryKey = decodeKeyFromBuffer(row.primary_key);
          const value = JSON.parse(row.value.toString());
          results.push(new IDBRecord(key, primaryKey, value));
        }
        request._readyState = 'done';
        request._result = results;
      },
      () => {
        idx._transaction._state = 'active';
        const event = new Event('success', { bubbles: false, cancelable: false });
        request.dispatchEvent(event);
        idx._transaction._deactivate();
        idx._transaction._requestFinished();
      }
    );

    return request;
  }

  openCursor(query?: any, direction?: IDBCursorDirection): IDBRequest {
    this._ensureValid();
    const dir = direction ?? 'next';
    if (!['next', 'nextunique', 'prev', 'prevunique'].includes(dir)) {
      throw new TypeError(`Failed to execute 'openCursor' on 'IDBIndex': The provided value '${dir}' is not a valid enum value of type IDBCursorDirection.`);
    }
    return openIndexCursor(this, this._transaction, query, dir, false);
  }

  openKeyCursor(query?: any, direction?: IDBCursorDirection): IDBRequest {
    this._ensureValid();
    const dir = direction ?? 'next';
    if (!['next', 'nextunique', 'prev', 'prevunique'].includes(dir)) {
      throw new TypeError(`Failed to execute 'openKeyCursor' on 'IDBIndex': The provided value '${dir}' is not a valid enum value of type IDBCursorDirection.`);
    }
    return openIndexCursor(this, this._transaction, query, dir, true);
  }
}
