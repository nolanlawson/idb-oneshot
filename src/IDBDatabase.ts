// IDBDatabase implementation

import { DOMStringList } from './DOMStringList.ts';
import { IDBTransaction } from './IDBTransaction.ts';
import { IDBObjectStore, isValidKeyPath } from './IDBObjectStore.ts';
import type { SQLiteBackend } from './sqlite-backend.ts';
import { initEventTarget, idbDispatchEvent } from './scheduling.ts';

export class IDBDatabase extends EventTarget {
  _name: string;
  _version: number;
  _backend: SQLiteBackend;
  _closed: boolean = false;
  _closePending: boolean = false;
  _upgradeTransaction: IDBTransaction | null = null;
  _objectStoreNamesCache: DOMStringList | null = null;
  // Callback for when versionchange transaction finishes
  _onVersionChangeComplete: ((aborted: boolean) => void) | null = null;

  // Event handlers
  onabort: ((this: IDBDatabase, ev: Event) => any) | null = null;
  onclose: ((this: IDBDatabase, ev: Event) => any) | null = null;
  onerror: ((this: IDBDatabase, ev: Event) => any) | null = null;
  onversionchange: ((this: IDBDatabase, ev: Event) => any) | null = null;

  dispatchEvent(event: Event): boolean {
    return idbDispatchEvent(this, [], event);
  }

  constructor(name: string, version: number, backend: SQLiteBackend) {
    super();
    initEventTarget(this);
    this._name = name;
    this._version = version;
    this._backend = backend;
  }

  get name(): string {
    return this._name;
  }

  get version(): number {
    return this._version;
  }

  get objectStoreNames(): DOMStringList {
    // After close, return frozen cache
    if (this._closePending && this._objectStoreNamesCache) {
      return this._objectStoreNamesCache;
    }
    const names = this._backend.getObjectStoreNames(this._name);
    this._objectStoreNamesCache = new DOMStringList(names);
    return this._objectStoreNamesCache;
  }

  close(): void {
    if (!this._closePending) {
      this._closePending = true;
      // Freeze the objectStoreNames at close time
      const names = this._backend.getObjectStoreNames(this._name);
      this._objectStoreNamesCache = new DOMStringList(names);
      // The actual close happens when all transactions complete
      // For now, mark as closed immediately
      this._closed = true;
    }
  }

  createObjectStore(name: string, options?: { keyPath?: string | string[] | null; autoIncrement?: boolean }): IDBObjectStore {
    // Per WebIDL: name is a DOMString, so coerce to string
    name = String(name);

    // Per spec exception ordering:
    // 1. InvalidStateError if not running an upgrade transaction
    //    A transaction that is 'finished' is no longer "running"
    if (!this._upgradeTransaction || this._upgradeTransaction._state === 'finished') {
      throw new DOMException(
        "Failed to execute 'createObjectStore' on 'IDBDatabase': The database is not running a version change transaction.",
        'InvalidStateError'
      );
    }
    // 2. TransactionInactiveError if the transaction is not active (e.g., aborted but not yet finished)
    if (this._upgradeTransaction._state !== 'active') {
      throw new DOMException(
        "Failed to execute 'createObjectStore' on 'IDBDatabase': The transaction is not active.",
        'TransactionInactiveError'
      );
    }

    let keyPath = options?.keyPath !== undefined ? options.keyPath : null;
    const autoIncrement = options?.autoIncrement ?? false;

    // Per WebIDL: stringify keyPath elements if it's an array (sequence<DOMString>)
    if (Array.isArray(keyPath)) {
      keyPath = keyPath.map(String);
    } else if (keyPath !== null && keyPath !== undefined && typeof keyPath !== 'string') {
      keyPath = String(keyPath);
    }

    // 3. SyntaxError for invalid key path (before ConstraintError per spec)
    if (keyPath !== null && keyPath !== undefined && !isValidKeyPath(keyPath)) {
      throw new DOMException(
        "The keyPath argument contains an invalid key path.",
        'SyntaxError'
      );
    }

    // 4. ConstraintError for duplicate store name
    const existingNames = this._backend.getObjectStoreNames(this._name);
    if (existingNames.includes(name)) {
      throw new DOMException(
        `An object store with the name '${name}' already exists.`,
        'ConstraintError'
      );
    }

    // Validate: autoIncrement with empty string keyPath is invalid
    if (autoIncrement && keyPath === '') {
      throw new DOMException(
        "An object store cannot have autoIncrement and an empty string key path.",
        'InvalidAccessError'
      );
    }

    // Validate: autoIncrement with array keyPath is invalid
    if (autoIncrement && Array.isArray(keyPath)) {
      throw new DOMException(
        "An object store cannot have autoIncrement and an array key path.",
        'InvalidAccessError'
      );
    }

    this._upgradeTransaction._ensureSavepoint();
    this._backend.createObjectStore(this._name, name, keyPath, autoIncrement);

    // Update store names on the transaction
    const updatedNames = this._backend.getObjectStoreNames(this._name);
    this._upgradeTransaction._storeNames = updatedNames;
    this._upgradeTransaction._objectStoreNames = new DOMStringList(updatedNames);

    // Invalidate cache
    this._objectStoreNamesCache = null;

    // Create and return the IDBObjectStore
    const store = new IDBObjectStore(this._upgradeTransaction, name);
    this._upgradeTransaction._objectStoreCache.set(name, store);

    // Track for abort revert
    this._upgradeTransaction._createdStoreNames.push(name);

    return store;
  }

