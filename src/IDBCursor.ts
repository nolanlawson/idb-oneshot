// IDBCursor and IDBCursorWithValue implementation

import { IDBKeyRange } from './IDBKeyRange.ts';
import { encodeKey, compareKeys, valueToKey, decodeKey } from './keys.ts';
import { deserialize } from './structured-clone.ts';
// queueTask not imported directly; we use transaction._queueRequestCallback
import type { IDBValidKey } from './types.ts';

const decodeKeyFromBuffer = decodeKey;

export type CursorSource = 'objectStore' | 'index';

export interface CursorState {
  source: any; // IDBObjectStore or IDBIndex
  sourceType: CursorSource;
  transaction: any; // IDBTransaction
  request: any; // IDBRequest
  direction: IDBCursorDirection;
  // For object store cursors
  storeId: number;
  dbName: string;
  backend: any; // SQLiteBackend
  // For index cursors
  indexId?: number;
  // Range
  lower: Uint8Array | null;
  upper: Uint8Array | null;
  lowerOpen: boolean;
  upperOpen: boolean;
  // Key-only cursor (openKeyCursor)
  keyOnly: boolean;
}

export class IDBCursor {
  get [Symbol.toStringTag]() { return 'IDBCursor'; }

  _state: CursorState;
  _key: IDBValidKey | undefined;
  _primaryKey: IDBValidKey | undefined;
  _value: any;
  _gotValue: boolean = false;
  _position: Uint8Array | null = null; // encoded current position key (primary key for object store, index key for index)
  _objectStorePosition: Uint8Array | null = null; // encoded primary key (for index cursors)
  _continueCalled: boolean = false;

  constructor(state: CursorState) {
    this._state = state;
  }

  get source(): any {
    return this._state.source;
  }

  get direction(): IDBCursorDirection {
    return this._state.direction;
  }

  get key(): IDBValidKey | undefined {
    return this._key;
  }

  get primaryKey(): IDBValidKey | undefined {
    return this._primaryKey;
  }

  get request(): any {
    return this._state.request;
  }

  _ensureSourceValid(): void {
    const source = this._state.source;
    if (this._state.sourceType === 'objectStore') {
      if (source._deleted) {
        throw new DOMException('The object store has been deleted.', 'InvalidStateError');
      }
    } else {
      if (source._deleted || source._objectStore._deleted) {
        throw new DOMException('The cursor source has been deleted.', 'InvalidStateError');
      }
    }
  }

  continue(key?: any): void {
    const txn = this._state.transaction;
    if (txn._state !== 'active') {
      throw new DOMException(
        'The transaction is not active.',
        'TransactionInactiveError'
      );
    }
    this._ensureSourceValid();
    if (this._continueCalled) {
      throw new DOMException(
        "Failed to execute 'continue' on 'IDBCursor': The cursor is being iterated or has already been iterated past its end.",
        'InvalidStateError'
      );
    }
    if (!this._gotValue) {
      throw new DOMException(
        "Failed to execute 'continue' on 'IDBCursor': The cursor is being iterated or has already been iterated past its end.",
        'InvalidStateError'
      );
    }

    if (key !== undefined) {
      const validKey = valueToKey(key);
      if (validKey === null) {
        throw new DOMException('The parameter is not a valid key.', 'DataError');
      }
      // key must be in the cursor's direction
      const dir = this._state.direction;
      if (this._key !== undefined) {
        const cmp = compareKeys(validKey, this._key);
        if ((dir === 'next' || dir === 'nextunique') && cmp <= 0) {
          throw new DOMException(
            "Failed to execute 'continue' on 'IDBCursor': The parameter is less than or equal to this cursor's position.",
            'DataError'
          );
        }
        if ((dir === 'prev' || dir === 'prevunique') && cmp >= 0) {
          throw new DOMException(
            "Failed to execute 'continue' on 'IDBCursor': The parameter is greater than or equal to this cursor's position.",
            'DataError'
          );
        }
      }
    }

    this._continueCalled = true;
    this._gotValue = false;

    // Reset request for next iteration
    this._state.request._readyState = 'pending';
    this._state.transaction._pendingRequestCount++;

    this._iterateCursor(key !== undefined ? valueToKey(key) as IDBValidKey : undefined);
  }

