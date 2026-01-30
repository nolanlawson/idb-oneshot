// IDBIndex implementation

import { openIndexCursor } from './IDBCursor.ts';
import { IDBKeyRange } from './IDBKeyRange.ts';
import { IDBRequest } from './IDBRequest.ts';
import { encodeKey, valueToKeyOrThrow, decodeKey } from './keys.ts';
import type { IDBValidKey } from './types.ts';

const decodeKeyFromBuffer = decodeKey;

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

  set name(_value: string) {
    // Rename - Phase 8
    throw new DOMException('Not yet implemented', 'InvalidStateError');
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

  getAll(_query?: any, _count?: number): IDBRequest {
    this._ensureValid();
    const request = this._transaction._createRequest(this);
    const idx = this;
    // Stub - Phase 9
    request._readyState = 'done';
    request._result = [];
    this._transaction._queueRequestCallback(() => {
      idx._transaction._state = 'active';
      const event = new Event('success', { bubbles: false, cancelable: false });
      request.dispatchEvent(event);
      idx._transaction._deactivate();
      idx._transaction._requestFinished();
    });
    return request;
  }

  getAllKeys(_query?: any, _count?: number): IDBRequest {
    this._ensureValid();
    const request = this._transaction._createRequest(this);
    const idx = this;
    // Stub - Phase 9
    request._readyState = 'done';
    request._result = [];
    this._transaction._queueRequestCallback(() => {
      idx._transaction._state = 'active';
      const event = new Event('success', { bubbles: false, cancelable: false });
      request.dispatchEvent(event);
      idx._transaction._deactivate();
      idx._transaction._requestFinished();
    });
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
