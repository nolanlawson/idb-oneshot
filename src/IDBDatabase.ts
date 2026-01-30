// IDBDatabase implementation

import { DOMStringList } from './DOMStringList.ts';
import { IDBTransaction } from './IDBTransaction.ts';
import { IDBObjectStore, isValidKeyPath } from './IDBObjectStore.ts';
import type { SQLiteBackend } from './sqlite-backend.ts';

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
    const handler = (this as any)['on' + event.type];
    if (typeof handler === 'function') {
      this.addEventListener(event.type, handler, { once: true });
    }
    const result = super.dispatchEvent(event);
    if (typeof handler === 'function') {
      this.removeEventListener(event.type, handler);
    }
    return result;
  }

  constructor(name: string, version: number, backend: SQLiteBackend) {
    super();
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
    // Always refresh from backend
    const names = this._backend.getObjectStoreNames(this._name);
    this._objectStoreNamesCache = new DOMStringList(names);
    return this._objectStoreNamesCache;
  }

  close(): void {
    if (!this._closePending) {
      this._closePending = true;
      // The actual close happens when all transactions complete
      // For now, mark as closed immediately
      this._closed = true;
    }
  }

  createObjectStore(name: string, options?: { keyPath?: string | string[] | null; autoIncrement?: boolean }): IDBObjectStore {
    if (!this._upgradeTransaction) {
      throw new DOMException(
        "Failed to execute 'createObjectStore' on 'IDBDatabase': The database is not running a version change transaction.",
        'InvalidStateError'
      );
    }
    if (this._upgradeTransaction._state !== 'active') {
      throw new DOMException(
        "Failed to execute 'createObjectStore' on 'IDBDatabase': The transaction is not active.",
        'TransactionInactiveError'
      );
    }

    // Check for duplicate store name
    const existingNames = this._backend.getObjectStoreNames(this._name);
    if (existingNames.includes(name)) {
      throw new DOMException(
        `An object store with the name '${name}' already exists.`,
        'ConstraintError'
      );
    }

    const keyPath = options?.keyPath !== undefined ? options.keyPath : null;
    const autoIncrement = options?.autoIncrement ?? false;

    // Validate key path
    if (keyPath !== null && keyPath !== undefined && !isValidKeyPath(keyPath)) {
      throw new DOMException(
        "The keyPath argument contains an invalid key path.",
        'SyntaxError'
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
    return store;
  }

  deleteObjectStore(name: string): void {
    if (!this._upgradeTransaction) {
      throw new DOMException(
        "Failed to execute 'deleteObjectStore' on 'IDBDatabase': The database is not running a version change transaction.",
        'InvalidStateError'
      );
    }
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

  transaction(storeNames: string | string[], mode?: IDBTransactionMode, _options?: any): IDBTransaction {
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
    }

    if (storeNames.length === 0) {
      throw new DOMException(
        "Failed to execute 'transaction' on 'IDBDatabase': The storeNames parameter was empty.",
        'InvalidAccessError'
      );
    }

    mode = mode || 'readonly';
    if (mode !== 'readonly' && mode !== 'readwrite') {
      throw new TypeError(`Invalid transaction mode: ${mode}`);
    }

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

    const txn = new IDBTransaction(this, storeNames, mode);

    // Auto-commit when no more requests are queued
    // The transaction starts active, becomes inactive after each event dispatch
    // If it becomes inactive with no pending requests, it auto-commits
    queueMicrotask(() => {
      if (txn._state === 'active' && txn._pendingRequestCount === 0) {
        txn._deactivate();
        txn._maybeAutoCommit();
      }
    });

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