  advance(count: number): void {
    // Per spec, TypeError for invalid count precedes TransactionInactiveError
    if (count === 0) {
      throw new TypeError("Failed to execute 'advance' on 'IDBCursor': A count argument with value 0 (zero) was specified, must be greater than 0.");
    }
    if (count < 0 || !Number.isFinite(count)) {
      throw new TypeError("Failed to execute 'advance' on 'IDBCursor': Value is not of type 'unsigned long'.");
    }

    const txn = this._state.transaction;
    if (txn._state !== 'active') {
      throw new DOMException(
        'The transaction is not active.',
        'TransactionInactiveError'
      );
    }
    this._ensureSourceValid();
    if (this._continueCalled) {
      throw new DOMException(
        "Failed to execute 'advance' on 'IDBCursor': The cursor is being iterated or has already been iterated past its end.",
        'InvalidStateError'
      );
    }
    if (!this._gotValue) {
      throw new DOMException(
        "Failed to execute 'advance' on 'IDBCursor': The cursor is being iterated or has already been iterated past its end.",
        'InvalidStateError'
      );
    }

    this._continueCalled = true;
    this._gotValue = false;

    // Reset request for next iteration
    this._state.request._readyState = 'pending';
    this._state.transaction._pendingRequestCount++;

    this._iterateCursorAdvance(count);
  }

  update(...args: any[]): any {
    if (args.length === 0) {
      throw new TypeError("Failed to execute 'update' on 'IDBCursor': 1 argument required, but only 0 present.");
    }
    const value = args[0];
    const txn = this._state.transaction;
    if (txn._state !== 'active') {
      throw new DOMException(
        'The transaction is not active.',
        'TransactionInactiveError'
      );
    }
    if (txn._mode === 'readonly') {
      throw new DOMException('The transaction is read-only.', 'ReadOnlyError');
    }
    if (!this._gotValue) {
      throw new DOMException(
        "Failed to execute 'update' on 'IDBCursor': The cursor is being iterated or has already been iterated past its end.",
        'InvalidStateError'
      );
    }
    if (this._state.keyOnly) {
      throw new DOMException(
        "Failed to execute 'update' on 'IDBCursor': The cursor is a key cursor.",
        'InvalidStateError'
      );
    }

    // Use the object store's put method effectively
    const objectStore = this._state.sourceType === 'objectStore'
      ? this._state.source
      : this._state.source._objectStore;

    // If object store has inline keys, don't pass key
    let request: any;
    if (objectStore._keyPath !== null) {
      request = objectStore.put(value);
    } else {
      request = objectStore.put(value, this._primaryKey);
    }
    // Per spec, the request source for cursor.update() is the cursor itself
    request._source = this;
    return request;
  }

  delete(): any {
    const txn = this._state.transaction;
    if (txn._state !== 'active') {
      throw new DOMException(
        'The transaction is not active.',
        'TransactionInactiveError'
      );
    }
    if (txn._mode === 'readonly') {
      throw new DOMException('The transaction is read-only.', 'ReadOnlyError');
    }
    if (!this._gotValue) {
      throw new DOMException(
        "Failed to execute 'delete' on 'IDBCursor': The cursor is being iterated or has already been iterated past its end.",
        'InvalidStateError'
      );
    }
    if (this._state.keyOnly) {
      throw new DOMException(
        "Failed to execute 'delete' on 'IDBCursor': The cursor is a key cursor.",
        'InvalidStateError'
      );
    }

    const objectStore = this._state.sourceType === 'objectStore'
      ? this._state.source
      : this._state.source._objectStore;

    const request = objectStore.delete(IDBKeyRange.only(this._primaryKey));
    // Per spec, the request source for cursor.delete() is the cursor itself
    request._source = this;
    return request;
  }