  deleteObjectStore(name: string): void {
    // Per WebIDL: name is a DOMString, so coerce to string
    name = String(name);

    // Per spec: InvalidStateError if not running an upgrade transaction
    if (!this._upgradeTransaction || this._upgradeTransaction._state === 'finished') {
      throw new DOMException(
        "Failed to execute 'deleteObjectStore' on 'IDBDatabase': The database is not running a version change transaction.",
        'InvalidStateError'
      );
    }
    // TransactionInactiveError if the transaction is not active
    if (this._upgradeTransaction._state !== 'active') {
      throw new DOMException(
        "Failed to execute 'deleteObjectStore' on 'IDBDatabase': The transaction is not active.",
        'TransactionInactiveError'
      );
    }

    // Check store exists
    const existingNames = this._backend.getObjectStoreNames(this._name);
    if (!existingNames.includes(name)) {
      throw new DOMException(
        `No object store with the name '${name}' was found.`,
        'NotFoundError'
      );
    }

    this._upgradeTransaction._ensureSavepoint();

    // Mark any cached IDBObjectStore as deleted before removing from backend
    const cachedStore = this._upgradeTransaction._objectStoreCache.get(name);
    if (cachedStore && cachedStore._deleted !== undefined) {
      cachedStore._deleted = true;
      // Mark all indexes on the store as deleted and clear indexNames
      for (const [, idx] of cachedStore._indexCache) {
        idx._deleted = true;
      }
      cachedStore._indexNamesCache = new DOMStringList([]);
    }

    // Track for abort revert (only if the store existed before this transaction)
    const wasCreatedInThisTxn = this._upgradeTransaction._createdStoreNames.includes(name);
    if (!wasCreatedInThisTxn) {
      this._upgradeTransaction._deletedStoreNames.push(name);
      if (cachedStore) {
        this._upgradeTransaction._deletedStoreCache.set(name, cachedStore);
      }
    }

    this._backend.deleteObjectStore(this._name, name);

    // Update store names on the transaction
    const updatedNames = this._backend.getObjectStoreNames(this._name);
    this._upgradeTransaction._storeNames = updatedNames;
    this._upgradeTransaction._objectStoreNames = new DOMStringList(updatedNames);

    // Invalidate cache
    this._objectStoreNamesCache = null;
    this._upgradeTransaction._objectStoreCache.delete(name);
  }

  transaction(storeNames: string | string[], mode?: IDBTransactionMode, options?: { durability?: string }): IDBTransaction {
    if (this._closePending) {
      throw new DOMException(
        "Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.",
        'InvalidStateError'
      );
    }

    if (this._upgradeTransaction && this._upgradeTransaction._state !== 'finished') {
      throw new DOMException(
        "Failed to execute 'transaction' on 'IDBDatabase': A version change transaction is running.",
        'InvalidStateError'
      );
    }

    if (typeof storeNames === 'string') {
      storeNames = [storeNames];
    } else {
      // Convert iterable to array and deduplicate
      storeNames = [...new Set(storeNames)];
    }

    if (storeNames.length === 0) {
      throw new DOMException(
        "Failed to execute 'transaction' on 'IDBDatabase': The storeNames parameter was empty.",
        'InvalidAccessError'
      );
    }

    // Per spec: NotFoundError (store names check) before TypeError (invalid mode)
    // Verify all store names exist
    const existingNames = this._backend.getObjectStoreNames(this._name);
    for (const name of storeNames) {
      if (!existingNames.includes(name)) {
        throw new DOMException(
          `One of the specified object stores was not found.`,
          'NotFoundError'
        );
      }
    }

    mode = mode || 'readonly';
    if (mode !== 'readonly' && mode !== 'readwrite') {
      throw new TypeError(`Invalid transaction mode: ${mode}`);
    }

    // Validate durability option
    const durability = options?.durability ?? 'default';
    if (durability !== 'default' && durability !== 'strict' && durability !== 'relaxed') {
      throw new TypeError(`Invalid durability: ${durability}`);
    }

    const txn = new IDBTransaction(this, storeNames, mode);
    txn._durability = durability;
    txn._useScheduler = true;

    // Register with the transaction scheduler
    getScheduler(this._name).addTransaction(txn, txn._storeNames, mode, () => {
      txn._schedulerStart();
    });

    // Deactivate the transaction after the current microtask checkpoint.
    // Per spec, a newly created transaction is active during the synchronous
    // code that created it AND through the microtask checkpoint that follows.
    // It becomes inactive before the next macrotask.
    //
    // We schedule deactivation at the END of the microtask checkpoint by
    // chaining: queueMicrotask -> queueMicrotask.  The first microtask runs
    // after user-level microtasks (Promise.then) from the same turn; the
    // nested one runs after any microtasks those triggered.
    queueMicrotask(() => queueMicrotask(() => {
      if (txn._state === 'active') {
        txn._deactivate();
        txn._maybeAutoCommit();
      }
    }));

    return txn;
  }

  /** Called by versionchange transaction when it finishes */
  _versionChangeTransactionFinished(aborted: boolean): void {
    if (aborted) {
      // Revert version
      const storedVersion = this._backend.getDatabaseVersion(this._name);
      this._version = storedVersion;
    }
    if (this._onVersionChangeComplete) {
      this._onVersionChangeComplete(aborted);
      this._onVersionChangeComplete = null;
    }
  }

  toString(): string {
    return '[object IDBDatabase]';
  }
}

// Import queueTask for the transaction method - we need this at the bottom
import { queueTask } from './scheduling.ts';
import { getScheduler } from './transaction-scheduler.ts';
