// IDBObjectStore implementation

import { DOMStringList } from './DOMStringList.ts';
import { openObjectStoreCursor } from './IDBCursor.ts';
import { IDBIndex } from './IDBIndex.ts';
import { IDBKeyRange } from './IDBKeyRange.ts';
import { IDBRequest } from './IDBRequest.ts';
import { encodeKey, valueToKey, valueToKeyOrThrow, decodeKey } from './keys.ts';
import type { IDBValidKey } from './types.ts';

/**
 * Validate a key path string per the spec.
 */
function isValidKeyPathString(keyPath: string): boolean {
  if (keyPath === '') return true;
  const parts = keyPath.split('.');
  const identRegex = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;
  return parts.every(p => identRegex.test(p));
}

export function isValidKeyPath(keyPath: string | string[] | null): boolean {
  if (keyPath === null) return true;
  if (Array.isArray(keyPath)) {
    if (keyPath.length === 0) return false;
    return keyPath.every(p => typeof p === 'string' && isValidKeyPathString(p));
  }
  if (typeof keyPath !== 'string') return false;
  return isValidKeyPathString(keyPath);
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

    // Key extraction and validation happens synchronously (throws on error)
    let effectiveKey: IDBValidKey;

    if (this._keyPath !== null) {
      if (key !== undefined) {
        throw new DOMException(
          'An object store that uses in-line keys cannot have a key argument',
          'DataError'
        );
      }
      const extracted = this._extractKeyFromValue(value, this._keyPath);
      if (extracted !== null) {
        effectiveKey = extracted;
      } else if (this._autoIncrement) {
        // Defer key generation to operation time
        effectiveKey = null as any; // placeholder
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
          if (keyPathForAutoInc !== null) {
            effectiveKey = store._nextKey();
            value = store._injectKeyIntoValue(value, keyPathForAutoInc, effectiveKey);
          } else {
            effectiveKey = store._nextKey();
          }
        }

        // Update key generator if needed
        if (autoIncrement && typeof effectiveKey === 'number') {
          store._maybeUpdateKeyGenerator(effectiveKey);
        }

        const encodedKey = encodeKey(effectiveKey);
        const serializedValue = Buffer.from(JSON.stringify(value));

        // Check for unique index constraints
        const indexes = store._transaction._db._backend.getIndexesForStore(
          store._transaction._db._name,
          storeId
        );

        for (const idx of indexes) {
          if (!idx.unique) continue;
          const indexKeyValue = store._extractKeyFromValue(value, idx.keyPath);
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

        // Add index entries
        store._addIndexEntries(indexes, value, encodedKey);

        request._readyState = 'done';
        request._result = effectiveKey;
      },
      () => {
        // === Event dispatch ===
        store._transaction._state = 'active';
        if (request._constraintError) {
          const event = new Event('error', { bubbles: true, cancelable: true });
          const notPrevented = request.dispatchEvent(event);
          // Per spec: if error event is not preventDefault'd, abort the transaction
          if (notPrevented && !store._transaction._aborted && store._transaction._state !== 'finished') {
            store._transaction.abort();
            return;
          }
        } else {
          const event = new Event('success', { bubbles: false, cancelable: false });
          request.dispatchEvent(event);
        }
        store._transaction._deactivate();
        store._transaction._requestFinished();
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
          resultValue = raw ? JSON.parse(raw.toString()) : undefined;
        } else {
          const record = store._transaction._db._backend.getRecordInRange(
            store._transaction._db._name,
            storeId,
            range.lower,
            range.upper,
            range.lowerOpen,
            range.upperOpen
          );
          resultValue = record ? JSON.parse(record.value.toString()) : undefined;
        }
        request._readyState = 'done';
        request._result = resultValue;
      },
      () => {
        store._transaction._state = 'active';
        const event = new Event('success', { bubbles: false, cancelable: false });
        request.dispatchEvent(event);
        store._transaction._deactivate();
        store._transaction._requestFinished();
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
        store._transaction._state = 'active';
        const event = new Event('success', { bubbles: false, cancelable: false });
        request.dispatchEvent(event);
        store._transaction._deactivate();
        store._transaction._requestFinished();
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
        store._transaction._state = 'active';
        const event = new Event('success', { bubbles: false, cancelable: false });
        request.dispatchEvent(event);
        store._transaction._deactivate();
        store._transaction._requestFinished();
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
        store._transaction._state = 'active';
        const event = new Event('success', { bubbles: false, cancelable: false });
        request.dispatchEvent(event);
        store._transaction._deactivate();
        store._transaction._requestFinished();
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
        store._transaction._state = 'active';
        const event = new Event('success', { bubbles: false, cancelable: false });
        request.dispatchEvent(event);
        store._transaction._deactivate();
        store._transaction._requestFinished();
      }
    );

    return request;
  }

  createIndex(name: string, keyPath: string | string[], options?: { unique?: boolean; multiEntry?: boolean }): any {
    if (this._transaction._mode !== 'versionchange') {
      throw new DOMException(
        "Failed to execute 'createIndex' on 'IDBObjectStore': The database is not running a version change transaction.",
        'InvalidStateError'
      );
    }
    this._ensureValid();

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
    this._ensureValid();

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

  getAll(_query?: any, _count?: number): IDBRequest {
    throw new DOMException('Not yet implemented', 'InvalidStateError');
  }

  getAllKeys(_query?: any, _count?: number): IDBRequest {
    throw new DOMException('Not yet implemented', 'InvalidStateError');
  }

  private _ensureValid(): void {
    if (this._deleted) {
      throw new DOMException(
        'The object store has been deleted.',
        'InvalidStateError'
      );
    }
    if (this._transaction._state !== 'active') {
      throw new DOMException(
        'The transaction is not active.',
        'TransactionInactiveError'
      );
    }
  }

  _nextKey(): number {
    const meta = this._transaction._db._backend.getObjectStoreMetadata(
      this._transaction._db._name,
      this._name
    );
    const next = (meta?.currentKey ?? 0) + 1;
    this._transaction._db._backend.updateCurrentKey(
      this._transaction._db._name,
      this._storeId,
      next
    );
    return next;
  }

  private _maybeUpdateKeyGenerator(key: number): void {
    if (!this._autoIncrement) return;
    const floorKey = Math.floor(key);
    if (floorKey < 1) return;
    const meta = this._transaction._db._backend.getObjectStoreMetadata(
      this._transaction._db._name,
      this._name
    );
    if (meta && floorKey >= meta.currentKey) {
      this._transaction._db._backend.updateCurrentKey(
        this._transaction._db._name,
        this._storeId,
        floorKey
      );
    }
  }

  _extractKeyFromValue(value: any, keyPath: string | string[]): IDBValidKey | null {
    if (typeof keyPath === 'string') {
      return this._evaluateKeyPath(value, keyPath);
    }
    const result: IDBValidKey[] = [];
    for (const path of keyPath as string[]) {
      const key = this._evaluateKeyPath(value, path);
      if (key === null) return null;
      result.push(key);
    }
    return result;
  }

  private _evaluateKeyPath(value: any, keyPath: string): IDBValidKey | null {
    if (keyPath === '') return valueToKey(value);
    const parts = keyPath.split('.');
    let current = value;
    for (const part of parts) {
      if (current === null || current === undefined || typeof current !== 'object') {
        return null;
      }
      current = current[part];
    }
    return valueToKey(current);
  }

  /** Extract the raw value at a key path without validating as a key.
   *  Used for multi-entry index extraction where the value may be an array
   *  containing non-key elements. */
  private _evaluateKeyPathRaw(value: any, keyPath: string): any {
    if (keyPath === '') return value;
    const parts = keyPath.split('.');
    let current = value;
    for (const part of parts) {
      if (current === null || current === undefined || typeof current !== 'object') {
        return undefined;
      }
      current = current[part];
    }
    return current;
  }

  _injectKeyIntoValue(value: any, keyPath: string | string[], key: IDBValidKey): any {
    if (typeof keyPath === 'string') {
      const clone = typeof value === 'object' && value !== null ? { ...value } : value;
      const parts = keyPath.split('.');
      let current = clone;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!(parts[i] in current)) {
          current[parts[i]] = {};
        }
        current = current[parts[i]];
      }
      current[parts[parts.length - 1]] = key;
      return clone;
    }
    return value;
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
      const value = JSON.parse(row.value.toString());

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