  continuePrimaryKey(key: any, primaryKey: any): void {
    const txn = this._state.transaction;
    if (txn._state !== 'active') {
      throw new DOMException(
        'The transaction is not active.',
        'TransactionInactiveError'
      );
    }
    // Per spec: deleted source check precedes InvalidAccessError checks
    this._ensureSourceValid();
    if (this._state.sourceType !== 'index') {
      throw new DOMException(
        "Failed to execute 'continuePrimaryKey' on 'IDBCursor': continuePrimaryKey requires an index source.",
        'InvalidAccessError'
      );
    }
    const dir = this._state.direction;
    if (dir !== 'next' && dir !== 'prev') {
      throw new DOMException(
        "Failed to execute 'continuePrimaryKey' on 'IDBCursor': continuePrimaryKey requires 'next' or 'prev' direction.",
        'InvalidAccessError'
      );
    }
    if (!this._gotValue) {
      throw new DOMException(
        "Failed to execute 'continuePrimaryKey' on 'IDBCursor': The cursor is being iterated or has already been iterated past its end.",
        'InvalidStateError'
      );
    }

    const validKey = valueToKey(key);
    if (validKey === null) {
      throw new DOMException('The parameter is not a valid key.', 'DataError');
    }
    const validPK = valueToKey(primaryKey);
    if (validPK === null) {
      throw new DOMException('The parameter is not a valid key.', 'DataError');
    }

    // Key must be in direction from current key
    if (this._key !== undefined) {
      const cmp = compareKeys(validKey, this._key);
      if (dir === 'next' && cmp < 0) {
        throw new DOMException('The key is before the current cursor position.', 'DataError');
      }
      if (dir === 'prev' && cmp > 0) {
        throw new DOMException('The key is after the current cursor position.', 'DataError');
      }
      // If same key, primary key must be in direction
      if (cmp === 0 && this._primaryKey !== undefined) {
        const pkCmp = compareKeys(validPK, this._primaryKey);
        if (dir === 'next' && pkCmp <= 0) {
          throw new DOMException('The primary key is not after the current cursor position.', 'DataError');
        }
        if (dir === 'prev' && pkCmp >= 0) {
          throw new DOMException('The primary key is not before the current cursor position.', 'DataError');
        }
      }
    }

    this._continueCalled = true;
    this._gotValue = false;

    // Reset request for next iteration
    this._state.request._readyState = 'pending';
    this._state.transaction._pendingRequestCount++;

    this._iterateCursorContinuePrimaryKey(validKey, validPK);
  }

  /** Fire the cursor result asynchronously, setting flags in the event callback */
  _fireResult(found: boolean): void {
    const { request, transaction } = this._state;
    request._readyState = 'done';
    request._result = found ? this : null;

    transaction._queueRequestCallback(() => {
      // Set cursor flags just before event dispatch so they're correct during handler
      if (found) {
        this._gotValue = true;
        this._continueCalled = false;
      }
      const event = new Event('success', { bubbles: false, cancelable: false });
      transaction._dispatchRequestEvent(request, event);
    });
  }

  /** Internal: iterate cursor to next position */
  _iterateCursor(targetKey?: IDBValidKey): void {
    const { sourceType, direction, request, transaction } = this._state;
    const encodedTarget = targetKey !== undefined ? encodeKey(targetKey) : undefined;

    if (sourceType === 'objectStore') {
      this._iterateObjectStoreCursor(encodedTarget);
    } else {
      this._iterateIndexCursor(encodedTarget);
    }
  }

  _iterateObjectStoreCursor(encodedTarget?: Uint8Array): void {
    const { backend, dbName, storeId, direction, request, transaction } = this._state;
    const isReverse = direction === 'prev' || direction === 'prevunique';

    // Get all records in range
    const records = backend.getRecordsForCursor(
      dbName, storeId,
      this._state.lower, this._state.upper,
      this._state.lowerOpen, this._state.upperOpen,
      direction
    );

    // Find the next record after current position
    let found: { key: Buffer; value: Buffer } | null = null;
    for (const record of records) {
      if (this._position !== null) {
        const cmp = Buffer.compare(record.key, Buffer.from(this._position));
        if (isReverse ? cmp >= 0 : cmp <= 0) {
          // If we have a target key, check if this record comes after the current position
          // but before or at the target
          continue;
        }
      }
      if (encodedTarget !== undefined) {
        const cmp = Buffer.compare(record.key, Buffer.from(encodedTarget));
        if (isReverse ? cmp > 0 : cmp < 0) {
          continue;
        }
      }
      found = record;
      break;
    }

    if (found) {
      this._position = new Uint8Array(found.key);
      this._objectStorePosition = new Uint8Array(found.key);
      this._key = decodeKeyFromBuffer(found.key);
      this._primaryKey = this._key;
      if (!this._state.keyOnly) {
        this._value = deserialize(found.value);
      }
    } else {
      this._key = undefined;
      this._primaryKey = undefined;
      this._value = undefined;
    }
    this._fireResult(!!found);
  }

