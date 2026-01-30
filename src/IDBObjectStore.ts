// IDBObjectStore implementation

import { DOMStringList } from './DOMStringList.ts';
import { IDBRequest } from './IDBRequest.ts';
import { encodeKey, valueToKey, valueToKeyOrThrow } from './keys.ts';
import { queueTask } from './scheduling.ts';
import type { IDBValidKey } from './types.ts';

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
    this._ensureActive();
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
      if (this._autoIncrement && typeof effectiveKey === 'number') {
        this._maybeUpdateKeyGenerator(effectiveKey);
      }
    } else if (this._autoIncrement) {
      effectiveKey = this._nextKey();
    } else {
      throw new DOMException('No key provided and object store has no key path', 'DataError');
    }

    const encodedKey = encodeKey(effectiveKey);
    // Simple serialization - just JSON + type wrapping for now
    const serializedValue = Buffer.from(JSON.stringify(value));

    const request = this._transaction._createRequest(this);

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

    // Write the record
    this._transaction._ensureSavepoint();
    this._transaction._db._backend.putRecord(
      this._transaction._db._name,
      this._storeId,
      encodedKey,
      serializedValue
    );

    request._readyState = 'done';
    request._result = effectiveKey;

    // Fire success event asynchronously
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
    this._ensureActive();

    const key = valueToKeyOrThrow(query);
    const encodedKey = encodeKey(key);

    const request = this._transaction._createRequest(this);

    const record = this._transaction._db._backend.getRecord(
      this._transaction._db._name,
      this._storeId,
      encodedKey
    );

    request._readyState = 'done';
    request._result = record ? JSON.parse(record.toString()) : undefined;

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
    this._ensureActive();
    const key = valueToKeyOrThrow(query);
    const encodedKey = encodeKey(key);

    const request = this._transaction._createRequest(this);

    const record = this._transaction._db._backend.getRecord(
      this._transaction._db._name,
      this._storeId,
      encodedKey
    );

    request._readyState = 'done';
    request._result = record ? key : undefined;

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
    this._ensureActive();
    if (this._transaction._mode === 'readonly') {
      throw new DOMException('The transaction is read-only.', 'ReadOnlyError');
    }

    const key = valueToKeyOrThrow(query);
    const encodedKey = encodeKey(key);

    const request = this._transaction._createRequest(this);

    this._transaction._ensureSavepoint();
    this._transaction._db._backend.deleteRecord(
      this._transaction._db._name,
      this._storeId,
      encodedKey
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

  clear(): IDBRequest {
    this._ensureActive();
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
    this._ensureActive();
    const request = this._transaction._createRequest(this);

    const cnt = this._transaction._db._backend.countRecords(
      this._transaction._db._name,
      this._storeId
    );

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
    this._ensureActive();

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
    this._transaction._db._backend.createIndex(
      this._transaction._db._name,
      this._storeId,
      name,
      keyPath,
      unique,
      multiEntry
    );

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
    this._ensureActive();

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
    throw new DOMException('Not yet implemented', 'InvalidStateError');
  }

  getAll(_query?: any, _count?: number): IDBRequest {
    throw new DOMException('Not yet implemented', 'InvalidStateError');
  }

  getAllKeys(_query?: any, _count?: number): IDBRequest {
    throw new DOMException('Not yet implemented', 'InvalidStateError');
  }

  private _ensureActive(): void {
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

  private _extractKeyFromValue(value: any, keyPath: string | string[]): IDBValidKey | null {
    if (typeof keyPath === 'string') {
      return this._evaluateKeyPath(value, keyPath);
    }
    // Array key path
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
}
