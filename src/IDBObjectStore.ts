// IDBObjectStore implementation

import { DOMStringList } from './DOMStringList.ts';
import { openObjectStoreCursor } from './IDBCursor.ts';
import { IDBIndex } from './IDBIndex.ts';
import { IDBKeyRange } from './IDBKeyRange.ts';
import { IDBRecord } from './IDBRecord.ts';
import { IDBRequest } from './IDBRequest.ts';
import { encodeKey, valueToKey, valueToKeyOrThrow, decodeKey } from './keys.ts';
import { serialize, deserialize, cloneValue } from './structured-clone.ts';
import {
  isValidKeyPath, isValidKeyPathString,
  extractKeyFromValue, evaluateKeyPath, evaluateKeyPathDetailed,
  evaluateKeyPathRaw, KEY_NOT_VALID,
  injectKeyIntoValue, canInjectKey,
} from './keypath.ts';
import type { IDBValidKey } from './types.ts';

export { isValidKeyPath } from './keypath.ts';

/**
 * Validate a count parameter per WebIDL [EnforceRange] for unsigned long.
 * Returns undefined if no count (meaning "all"), or a valid unsigned long.
 */
function enforceRangeCount(count: any): number | undefined {
  if (count === undefined) return undefined;
  const n = Number(count);
  if (!Number.isFinite(n) || n < 0 || n > 4294967295 || Number.isNaN(n)) {
    throw new TypeError(
      `Failed to execute 'getAll' on 'IDBObjectStore': Value is outside the 'unsigned long' value range.`
    );
  }
  return n >>> 0; // Convert to unsigned 32-bit integer
}