  _iterateIndexCursor(encodedTarget?: Uint8Array): void {
    const { backend, dbName, storeId, direction, request, transaction, indexId } = this._state;
    const isReverse = direction === 'prev' || direction === 'prevunique';
    const isUnique = direction === 'nextunique' || direction === 'prevunique';

    const entries = backend.getIndexEntriesForCursor(
      dbName, indexId!, storeId,
      this._state.lower, this._state.upper,
      this._state.lowerOpen, this._state.upperOpen,
      direction
    );

    let found: { index_key: Buffer; primary_key: Buffer; value: Buffer } | null = null;
    let lastSeenIndexKey: Buffer | null = null;

    for (const entry of entries) {
      if (this._position !== null) {
        const indexCmp = Buffer.compare(entry.index_key, Buffer.from(this._position));

        if (isUnique) {
          // For unique directions, skip entries with same index key as current position
          if (indexCmp === 0) continue;
          if (isReverse ? indexCmp > 0 : indexCmp < 0) continue;
        } else {
          // For non-unique, compare index key, then primary key
          if (isReverse) {
            if (indexCmp > 0) continue;
            if (indexCmp === 0) {
              const pkCmp = Buffer.compare(entry.primary_key, Buffer.from(this._objectStorePosition!));
              if (pkCmp >= 0) continue;
            }
          } else {
            if (indexCmp < 0) continue;
            if (indexCmp === 0) {
              const pkCmp = Buffer.compare(entry.primary_key, Buffer.from(this._objectStorePosition!));
              if (pkCmp <= 0) continue;
            }
          }
        }
      }

      if (encodedTarget !== undefined) {
        const cmp = Buffer.compare(entry.index_key, Buffer.from(encodedTarget));
        if (isReverse ? cmp > 0 : cmp < 0) {
          continue;
        }
      }

      found = entry;
      break;
    }

    if (found) {
      this._position = new Uint8Array(found.index_key);
      this._objectStorePosition = new Uint8Array(found.primary_key);
      this._key = decodeKeyFromBuffer(found.index_key);
      this._primaryKey = decodeKeyFromBuffer(found.primary_key);
      if (!this._state.keyOnly) {
        this._value = deserialize(found.value);
      }
    } else {
      this._key = undefined;
      this._primaryKey = undefined;
      this._value = undefined;
    }
    this._fireResult(!!found);
  }

