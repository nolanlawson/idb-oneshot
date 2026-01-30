// IDBObjectStore implementation

import { DOMStringList } from './DOMStringList.ts';
import { IDBKeyRange } from './IDBKeyRange.ts';
import { IDBRequest } from './IDBRequest.ts';
import { encodeKey, valueToKey, valueToKeyOrThrow } from './keys.ts';
import { queueTask } from './scheduling.ts';
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
  _transaction: any; // IDBTransaction
  _name: string;
  _keyPath: string | string[] | null;
  _autoIncrement: boolean;
  _storeId: number;
  _indexNamesCache: DOMStringList | null = null;
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

  set name(_value: string) {
    // Rename - Phase 8
    throw new DOMException('Not yet implemented', 'InvalidStateError');
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

    let effectiveKey: IDBValidKey;

    if (this._keyPath !== null) {
      if (key !== undefined) {
        throw new DOMException(
          'An object store that uses in-line keys cannot have a key argument',
          'DataError'
        );
      }
      // Extract key from value using key path
      const extracted = this._extractKeyFromValue(value, this._keyPath);
      if (extracted !== null) {
        effectiveKey = extracted;
      } else if (this._autoIncrement) {
        effectiveKey = this._nextKey();
        // Inject key back into value
        value = this._injectKeyIntoValue(value, this._keyPath, effectiveKey);
      } else {
        throw new DOMException('No key could be extracted from the value', 'DataError');
      }
    } else if (key !== undefined) {
      effectiveKey = valueToKeyOrThrow(key);
    } else if (this._autoIncrement) {
      effectiveKey = this._nextKey();
    } else {
      throw new DOMException('No key provided and object store has no key path', 'DataError');
    }

    // Update key generator if needed
    if (this._autoIncrement && typeof effectiveKey === 'number') {
      this._maybeUpdateKeyGenerator(effectiveKey);
    }

    const encodedKey = encodeKey(effectiveKey);
    const serializedValue = Buffer.from(JSON.stringify(value));

    const request = this._transaction._createRequest(this);

    this._transaction._ensureSavepoint();

    // Check for unique index constraints
    const indexes = this._transaction._db._backend.getIndexesForStore(
      this._transaction._db._name,
      this._storeId
    );

    for (const idx of indexes) {
      if (!idx.unique) continue;
      const indexKeyValue = this._extractKeyFromValue(value, idx.keyPath);
      if (indexKeyValue === null) continue;
      const encodedIndexKey = encodeKey(indexKeyValue);
      const excludeKey = noOverwrite ? undefined : encodedKey;
      if (this._transaction._db._backend.checkUniqueIndexConstraint(
        this._transaction._db._name,
        idx.id,
        encodedIndexKey,
        excludeKey
      )) {
        request._readyState = 'done';
        request._error = new DOMException(
          'A record with the given index key already exists',
          'ConstraintError'
        );
        queueTask(() => {
          this._transaction._state = 'active';
          const event = new Event('error', { bubbles: true, cancelable: true });
          request.dispatchEvent(event);
          this._transaction._deactivate();
          this._transaction._requestFinished();
        });
        return request;
      }
    }

    // Check for existing key if noOverwrite
    if (noOverwrite) {
      const existing = this._transaction._db._backend.getRecord(
        this._transaction._db._name,
        this._storeId,
        encodedKey
      );
      if (existing) {
        request._readyState = 'done';
        request._error = new DOMException(
          'A record with the given key already exists',
          'ConstraintError'
        );
        queueTask(() => {
          this._transaction._state = 'active';
          const event = new Event('error', { bubbles: true, cancelable: true });
          request.dispatchEvent(event);
          this._transaction._deactivate();
          this._transaction._requestFinished();
        });
        return request;
      }
    }

    // Delete old index entries if replacing
    if (!noOverwrite) {
      this._transaction._db._backend.deleteIndexEntriesForRecord(
        this._transaction._db._name,
        this._storeId,
        encodedKey
      );
    }

    // Write the record
    this._transaction._db._backend.putRecord(
      this._transaction._db._name,
      this._storeId,
      encodedKey,
      serializedValue
    );

    // Add index entries
    for (const idx of indexes) {
      const indexKeyValue = this._extractKeyFromValue(value, idx.keyPath);
      if (indexKeyValue === null) continue;
      if (idx.multiEntry && Array.isArray(indexKeyValue)) {
        const seen = new Set<string>();
        for (const item of indexKeyValue) {
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
        const encodedIndexKey = encodeKey(indexKeyValue);
        this._transaction._db._backend.addIndexEntry(
          this._transaction._db._name,
          idx.id,
          encodedIndexKey,
          encodedKey
        );
      }
    }

    request._readyState = 'done';
    request._result = effectiveKey;

    queueTask(() => {
      this._transaction._state = 'active';
      const event = new Event('success', { bubbles: false, cancelable: false });
      request.dispatchEvent(event);
      this._transaction._deactivate();
      this._transaction._requestFinished();
    });

    return request;
  }

  get(query: any): IDBRequest {
    this._ensureValid();

    const range = queryToRange(query);
    const request = this._transaction._createRequest(this);
    let resultValue: any;

    if ('exact' in range) {
      const raw = this._transaction._db._backend.getRecord(
        this._transaction._db._name,
        this._storeId,
        range.exact
      );
      resultValue = raw ? JSON.parse(raw.toString()) : undefined;
    } else {
      const record = this._transaction._db._backend.getRecordInRange(
        this._transaction._db._name,
        this._storeId,
        range.lower,
        range.upper,
        range.lowerOpen,
        range.upperOpen
      );
      resultValue = record ? JSON.parse(record.value.toString()) : undefined;
    }

    request._readyState = 'done';
    request._result = resultValue;

    queueTask(() => {
      this._transaction._state = 'active';
      const event = new Event('success', { bubbles: false, cancelable: false });
      request.dispatchEvent(event);
      this._transaction._deactivate();
      this._transaction._requestFinished();
    });

    return request;
  }

  getKey(query: any): IDBRequest {
    this._ensureValid();

    if (arguments.length === 0) {
      throw new TypeError("Failed to execute 'getKey' on 'IDBObjectStore': 1 argument required, but only 0 present.");
    }

    const range = queryToRange(query);
    const request = this._transaction._createRequest(this);

    if ('exact' in range) {
      const raw = this._transaction._db._backend.getRecord(
        this._transaction._db._name,
        this._storeId,
        range.exact
      );
      request._readyState = 'done';
      request._result = raw ? valueToKeyOrThrow(query) : undefined;
    } else {
      const record = this._transaction._db._backend.getRecordInRange(
        this._transaction._db._name,
        this._storeId,
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

    queueTask(() => {
      this._transaction._state = 'active';
      const event = new Event('success', { bubbles: false, cancelable: false });
      request.dispatchEvent(event);
      this._transaction._deactivate();
      this._transaction._requestFinished();
    });

    return request;
  }

  delete(query: any): IDBRequest {
    this._ensureValid();
    if (this._transaction._mode === 'readonly') {
      throw new DOMException('The transaction is read-only.', 'ReadOnlyError');
    }

    const range = queryToRange(query);
    const request = this._transaction._createRequest(this);

    this._transaction._ensureSavepoint();

    if ('exact' in range) {
      this._transaction._db._backend.deleteIndexEntriesForRecord(
        this._transaction._db._name,
        this._storeId,
        range.exact
      );
      this._transaction._db._backend.deleteRecord(
        this._transaction._db._name,
        this._storeId,
        range.exact
      );
    } else {
      this._transaction._db._backend.deleteRecordsInRange(
        this._transaction._db._name,
        this._storeId,
        range.lower,
        range.upper,
        range.lowerOpen,
        range.upperOpen
      );
    }

    request._readyState = 'done';
    request._result = undefined;

    queueTask(() => {
      this._transaction._state = 'active';
      const event = new Event('success', { bubbles: false, cancelable: false });
      request.dispatchEvent(event);
      this._transaction._deactivate();
      this._transaction._requestFinished();
    });

    return request;
  }

  clear(): IDBRequest {
    this._ensureValid();
    if (this._transaction._mode === 'readonly') {
      throw new DOMException('The transaction is read-only.', 'ReadOnlyError');
    }

    const request = this._transaction._createRequest(this);

    this._transaction._ensureSavepoint();
    this._transaction._db._backend.clearRecords(
      this._transaction._db._name,
      this._storeId
    );

    request._readyState = 'done';
    request._result = undefined;

    queueTask(() => {
      this._transaction._state = 'active';
      const event = new Event('success', { bubbles: false, cancelable: false });
      request.dispatchEvent(event);
      this._transaction._deactivate();
      this._transaction._requestFinished();
    });

    return request;
  }

  count(query?: any): IDBRequest {
    this._ensureValid();
    const request = this._transaction._createRequest(this);

    let cnt: number;
    if (query === undefined) {
      cnt = this._transaction._db._backend.countRecords(
        this._transaction._db._name,
        this._storeId
      );
    } else if (query instanceof IDBKeyRange) {
      const lower = query.lower !== undefined ? encodeKey(query.lower) : null;
      const upper = query.upper !== undefined ? encodeKey(query.upper) : null;
      cnt = this._transaction._db._backend.countRecords(
        this._transaction._db._name,
        this._storeId,
        lower,
        upper,
        query.lowerOpen,
        query.upperOpen
      );
    } else {
      const key = valueToKeyOrThrow(query);
      const encodedKey = encodeKey(key);
      cnt = this._transaction._db._backend.countRecords(
        this._transaction._db._name,
        this._storeId,
        encodedKey,
        encodedKey,
        false,
        false
      );
    }

    request._readyState = 'done';
    request._result = cnt;

    queueTask(() => {
      this._transaction._state = 'active';
      const event = new Event('success', { bubbles: false, cancelable: false });
      request.dispatchEvent(event);
      this._transaction._deactivate();
      this._transaction._requestFinished();
    });

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

    // Check for duplicate index name
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
    // If unique constraint is violated, abort the transaction.
    try {
      this._populateIndex(indexId, keyPath, unique, multiEntry);
    } catch (e: any) {
      if (e instanceof DOMException && e.name === 'ConstraintError') {
        this._transaction.abort();
        throw e;
      }
      throw e;
    }

    // Invalidate index names cache
    this._indexNamesCache = null;

    // Return a stub IDBIndex for now
    return { name, keyPath, unique, multiEntry, objectStore: this };
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

    // Invalidate index names cache
    this._indexNamesCache = null;
  }

  // Stubs for later phases
  openCursor(_query?: any, _direction?: string): IDBRequest {
    throw new DOMException('Not yet implemented', 'InvalidStateError');
  }

  openKeyCursor(_query?: any, _direction?: string): IDBRequest {
    throw new DOMException('Not yet implemented', 'InvalidStateError');
  }

  index(_name: string): any {
    this._ensureValid();
    const meta = this._transaction._db._backend.getIndexMetadata(
      this._transaction._db._name,
      this._storeId,
      _name
    );
    if (!meta) {
      throw new DOMException(
        `No index named '${_name}' in this object store`,
        'NotFoundError'
      );
    }
    return {
      name: _name,
      keyPath: meta.keyPath,
      unique: meta.unique,
      multiEntry: meta.multiEntry,
      objectStore: this,
      openCursor: () => { throw new DOMException('Not yet implemented', 'InvalidStateError'); },
      openKeyCursor: () => { throw new DOMException('Not yet implemented', 'InvalidStateError'); },
      get: () => { throw new DOMException('Not yet implemented', 'InvalidStateError'); },
      getKey: () => { throw new DOMException('Not yet implemented', 'InvalidStateError'); },
      getAll: () => { throw new DOMException('Not yet implemented', 'InvalidStateError'); },
      getAllKeys: () => { throw new DOMException('Not yet implemented', 'InvalidStateError'); },
      count: () => { throw new DOMException('Not yet implemented', 'InvalidStateError'); },
    };
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

  private _nextKey(): number {
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

  private _injectKeyIntoValue(value: any, keyPath: string | string[], key: IDBValidKey): any {
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

  private _populateIndex(indexId: number, keyPath: string | string[], unique: boolean, multiEntry: boolean): void {
    const db = this._transaction._db._backend.getDatabase(this._transaction._db._name);
    const rows = db.prepare(
      'SELECT key, value FROM records WHERE object_store_id = ?'
    ).all(this._storeId) as Array<{ key: Buffer; value: Buffer }>;

    for (const row of rows) {
      const value = JSON.parse(row.value.toString());
      const indexKeyValue = this._extractKeyFromValue(value, keyPath);
      if (indexKeyValue === null) continue;

      if (multiEntry && Array.isArray(indexKeyValue)) {
        const seen = new Set<string>();
        for (const item of indexKeyValue) {
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
      } else {
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

/** Decode a binary-encoded key back into an IDBValidKey */
function decodeKeyFromBuffer(buf: Buffer | Uint8Array): IDBValidKey {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const { key } = decodeKeyAt(bytes, 0);
  return key;
}

function decodeKeyAt(bytes: Uint8Array, offset: number): { key: IDBValidKey; nextOffset: number } {
  const tag = bytes[offset];
  offset++;

  if (tag === 0x10 || tag === 0x20) {
    // Number or Date
    const dbytes = new Uint8Array(8);
    dbytes.set(bytes.subarray(offset, offset + 8));
    if (dbytes[0] & 0x80) {
      dbytes[0] ^= 0x80;
    } else {
      for (let i = 0; i < 8; i++) dbytes[i] ^= 0xff;
    }
    const view = new DataView(dbytes.buffer, dbytes.byteOffset, 8);
    const value = view.getFloat64(0, false);
    if (tag === 0x20) {
      return { key: new Date(value), nextOffset: offset + 8 };
    }
    return { key: value, nextOffset: offset + 8 };
  }

  if (tag === 0x30) {
    // String: UTF-16 big-endian code units to end of buffer
    const chars: number[] = [];
    let pos = offset;
    while (pos + 1 < bytes.length) {
      const code = (bytes[pos] << 8) | bytes[pos + 1];
      chars.push(code);
      pos += 2;
    }
    return { key: String.fromCharCode(...chars), nextOffset: pos };
  }

  if (tag === 0x40) {
    // Binary: raw bytes to end
    const data = bytes.slice(offset).buffer;
    return { key: data as ArrayBuffer, nextOffset: bytes.length };
  }

  if (tag === 0x50) {
    // Array
    const elements: IDBValidKey[] = [];
    let pos = offset;
    while (pos < bytes.length && bytes[pos] !== 0x00) {
      const { key, nextOffset } = decodeKeyAt(bytes, pos);
      elements.push(key);
      pos = nextOffset;
    }
    if (pos < bytes.length) pos++;
    return { key: elements, nextOffset: pos };
  }

  throw new Error(`Unknown key tag: 0x${tag.toString(16)}`);
}