/**
 * Parse a query that could be a key, IDBKeyRange, or an options dictionary with {query, count, direction}.
 * Returns { lower, upper, lowerOpen, upperOpen, count, direction } for range queries,
 * or { exact, count, direction } for exact key queries.
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

  // Check if first arg is an options dictionary (has getAllRecords support)
  if (supportDictionary && queryOrOptions !== null && queryOrOptions !== undefined &&
      typeof queryOrOptions === 'object' && !(queryOrOptions instanceof IDBKeyRange) &&
      !Array.isArray(queryOrOptions) && !(queryOrOptions instanceof ArrayBuffer) &&
      !ArrayBuffer.isView(queryOrOptions) && !(queryOrOptions instanceof Date)) {
    // Options dictionary
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
 * Convert a query parameter to either a key or key range.
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

export class IDBObjectStore {
  get [Symbol.toStringTag]() { return 'IDBObjectStore'; }

  _transaction: any; // IDBTransaction
  _name: string;
  _keyPath: string | string[] | null;
  _autoIncrement: boolean;
  _storeId: number;
  _indexNamesCache: DOMStringList | null = null;
  _indexCache: Map<string, IDBIndex> = new Map();
  _deleted: boolean = false;

  constructor(transaction: any, name: string) {
    this._transaction = transaction;
    this._name = name;

    // Load metadata from backend
    const meta = transaction._db._backend.getObjectStoreMetadata(
      transaction._db._name,
      name
    );
    if (!meta) {
      throw new DOMException(
        `Object store '${name}' not found`,
        'NotFoundError'
      );
    }
    this._storeId = meta.id;
    this._keyPath = meta.keyPath;
    this._autoIncrement = meta.autoIncrement;
  }

  get name(): string {
    return this._name;
  }

  set name(newName: string) {
    const txn = this._transaction;

    // Per spec exception ordering:
    // 1. InvalidStateError if not in a versionchange transaction
    if (txn._mode !== 'versionchange') {
      throw new DOMException(
        "Failed to set the 'name' property on 'IDBObjectStore': The database is not running a version change transaction.",
        'InvalidStateError'
      );
    }

    // 2. InvalidStateError if the store has been deleted
    if (this._deleted) {
      throw new DOMException(
        "Failed to set the 'name' property on 'IDBObjectStore': The object store has been deleted.",
        'InvalidStateError'
      );
    }

    // 3. TransactionInactiveError if transaction is not active
    if (txn._state !== 'active') {
      throw new DOMException(
        "Failed to set the 'name' property on 'IDBObjectStore': The transaction is not active.",
        'TransactionInactiveError'
      );
    }

    // Stringify the name (may throw if toString() throws)
    newName = String(newName);

    // If same name, no-op
    if (newName === this._name) {
      return;
    }

    // 4. ConstraintError if another store already has this name
    const existingNames = txn._db._backend.getObjectStoreNames(txn._db._name);
    if (existingNames.includes(newName)) {
      throw new DOMException(
        `An object store with the name '${newName}' already exists.`,
        'ConstraintError'
      );
    }

    txn._ensureSavepoint();

    const oldName = this._name;

    // Update in SQLite
    txn._db._backend.renameObjectStore(txn._db._name, oldName, newName);

    // Update in-memory state
    this._name = newName;

    // Update transaction's object store cache
    txn._objectStoreCache.delete(oldName);
    txn._objectStoreCache.set(newName, this);

    // Update transaction's store names and objectStoreNames
    const idx = txn._storeNames.indexOf(oldName);
    if (idx !== -1) {
      txn._storeNames[idx] = newName;
      txn._storeNames.sort();
    }
    txn._objectStoreNames = new DOMStringList(txn._storeNames);

    // Invalidate database's objectStoreNames cache
    txn._db._objectStoreNamesCache = null;

    // Track rename for abort revert
    if (!txn._renamedStores) {
      txn._renamedStores = [];
    }
    txn._renamedStores.push({ store: this, oldName, newName });
  }

  get keyPath(): string | string[] | null {
    return this._keyPath;
  }

  get indexNames(): DOMStringList {
    if (!this._indexNamesCache) {
      const names = this._transaction._db._backend.getIndexNames(
        this._transaction._db._name,
        this._storeId
      );
      this._indexNamesCache = new DOMStringList(names);
    }
    return this._indexNamesCache;
  }

  get transaction(): any {
    return this._transaction;
  }

  get autoIncrement(): boolean {
    return this._autoIncrement;
  }

  put(value: any, key?: any): IDBRequest {
    return this._addOrPut(value, key, false);
  }

  add(value: any, key?: any): IDBRequest {
    return this._addOrPut(value, key, true);
  }

  private _addOrPut(value: any, key: any, noOverwrite: boolean): IDBRequest {
    this._ensureValid();
    if (this._transaction._mode === 'readonly') {
      throw new DOMException('The transaction is read-only.', 'ReadOnlyError');
    }

    // Per spec: clone the value using structured clone BEFORE key path evaluation.
    // The transaction should be temporarily inactive during cloning.
    const savedState = this._transaction._state;
    this._transaction._state = 'inactive_clone';
    let clonedValue: any;
    let serializedValue: Buffer;
    try {
      // Use structuredClone() for the clone (triggers getters, handles circular refs)
      clonedValue = cloneValue(value);
      // Serialize the cloned value for storage
      serializedValue = serialize(clonedValue) as Buffer;
    } catch (e: any) {
      this._transaction._state = savedState;
      // Re-throw any error: DataCloneError for non-cloneable types,
      // or the original error from enumerable getters during clone
      throw e;
    }
    this._transaction._state = savedState;

    // Key extraction and validation happens on the CLONE (per spec)
    let effectiveKey: IDBValidKey;

    if (this._keyPath !== null) {
      if (key !== undefined) {
        throw new DOMException(
          'An object store that uses in-line keys cannot have a key argument',
          'DataError'
        );
      }
      // Use detailed evaluation to distinguish "not found" from "found but not a valid key"
      const keyPathStr = typeof this._keyPath === 'string' ? this._keyPath : null;
      const extracted = extractKeyFromValue(clonedValue, this._keyPath);
      // Check if any sub-path resolved to a non-key value
      const hasInvalidKey = keyPathStr !== null
        ? evaluateKeyPathDetailed(clonedValue, keyPathStr) === KEY_NOT_VALID
        : (Array.isArray(this._keyPath) && this._keyPath.some(p => evaluateKeyPathDetailed(clonedValue, p) === KEY_NOT_VALID));
      if (hasInvalidKey) {
        // Key path resolved but value is not a valid key — always DataError
        throw new DOMException('The key is not a valid key.', 'DataError');
      }
      if (extracted !== null) {
        effectiveKey = extracted;
      } else if (this._autoIncrement) {
        // Check that key can be injected before deferring generation
        if (!canInjectKey(clonedValue, this._keyPath as string)) {
          throw new DOMException(
            'A key could not be injected into the value.',
            'DataError'
          );
        }
        effectiveKey = null as any; // placeholder — generated at operation time
      } else {
        throw new DOMException('No key could be extracted from the value', 'DataError');
      }
    } else if (key !== undefined) {
      effectiveKey = valueToKeyOrThrow(key);
    } else if (this._autoIncrement) {
      effectiveKey = null as any; // placeholder
    } else {
      throw new DOMException('No key provided and object store has no key path', 'DataError');
    }

    const request = this._transaction._createRequest(this);

    // Capture values needed for deferred execution
    const store = this;
    const storeId = this._storeId;
    const keyPathForAutoInc = this._keyPath;
    const autoIncrement = this._autoIncrement;

    this._transaction._queueOperation(
      () => {
        // === SQLite operation (may be deferred) ===
        store._transaction._ensureSavepoint();

        // Handle auto-increment key generation at operation time
        if (effectiveKey === null && autoIncrement) {
          const nextKey = store._nextKey();
          if (nextKey === null) {
            // Key generator overflow
            request._readyState = 'done';
            request._error = new DOMException(
              'Key generator has reached its maximum value',
              'ConstraintError'
            );
            request._constraintError = true;
            return;
          }
          effectiveKey = nextKey;
          if (keyPathForAutoInc !== null) {
            // Inject into the clone and re-serialize
            injectKeyIntoValue(clonedValue, keyPathForAutoInc, effectiveKey);
            serializedValue = serialize(clonedValue) as Buffer;
          }
        }

        const encodedKey = encodeKey(effectiveKey);

        // Check for unique index constraints
        const indexes = store._transaction._db._backend.getIndexesForStore(
          store._transaction._db._name,
          storeId
        );

        for (const idx of indexes) {
          if (!idx.unique) continue;
          const indexKeyValue = extractKeyFromValue(clonedValue, idx.keyPath);
          if (indexKeyValue === null) continue;
          const encodedIndexKey = encodeKey(indexKeyValue);
          const excludeKey = noOverwrite ? undefined : encodedKey;
          if (store._transaction._db._backend.checkUniqueIndexConstraint(
            store._transaction._db._name,
            idx.id,
            encodedIndexKey,
            excludeKey
          )) {
            request._readyState = 'done';
            request._error = new DOMException(
              'A record with the given index key already exists',
              'ConstraintError'
            );
            request._constraintError = true;
            return;
          }
        }

        // Check for existing key if noOverwrite
        if (noOverwrite) {
          const existing = store._transaction._db._backend.getRecord(
            store._transaction._db._name,
            storeId,
            encodedKey
          );
          if (existing) {
            request._readyState = 'done';
            request._error = new DOMException(
              'A record with the given key already exists',
              'ConstraintError'
            );
            request._constraintError = true;
            return;
          }
        }

        // Delete old index entries if replacing
        if (!noOverwrite) {
          store._transaction._db._backend.deleteIndexEntriesForRecord(
            store._transaction._db._name,
            storeId,
            encodedKey
          );
        }

        // Write the record
        store._transaction._db._backend.putRecord(
          store._transaction._db._name,
          storeId,
          encodedKey,
          serializedValue
        );

        // Add index entries using cloned value
        store._addIndexEntries(indexes, clonedValue, encodedKey);

        // Update key generator AFTER successful store (per spec)
        if (autoIncrement && typeof effectiveKey === 'number') {
          store._maybeUpdateKeyGenerator(effectiveKey);
        }

        request._readyState = 'done';
        request._result = effectiveKey;
      },
      () => {
        // === Event dispatch ===
        if (request._constraintError) {
          const event = new Event('error', { bubbles: true, cancelable: true });
          store._transaction._dispatchRequestEvent(request, event);
        } else {
          const event = new Event('success', { bubbles: false, cancelable: false });
          store._transaction._dispatchRequestEvent(request, event);
        }
      }
    );

    return request;
  }

  get(query: any): IDBRequest {
    this._ensureValid();

    const range = queryToRange(query);
    const request = this._transaction._createRequest(this);
    const store = this;
    const storeId = this._storeId;

    this._transaction._queueOperation(
      () => {
        let resultValue: any;
        if ('exact' in range) {
          const raw = store._transaction._db._backend.getRecord(
            store._transaction._db._name,
            storeId,
            range.exact
          );
          resultValue = raw ? deserialize(raw) : undefined;
        } else {
          const record = store._transaction._db._backend.getRecordInRange(
            store._transaction._db._name,
            storeId,
            range.lower,
            range.upper,
            range.lowerOpen,
            range.upperOpen
          );
          resultValue = record ? deserialize(record.value) : undefined;
        }
        request._readyState = 'done';
        request._result = resultValue;
      },
      () => {
        const event = new Event('success', { bubbles: false, cancelable: false });
        store._transaction._dispatchRequestEvent(request, event);
      }
    );

    return request;
  }

  getKey(query: any): IDBRequest {
    this._ensureValid();

    if (arguments.length === 0) {
      throw new TypeError("Failed to execute 'getKey' on 'IDBObjectStore': 1 argument required, but only 0 present.");
    }

    const range = queryToRange(query);
    const request = this._transaction._createRequest(this);
    const store = this;
    const storeId = this._storeId;

    this._transaction._queueOperation(
      () => {
        if ('exact' in range) {
          const raw = store._transaction._db._backend.getRecord(
            store._transaction._db._name,
            storeId,
            range.exact
          );
          request._readyState = 'done';
          request._result = raw ? valueToKeyOrThrow(query) : undefined;
        } else {
          const record = store._transaction._db._backend.getRecordInRange(
            store._transaction._db._name,
            storeId,
            range.lower,
            range.upper,
            range.lowerOpen,
            range.upperOpen
          );
          request._readyState = 'done';
          if (record) {
            request._result = decodeKeyFromBuffer(record.key);
          } else {
            request._result = undefined;
          }
        }
      },
      () => {
        const event = new Event('success', { bubbles: false, cancelable: false });
        store._transaction._dispatchRequestEvent(request, event);
      }
    );

    return request;
  }

  delete(query: any): IDBRequest {
    this._ensureValid();
    if (this._transaction._mode === 'readonly') {
      throw new DOMException('The transaction is read-only.', 'ReadOnlyError');
    }

    const range = queryToRange(query);
    const request = this._transaction._createRequest(this);
    const store = this;
    const storeId = this._storeId;

    this._transaction._queueOperation(
      () => {
        store._transaction._ensureSavepoint();
        if ('exact' in range) {
          store._transaction._db._backend.deleteIndexEntriesForRecord(
            store._transaction._db._name,
            storeId,
            range.exact
          );
          store._transaction._db._backend.deleteRecord(
            store._transaction._db._name,
            storeId,
            range.exact
          );
        } else {
          store._transaction._db._backend.deleteRecordsInRange(
            store._transaction._db._name,
            storeId,
            range.lower,
            range.upper,
            range.lowerOpen,
            range.upperOpen
          );
        }
        request._readyState = 'done';
        request._result = undefined;
      },
      () => {
        const event = new Event('success', { bubbles: false, cancelable: false });
        store._transaction._dispatchRequestEvent(request, event);
      }
    );

    return request;
  }

  clear(): IDBRequest {
    this._ensureValid();
    if (this._transaction._mode === 'readonly') {
      throw new DOMException('The transaction is read-only.', 'ReadOnlyError');
    }

    const request = this._transaction._createRequest(this);
    const store = this;
    const storeId = this._storeId;

    this._transaction._queueOperation(
      () => {
        store._transaction._ensureSavepoint();
        store._transaction._db._backend.clearRecords(
          store._transaction._db._name,
          storeId
        );
        request._readyState = 'done';
        request._result = undefined;
      },
      () => {
        const event = new Event('success', { bubbles: false, cancelable: false });
        store._transaction._dispatchRequestEvent(request, event);
      }
    );

    return request;
  }

  count(query?: any): IDBRequest {
    this._ensureValid();
    const request = this._transaction._createRequest(this);
    const store = this;
    const storeId = this._storeId;

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
          cnt = store._transaction._db._backend.countRecords(
            store._transaction._db._name,
            storeId
          );
        } else if (queryParams.type === 'range') {
          cnt = store._transaction._db._backend.countRecords(
            store._transaction._db._name,
            storeId,
            queryParams.lower,
            queryParams.upper,
            queryParams.lowerOpen,
            queryParams.upperOpen
          );
        } else {
          cnt = store._transaction._db._backend.countRecords(
            store._transaction._db._name,
            storeId,
            queryParams.key,
            queryParams.key,
            false,
            false
          );
        }
        request._readyState = 'done';
        request._result = cnt;
      },
      () => {
        const event = new Event('success', { bubbles: false, cancelable: false });
        store._transaction._dispatchRequestEvent(request, event);
      }
    );

    return request;
  }

  createIndex(name: string, keyPath: string | string[], options?: { unique?: boolean; multiEntry?: boolean }): any {
    // Per WebIDL: name is a DOMString, coerce to string
    name = String(name);

    if (this._transaction._mode !== 'versionchange') {
      throw new DOMException(
        "Failed to execute 'createIndex' on 'IDBObjectStore': The database is not running a version change transaction.",
        'InvalidStateError'
      );
    }
    this._ensureValid();

    // Per WebIDL: stringify keyPath elements if it's an array
    if (Array.isArray(keyPath)) {
      keyPath = keyPath.map(String);
    } else if (typeof keyPath !== 'string') {
      keyPath = String(keyPath);
    }

    // Check for duplicate index name (before keyPath validation per spec exception ordering)
    const existingNames = this._transaction._db._backend.getIndexNames(
      this._transaction._db._name,
      this._storeId
    );
    if (existingNames.includes(name)) {
      throw new DOMException(
        `An index with name '${name}' already exists`,
        'ConstraintError'
      );
    }

    if (!isValidKeyPath(keyPath)) {
      throw new DOMException(
        `The keyPath argument contains an invalid key path.`,
        'SyntaxError'
      );
    }

    if (Array.isArray(keyPath) && options?.multiEntry) {
      throw new DOMException(
        'An index cannot have a multi-entry flag with an array key path.',
        'InvalidAccessError'
      );
    }

    const unique = options?.unique ?? false;
    const multiEntry = options?.multiEntry ?? false;

    this._transaction._ensureSavepoint();
    const indexId = this._transaction._db._backend.createIndex(
      this._transaction._db._name,
      this._storeId,
      name,
      keyPath,
      unique,
      multiEntry
    );

    // Populate index with existing records.
    // If unique constraint is violated, abort the transaction asynchronously.
    let constraintViolated = false;
    try {
      this._populateIndex(indexId, keyPath, unique, multiEntry);
    } catch (e: any) {
      if (e instanceof DOMException && e.name === 'ConstraintError') {
        constraintViolated = true;
      } else {
        throw e;
      }
    }

    // Invalidate index names cache
    this._indexNamesCache = null;

    const idx = new IDBIndex(this, name, indexId, keyPath, unique, multiEntry);
    idx._createdInTransaction = this._transaction;
    this._indexCache.set(name, idx);

    // Track for abort revert
    this._transaction._createdIndexes.push({ store: this, index: idx, name });

    if (constraintViolated) {
      this._transaction.abort();
    }

    return idx;
  }

  deleteIndex(name: string): void {
    if (this._transaction._mode !== 'versionchange') {
      throw new DOMException(
        "Failed to execute 'deleteIndex' on 'IDBObjectStore': The database is not running a version change transaction.",
        'InvalidStateError'
      );
    }
    this._ensureValid();

    this._transaction._ensureSavepoint();
    this._transaction._db._backend.deleteIndex(
      this._transaction._db._name,
      this._storeId,
      name
    );

    // Mark cached IDBIndex as deleted
    const cached = this._indexCache.get(name);
    if (cached) {
      cached._deleted = true;
      // Track for abort revert (only if not created in this transaction)
      const wasCreatedInThisTxn = cached._createdInTransaction === this._transaction;
      if (!wasCreatedInThisTxn) {
        this._transaction._deletedIndexes.push({ store: this, index: cached, name });
      }
      this._indexCache.delete(name);
    } else {
      // Index not cached yet — create a reference and track it
      const meta = this._transaction._db._backend.getIndexMetadata(
        this._transaction._db._name,
        this._storeId,
        name
      );
      if (meta) {
        const idx = new IDBIndex(this, name, meta.id, meta.keyPath, meta.unique, meta.multiEntry);
        idx._deleted = true;
        this._transaction._deletedIndexes.push({ store: this, index: idx, name });
      }
    }

    // Invalidate index names cache
    this._indexNamesCache = null;
  }

  openCursor(query?: any, direction?: IDBCursorDirection): IDBRequest {
    this._ensureValid();
    const dir = direction ?? 'next';
    if (!['next', 'nextunique', 'prev', 'prevunique'].includes(dir)) {
      throw new TypeError(`Failed to execute 'openCursor' on 'IDBObjectStore': The provided value '${dir}' is not a valid enum value of type IDBCursorDirection.`);
    }
    return openObjectStoreCursor(this, this._transaction, query, dir, false);
  }

  openKeyCursor(query?: any, direction?: IDBCursorDirection): IDBRequest {
    this._ensureValid();
    const dir = direction ?? 'next';
    if (!['next', 'nextunique', 'prev', 'prevunique'].includes(dir)) {
      throw new TypeError(`Failed to execute 'openKeyCursor' on 'IDBObjectStore': The provided value '${dir}' is not a valid enum value of type IDBCursorDirection.`);
    }
    return openObjectStoreCursor(this, this._transaction, query, dir, true);
  }

  index(name: string): IDBIndex {
    // Per spec: index() throws InvalidStateError if transaction is finished
    // (different from other operations which throw TransactionInactiveError)
    if (this._deleted) {
      throw new DOMException('The object store has been deleted.', 'InvalidStateError');
    }
    const txn = this._transaction;
    if (txn._state === 'finished' || txn._aborted) {
      throw new DOMException('The transaction has finished.', 'InvalidStateError');
    }

    // SameObject: return cached instance if available
    const cached = this._indexCache.get(name);
    if (cached && !cached._deleted) {
      return cached;
    }

    const meta = this._transaction._db._backend.getIndexMetadata(
      this._transaction._db._name,
      this._storeId,
      name
    );
    if (!meta) {
      throw new DOMException(
        `No index named '${name}' in this object store`,
        'NotFoundError'
      );
    }
    const idx = new IDBIndex(this, name, meta.id, meta.keyPath, meta.unique, meta.multiEntry);
    this._indexCache.set(name, idx);
    return idx;
  }

  getAll(queryOrOptions?: any, count?: number): IDBRequest {
    this._ensureValid();

    // Detect dictionary overload: if queryOrOptions is a plain object with getAllRecords support
    const hasDictSupport = typeof this.getAllRecords === 'function';
    const parsed = parseGetAllArgs(queryOrOptions, count, hasDictSupport);

    const request = this._transaction._createRequest(this);
    const store = this;
    const storeId = this._storeId;

    this._transaction._queueOperation(
      () => {
        const direction = (parsed.direction as any) || 'next';
        const rows = store._transaction._db._backend.getAllRecords(
          store._transaction._db._name,
          storeId,
          parsed.lower,
          parsed.upper,
          parsed.lowerOpen,
          parsed.upperOpen,
          direction,
          (parsed.count !== undefined && parsed.count > 0) ? parsed.count : undefined
        );
        const results: any[] = [];
        for (const row of rows) {
          results.push(deserialize(row.value));
        }
        request._readyState = 'done';
        request._result = results;
      },
      () => {
        const event = new Event('success', { bubbles: false, cancelable: false });
        store._transaction._dispatchRequestEvent(request, event);
      }
    );

    return request;
  }

  getAllKeys(queryOrOptions?: any, count?: number): IDBRequest {
    this._ensureValid();

    const hasDictSupport = typeof this.getAllRecords === 'function';
    const parsed = parseGetAllArgs(queryOrOptions, count, hasDictSupport);

    const request = this._transaction._createRequest(this);
    const store = this;
    const storeId = this._storeId;

    this._transaction._queueOperation(
      () => {
        const direction = (parsed.direction as any) || 'next';
        const rows = store._transaction._db._backend.getAllRecords(
          store._transaction._db._name,
          storeId,
          parsed.lower,
          parsed.upper,
          parsed.lowerOpen,
          parsed.upperOpen,
          direction,
          (parsed.count !== undefined && parsed.count > 0) ? parsed.count : undefined
        );
        const results: any[] = [];
        for (const row of rows) {
          results.push(decodeKey(row.key));
        }
        request._readyState = 'done';
        request._result = results;
      },
      () => {
        const event = new Event('success', { bubbles: false, cancelable: false });
        store._transaction._dispatchRequestEvent(request, event);
      }
    );

    return request;
  }

  getAllRecords(options?: any): IDBRequest {
    this._ensureValid();

    const parsed = parseGetAllArgs(options, undefined, true);

    const request = this._transaction._createRequest(this);
    const store = this;
    const storeId = this._storeId;

    this._transaction._queueOperation(
      () => {
        const direction = (parsed.direction as any) || 'next';
        const rows = store._transaction._db._backend.getAllRecords(
          store._transaction._db._name,
          storeId,
          parsed.lower,
          parsed.upper,
          parsed.lowerOpen,
          parsed.upperOpen,
          direction,
          (parsed.count !== undefined && parsed.count > 0) ? parsed.count : undefined
        );
        const results: any[] = [];
        for (const row of rows) {
          const key = decodeKey(row.key);
          const value = deserialize(row.value);
          results.push(new IDBRecord(key, key, value));
        }
        request._readyState = 'done';
        request._result = results;
      },
      () => {
        const event = new Event('success', { bubbles: false, cancelable: false });
        store._transaction._dispatchRequestEvent(request, event);
      }
    );

    return request;
  }

  private _ensureValid(): void {
    if (this._deleted) {
      throw new DOMException(
        'The object store has been deleted.',
        'InvalidStateError'
      );
    }
    const txn = this._transaction;
    if (txn._state !== 'active') {
      throw new DOMException(
        'The transaction is not active.',
        'TransactionInactiveError'
      );
    }
  }

  // Exposed for external modules (e.g., keypath.ts)
  static _extractKeyFromValueStatic = extractKeyFromValue;

  // Maximum key generator value per spec (2^53)
  static readonly MAX_KEY_GENERATOR_VALUE = 9007199254740992; // 2^53

  _nextKey(): number | null {
    const meta = this._transaction._db._backend.getObjectStoreMetadata(
      this._transaction._db._name,
      this._name
    );
    const currentKey = meta?.currentKey ?? 0;
    // Per spec: if current number is greater than or equal to 2^53, return failure
    if (currentKey >= IDBObjectStore.MAX_KEY_GENERATOR_VALUE) {
      return null;
    }
    // Return the next key value but do NOT update currentKey yet.
    // The key generator is only updated after the record is successfully stored.
    return currentKey + 1;
  }

  private _maybeUpdateKeyGenerator(key: number): void {
    if (!this._autoIncrement) return;
    // Per spec: if key is NaN, do nothing
    if (Number.isNaN(key)) return;
    // Infinity and -Infinity are handled: Infinity should max out the generator,
    // -Infinity is < 1 so it does nothing.
    if (key === Infinity) {
      // Max out the key generator — future generation will fail
      this._transaction._db._backend.updateCurrentKey(
        this._transaction._db._name,
        this._storeId,
        IDBObjectStore.MAX_KEY_GENERATOR_VALUE
      );
      return;
    }
    if (!Number.isFinite(key)) return; // -Infinity
    const floorKey = Math.floor(key);
    if (floorKey < 1) return;
    const meta = this._transaction._db._backend.getObjectStoreMetadata(
      this._transaction._db._name,
      this._name
    );
    if (meta && floorKey >= meta.currentKey) {
      // Cap at 2^53 — any value >= 2^53 will cause future generation to fail
      const newKey = Math.min(floorKey, IDBObjectStore.MAX_KEY_GENERATOR_VALUE);
      this._transaction._db._backend.updateCurrentKey(
        this._transaction._db._name,
        this._storeId,
        newKey
      );
    }
  }

  // Delegate to keypath.ts module
  _extractKeyFromValue(value: any, keyPath: string | string[]): IDBValidKey | null {
    return extractKeyFromValue(value, keyPath);
  }

  private _evaluateKeyPathRaw(value: any, keyPath: string): any {
    return evaluateKeyPathRaw(value, keyPath);
  }

  _injectKeyIntoValue(value: any, keyPath: string | string[], key: IDBValidKey): any {
    return injectKeyIntoValue(value, keyPath, key);
  }

  /** Add index entries for a record */
  private _addIndexEntries(indexes: any[], value: any, encodedKey: Uint8Array): void {
    for (const idx of indexes) {
      if (idx.multiEntry && typeof idx.keyPath === 'string') {
        const rawValue = this._evaluateKeyPathRaw(value, idx.keyPath);
        if (rawValue === undefined || rawValue === null) continue;
        if (Array.isArray(rawValue)) {
          const seen = new Set<string>();
          for (const item of rawValue) {
            const k = valueToKey(item);
            if (k === null) continue;
            const encoded = encodeKey(k);
            const encodedStr = Buffer.from(encoded).toString('hex');
            if (seen.has(encodedStr)) continue;
            seen.add(encodedStr);
            this._transaction._db._backend.addIndexEntry(
              this._transaction._db._name,
              idx.id,
              encoded,
              encodedKey
            );
          }
        } else {
          const k = valueToKey(rawValue);
          if (k === null) continue;
          const encodedIndexKey = encodeKey(k);
          this._transaction._db._backend.addIndexEntry(
            this._transaction._db._name,
            idx.id,
            encodedIndexKey,
            encodedKey
          );
        }
      } else {
        const indexKeyValue = this._extractKeyFromValue(value, idx.keyPath);
        if (indexKeyValue === null) continue;
        const encodedIndexKey = encodeKey(indexKeyValue);
        this._transaction._db._backend.addIndexEntry(
          this._transaction._db._name,
          idx.id,
          encodedIndexKey,
          encodedKey
        );
      }
    }
  }

  private _populateIndex(indexId: number, keyPath: string | string[], unique: boolean, multiEntry: boolean): void {
    const db = this._transaction._db._backend.getDatabase(this._transaction._db._name);
    const rows = db.prepare(
      'SELECT key, value FROM records WHERE object_store_id = ?'
    ).all(this._storeId) as Array<{ key: Buffer; value: Buffer }>;

    for (const row of rows) {
      const value = deserialize(row.value);

      if (multiEntry && typeof keyPath === 'string') {
        const rawValue = this._evaluateKeyPathRaw(value, keyPath);
        if (rawValue === undefined || rawValue === null) continue;
        if (Array.isArray(rawValue)) {
          const seen = new Set<string>();
          for (const item of rawValue) {
            const k = valueToKey(item);
            if (k === null) continue;
            const encoded = encodeKey(k);
            const encodedStr = Buffer.from(encoded).toString('hex');
            if (seen.has(encodedStr)) continue;
            seen.add(encodedStr);
            this._transaction._db._backend.addIndexEntry(
              this._transaction._db._name,
              indexId,
              encoded,
              row.key
            );
          }
          continue;
        }
        // Single value
        const k = valueToKey(rawValue);
        if (k === null) continue;
        if (unique) {
          if (this._transaction._db._backend.checkUniqueIndexConstraint(
            this._transaction._db._name,
            indexId,
            encodeKey(k)
          )) {
            throw new DOMException('Unique constraint violated when populating index', 'ConstraintError');
          }
        }
        this._transaction._db._backend.addIndexEntry(
          this._transaction._db._name,
          indexId,
          encodeKey(k),
          row.key
        );
        continue;
      }

      const indexKeyValue = this._extractKeyFromValue(value, keyPath);
      if (indexKeyValue === null) continue;

      {
        if (unique) {
          if (this._transaction._db._backend.checkUniqueIndexConstraint(
            this._transaction._db._name,
            indexId,
            encodeKey(indexKeyValue)
          )) {
            throw new DOMException('Unique constraint violated when populating index', 'ConstraintError');
          }
        }
        this._transaction._db._backend.addIndexEntry(
          this._transaction._db._name,
          indexId,
          encodeKey(indexKeyValue),
          row.key
        );
      }
    }
  }
}

const decodeKeyFromBuffer = decodeKey;