  _iterateCursorAdvance(count: number): void {
    const { sourceType, direction, request, transaction, backend, dbName, storeId, indexId } = this._state;
    const isReverse = direction === 'prev' || direction === 'prevunique';
    const isUnique = direction === 'nextunique' || direction === 'prevunique';

    if (sourceType === 'objectStore') {
      const records = backend.getRecordsForCursor(
        dbName, storeId,
        this._state.lower, this._state.upper,
        this._state.lowerOpen, this._state.upperOpen,
        direction
      );

      let skipped = 0;
      let found: { key: Buffer; value: Buffer } | null = null;
      for (const record of records) {
        if (this._position !== null) {
          const cmp = Buffer.compare(record.key, Buffer.from(this._position));
          if (isReverse ? cmp >= 0 : cmp <= 0) continue;
        }
        skipped++;
        if (skipped === count) {
          found = record;
          break;
        }
      }

      if (found) {
        this._position = new Uint8Array(found.key);
        this._objectStorePosition = new Uint8Array(found.key);
        this._key = decodeKeyFromBuffer(found.key);
        this._primaryKey = this._key;
        if (!this._state.keyOnly) {
          this._value = deserialize(found.value);
        }
      } else {
        this._key = undefined;
        this._primaryKey = undefined;
        this._value = undefined;
      }
      this._fireResult(!!found);
      return;
    } else {
      const entries = backend.getIndexEntriesForCursor(
        dbName, indexId!, storeId,
        this._state.lower, this._state.upper,
        this._state.lowerOpen, this._state.upperOpen,
        direction
      );

      let skipped = 0;
      let found: { index_key: Buffer; primary_key: Buffer; value: Buffer } | null = null;
      let lastSeenIndexKey: Buffer | null = null;

      for (const entry of entries) {
        if (this._position !== null) {
          const indexCmp = Buffer.compare(entry.index_key, Buffer.from(this._position));

          if (isUnique) {
            if (indexCmp === 0) continue;
            if (isReverse ? indexCmp > 0 : indexCmp < 0) continue;
          } else {
            if (isReverse) {
              if (indexCmp > 0) continue;
              if (indexCmp === 0) {
                const pkCmp = Buffer.compare(entry.primary_key, Buffer.from(this._objectStorePosition!));
                if (pkCmp >= 0) continue;
              }
            } else {
              if (indexCmp < 0) continue;
              if (indexCmp === 0) {
                const pkCmp = Buffer.compare(entry.primary_key, Buffer.from(this._objectStorePosition!));
                if (pkCmp <= 0) continue;
              }
            }
          }
        }

        // For unique directions, when advancing, each unique index key counts as one step
        if (isUnique && lastSeenIndexKey !== null) {
          if (Buffer.compare(entry.index_key, lastSeenIndexKey) === 0) continue;
        }

        lastSeenIndexKey = entry.index_key;
        skipped++;
        if (skipped === count) {
          found = entry;
          break;
        }
      }

      if (found) {
        this._position = new Uint8Array(found.index_key);
        this._objectStorePosition = new Uint8Array(found.primary_key);
        this._key = decodeKeyFromBuffer(found.index_key);
        this._primaryKey = decodeKeyFromBuffer(found.primary_key);
        if (!this._state.keyOnly) {
          this._value = deserialize(found.value);
        }
      } else {
        this._key = undefined;
        this._primaryKey = undefined;
        this._value = undefined;
      }
      this._fireResult(!!found);
    }
  }

  _iterateCursorContinuePrimaryKey(key: IDBValidKey, primaryKey: IDBValidKey): void {
    const { backend, dbName, storeId, direction, request, transaction, indexId } = this._state;
    const isReverse = direction === 'prev';
    const encodedKey = encodeKey(key);
    const encodedPK = encodeKey(primaryKey);

    const entries = backend.getIndexEntriesForCursor(
      dbName, indexId!, storeId,
      this._state.lower, this._state.upper,
      this._state.lowerOpen, this._state.upperOpen,
      direction
    );

    let found: { index_key: Buffer; primary_key: Buffer; value: Buffer } | null = null;

    for (const entry of entries) {
      const indexCmp = Buffer.compare(entry.index_key, Buffer.from(encodedKey));
      if (isReverse ? indexCmp > 0 : indexCmp < 0) continue;
      if (indexCmp === 0) {
        const pkCmp = Buffer.compare(entry.primary_key, Buffer.from(encodedPK));
        if (isReverse ? pkCmp > 0 : pkCmp < 0) continue;
      }
      found = entry;
      break;
    }

    if (found) {
      this._position = new Uint8Array(found.index_key);
      this._objectStorePosition = new Uint8Array(found.primary_key);
      this._key = decodeKeyFromBuffer(found.index_key);
      this._primaryKey = decodeKeyFromBuffer(found.primary_key);
      if (!this._state.keyOnly) {
        this._value = deserialize(found.value);
      }
    } else {
      this._key = undefined;
      this._primaryKey = undefined;
      this._value = undefined;
    }
    this._fireResult(!!found);
  }
}

export class IDBCursorWithValue extends IDBCursor {
  get [Symbol.toStringTag]() { return 'IDBCursorWithValue'; }

  get value(): any {
    return this._value;
  }
}

/**
 * Open a cursor on an object store.
 * Returns the IDBRequest that will contain the cursor result.
 */
export function openObjectStoreCursor(
  objectStore: any,
  transaction: any,
  query: any,
  direction: IDBCursorDirection,
  keyOnly: boolean
): any {
  // Validate query BEFORE creating request to avoid incrementing pending count on error
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
      const key = valueToKey(query);
      if (key === null) {
        throw new DOMException('The parameter is not a valid key.', 'DataError');
      }
      const encoded = encodeKey(key);
      lower = encoded;
      upper = encoded;
    }
  }

  const request = transaction._createRequest(objectStore);
  const backend = transaction._db._backend;
  const dbName = transaction._db._name;

  const state: CursorState = {
    source: objectStore,
    sourceType: 'objectStore',
    transaction,
    request,
    direction,
    storeId: objectStore._storeId,
    dbName,
    backend,
    lower,
    upper,
    lowerOpen,
    upperOpen,
    keyOnly,
  };

  const CursorClass = keyOnly ? IDBCursor : IDBCursorWithValue;
  const cursor = new CursorClass(state);

  transaction._queueOperation(
    () => {
      // Get the first record (deferred for scheduler)
      const records = backend.getRecordsForCursor(
        dbName, objectStore._storeId,
        lower, upper, lowerOpen, upperOpen,
        direction
      );

      if (records.length > 0) {
        const first = records[0];
        cursor._position = new Uint8Array(first.key);
        cursor._objectStorePosition = new Uint8Array(first.key);
        cursor._key = decodeKeyFromBuffer(first.key);
        cursor._primaryKey = cursor._key;
        if (!keyOnly) {
          cursor._value = deserialize(first.value);
        }
        cursor._gotValue = true;

        request._readyState = 'done';
        request._result = cursor;
      } else {
        request._readyState = 'done';
        request._result = null;
      }
    },
    () => {
      const event = new Event('success', { bubbles: false, cancelable: false });
      transaction._dispatchRequestEvent(request, event);
    }
  );

  return request;
}

/**
 * Open a cursor on an index.
 */
export function openIndexCursor(
  index: any,
  transaction: any,
  query: any,
  direction: IDBCursorDirection,
  keyOnly: boolean
): any {
  // Validate query BEFORE creating request
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
      const key = valueToKey(query);
      if (key === null) {
        throw new DOMException('The parameter is not a valid key.', 'DataError');
      }
      const encoded = encodeKey(key);
      lower = encoded;
      upper = encoded;
    }
  }

  const request = transaction._createRequest(index);
  const backend = transaction._db._backend;
  const dbName = transaction._db._name;
  const storeId = index._objectStore._storeId;

  const state: CursorState = {
    source: index,
    sourceType: 'index',
    transaction,
    request,
    direction,
    storeId,
    dbName,
    backend,
    indexId: index._indexId,
    lower,
    upper,
    lowerOpen,
    upperOpen,
    keyOnly,
  };

  const CursorClass = keyOnly ? IDBCursor : IDBCursorWithValue;
  const cursor = new CursorClass(state);

  transaction._queueOperation(
    () => {
      const entries = backend.getIndexEntriesForCursor(
        dbName, index._indexId, storeId,
        lower, upper, lowerOpen, upperOpen,
        direction
      );

      if (entries.length > 0) {
        const first = entries[0];
        cursor._position = new Uint8Array(first.index_key);
        cursor._objectStorePosition = new Uint8Array(first.primary_key);
        cursor._key = decodeKeyFromBuffer(first.index_key);
        cursor._primaryKey = decodeKeyFromBuffer(first.primary_key);
        if (!keyOnly) {
          cursor._value = deserialize(first.value);
        }
        cursor._gotValue = true;

        request._readyState = 'done';
        request._result = cursor;
      } else {
        request._readyState = 'done';
        request._result = null;
      }
    },
    () => {
      const event = new Event('success', { bubbles: false, cancelable: false });
      transaction._dispatchRequestEvent(request, event);
    }
  );

  return request;
}
