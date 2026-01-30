// IDBTransaction implementation

import { DOMStringList } from './DOMStringList.ts';
import { IDBRequest } from './IDBRequest.ts';
import { queueTask, initEventTarget, idbDispatchEvent } from './scheduling.ts';
import { getScheduler } from './transaction-scheduler.ts';

// Factory function to create IDBObjectStore without circular import
// Set by IDBObjectStore module
let createObjectStore: (transaction: any, name: string) => any;

export function _setObjectStoreFactory(factory: (transaction: any, name: string) => any): void {
  createObjectStore = factory;
}

export class IDBTransaction extends EventTarget {
  _db: any; // IDBDatabase - avoid circular import by using any
  _mode: IDBTransactionMode;
  _storeNames: string[];
  _state: 'active' | 'inactive' | 'committing' | 'finished' = 'active';
  _error: DOMException | null = null;
  _aborted: boolean = false;
  _objectStoreNames: DOMStringList;
  _requests: IDBRequest[] = [];
  _pendingRequestCount: number = 0; // requests whose events haven't fired yet
  _savepointName: string;
  _savepointStarted: boolean = false;
  _objectStoreCache: Map<string, any> = new Map(); // SameObject cache

  // Metadata revert tracking for versionchange transactions
  _createdStoreNames: string[] = []; // Stores created in this transaction
  _deletedStoreNames: string[] = []; // Stores deleted in this transaction
  _deletedStoreCache: Map<string, any> = new Map(); // Cached IDBObjectStore instances for deleted stores
  _createdIndexes: Array<{ store: any; index: any; name: string }> = []; // Indexes created
  _deletedIndexes: Array<{ store: any; index: any; name: string }> = []; // Indexes deleted
  _renamedStores?: Array<{ store: any; oldName: string; newName: string }>; // Stores renamed
  _renamedIndexes?: Array<{ index: any; store: any; oldName: string; newName: string }>; // Indexes renamed

  // Transaction scheduling
  _started: boolean = false; // Whether the scheduler has given permission to run
  _pendingCallbacks: Array<() => void> = []; // Buffered request event callbacks
  _useScheduler: boolean = false; // Whether this transaction uses the scheduler
  _commitOnStart: boolean = false; // Auto-commit when scheduler starts (empty transactions)

  // Event handlers
  onabort: ((this: IDBTransaction, ev: Event) => any) | null = null;
  oncomplete: ((this: IDBTransaction, ev: Event) => any) | null = null;
  onerror: ((this: IDBTransaction, ev: Event) => any) | null = null;

  dispatchEvent(event: Event): boolean {
    // Build ancestor path: transaction → database
    const ancestors: EventTarget[] = [];
    if (event.bubbles && this._db) {
      ancestors.push(this._db);
    }

    return idbDispatchEvent(this, ancestors, event);
  }

  constructor(db: any, storeNames: string[], mode: IDBTransactionMode) {
    super();
    initEventTarget(this);
    this._db = db;
    this._mode = mode;
    this._storeNames = storeNames.slice().sort();
    this._objectStoreNames = new DOMStringList(this._storeNames);
    this._savepointName = `txn_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }

  get objectStoreNames(): DOMStringList {
    return this._objectStoreNames;
  }

  get mode(): IDBTransactionMode {
    return this._mode;
  }

  get db(): any {
    return this._db;
  }

  get durability(): string {
    return 'default';
  }

  get error(): DOMException | null {
    return this._error;
  }

  objectStore(name: string): any {
    if (this._state === 'finished') {
      throw new DOMException(
        "Failed to execute 'objectStore' on 'IDBTransaction': The transaction has finished.",
        'InvalidStateError'
      );
    }
    if (!this._storeNames.includes(name)) {
      throw new DOMException(
        `Failed to execute 'objectStore' on 'IDBTransaction': The specified object store was not found.`,
        'NotFoundError'
      );
    }

    // SameObject: return cached instance if available
    let store = this._objectStoreCache.get(name);
    if (!store) {
      store = createObjectStore(this, name);
      this._objectStoreCache.set(name, store);
    }
    return store;
  }

  abort(): void {
    if (this._state === 'committing' || this._state === 'finished' || this._aborted) {
      throw new DOMException(
        "Failed to execute 'abort' on 'IDBTransaction': The transaction has already been committed or aborted.",
        'InvalidStateError'
      );
    }
    this._aborted = true;
    // Don't set _state to 'finished' yet - it transitions through cleanup.
    // Set to 'inactive' so operations see it as "not active" but still "running".
    this._state = 'inactive';
    // Only set error to AbortError if not already set (e.g., by auto-abort from ConstraintError)
    if (!this._error) {
      this._error = new DOMException('The transaction was aborted.', 'AbortError');
    }

    // Rollback SQLite savepoint
    if (this._savepointStarted) {
      try {
        this._db._backend.rollbackSavepoint(this._db._name, this._savepointName);
      } catch {
        // ignore errors during rollback
      }
      this._savepointStarted = false;
    }

    // Revert metadata for versionchange transactions
    if (this._mode === 'versionchange') {
      this._revertMetadata();
    }

    // Set error on all pending requests and fire error events
    const pendingRequests: any[] = [];
    for (const request of this._requests) {
      if (request._readyState === 'pending') {
        request._readyState = 'done';
        request._error = this._error;
        request._result = undefined;
        pendingRequests.push(request);
      }
    }

    // Clear any pending callbacks
    this._pendingCallbacks = [];

    // Fire abort event and error events on pending requests
    queueTask(() => {
      // Fire error events on pending requests first (with bubbling)
      for (const request of pendingRequests) {
        const errorEvent = new Event('error', { bubbles: true, cancelable: true });
        request.dispatchEvent(errorEvent);
      }

      // Set state to 'finished' BEFORE firing abort event
      // so abort event handlers see the transaction as "no longer running"
      this._state = 'finished';

      const abortEvent = new Event('abort', { bubbles: true, cancelable: false });
      this.dispatchEvent(abortEvent);

      // Notify scheduler
      if (this._useScheduler) {
        getScheduler(this._db._name).transactionFinished(this);
      }

      // Notify database about abort for versionchange transactions
      // Fire in a separate task so the abort event fully propagates first
      if (this._mode === 'versionchange') {
        queueTask(() => {
          this._db._versionChangeTransactionFinished(true);
        });
      }
    });
  }

  /** Revert metadata changes made during a versionchange transaction */
  _revertMetadata(): void {
    // Revert renamed indexes (in reverse order)
    // Only revert renames for indexes that were NOT created in this transaction
    if (this._renamedIndexes) {
      for (let i = this._renamedIndexes.length - 1; i >= 0; i--) {
        const { index, store, oldName, newName } = this._renamedIndexes[i];
        // Skip if the index was created in this transaction (it will be marked deleted)
        if (index._createdInTransaction === this) continue;
        // Revert in-memory name
        index._name = oldName;
        // Update cache
        store._indexCache.delete(newName);
        store._indexCache.set(oldName, index);
        store._indexNamesCache = null;
      }
    }

    // Revert renamed stores (in reverse order)
    // Only revert renames for stores that were NOT created in this transaction
    if (this._renamedStores) {
      // Build set of store objects that were created in this transaction
      const createdStoreObjects = new Set<any>();
      for (const name of this._createdStoreNames) {
        // Find in cache using current or original name
        for (const [, s] of this._objectStoreCache) {
          if (s._name === name) createdStoreObjects.add(s);
        }
      }
      // Also check renames: if the first rename's oldName matches a created store name
      for (const { store, oldName } of this._renamedStores) {
        if (this._createdStoreNames.includes(oldName)) {
          createdStoreObjects.add(store);
        }
      }

      for (let i = this._renamedStores.length - 1; i >= 0; i--) {
        const { store, oldName, newName } = this._renamedStores[i];
        // Skip if the store was created in this transaction (it will be marked deleted)
        if (createdStoreObjects.has(store)) continue;
        // Revert in-memory name
        store._name = oldName;
        // Update cache
        this._objectStoreCache.delete(newName);
        this._objectStoreCache.set(oldName, store);
      }
    }

    // Revert created stores: mark them as deleted
    for (const name of this._createdStoreNames) {
      const store = this._objectStoreCache.get(name);
      if (store) {
        store._deleted = true;
        // Also mark all indexes on the created store as deleted
        for (const [, idx] of store._indexCache) {
          idx._deleted = true;
        }
        // Clear index names cache to show empty
        store._indexNamesCache = new DOMStringList([]);
      }
    }

    // Revert deleted stores: un-delete them
    for (const name of this._deletedStoreNames) {
      const store = this._deletedStoreCache.get(name) || this._objectStoreCache.get(name);
      if (store) {
        store._deleted = false;
        // Restore indexes that were on the store before deletion
        // Re-read from the database (which was rolled back)
        const meta = this._db._backend.getObjectStoreMetadata(this._db._name, name);
        if (meta) {
          store._storeId = meta.id;
          // Un-delete all cached indexes on this store
          for (const [, idx] of store._indexCache) {
            idx._deleted = false;
          }
          // Invalidate index names to re-read from DB
          store._indexNamesCache = null;
        }
      }
    }

    // Revert created indexes: mark them as deleted (if store is not already deleted)
    for (const { index } of this._createdIndexes) {
      index._deleted = true;
    }

    // Revert deleted indexes: un-delete them
    for (const { store, index, name } of this._deletedIndexes) {
      if (!store._deleted) {
        index._deleted = false;
        // Re-add to cache
        store._indexCache.set(name, index);
      }
    }

    // Invalidate index names caches on all stores that are not deleted
    for (const [, store] of this._objectStoreCache) {
      if (!store._deleted) {
        store._indexNamesCache = null;
      }
    }
    for (const [, store] of this._deletedStoreCache) {
      if (!store._deleted) {
        store._indexNamesCache = null;
      }
    }

    // Revert objectStoreNames on this transaction and the database
    const revertedNames = this._db._backend.getObjectStoreNames(this._db._name);
    this._storeNames = revertedNames.slice().sort();
    this._objectStoreNames = new DOMStringList(this._storeNames);
    this._db._objectStoreNamesCache = null;
  }

  commit(): void {
    if (this._state === 'finished') {
      throw new DOMException(
        "Failed to execute 'commit' on 'IDBTransaction': The transaction has already been committed or aborted.",
        'InvalidStateError'
      );
    }
    this._state = 'committing';
    this._commitWhenDone();
  }

  /** Start the savepoint if not already started */
  _ensureSavepoint(): void {
    if (!this._savepointStarted) {
      this._db._backend.beginSavepoint(this._db._name, this._savepointName);
      this._savepointStarted = true;
    }
  }

  /** Internal: create and queue a request */
  _createRequest(source: any): IDBRequest {
    if (this._state !== 'active') {
      throw new DOMException(
        'The transaction is not active.',
        'TransactionInactiveError'
      );
    }
    const request = new IDBRequest();
    request._source = source;
    request._transaction = this;
    this._requests.push(request);
    this._pendingRequestCount++;
    return request;
  }

  /** Queue a request event callback, respecting scheduler */
  _queueRequestCallback(callback: () => void): void {
    if (this._useScheduler && !this._started) {
      // Buffer until scheduler starts us
      this._pendingCallbacks.push(() => queueTask(callback));
    } else {
      queueTask(callback);
    }
  }

  /** Queue a full request: operation (SQLite work) + event dispatch.
   *  Both are deferred if the transaction hasn't been started by the scheduler.
   */
  _queueOperation(operation: () => void, eventCallback: () => void): void {
    if (this._useScheduler && !this._started) {
      this._pendingCallbacks.push(() => {
        operation();
        queueTask(eventCallback);
      });
    } else {
      operation();
      queueTask(eventCallback);
    }
  }

  /** Called by scheduler when this transaction can start */
  _schedulerStart(): void {
    this._started = true;
    // Flush any buffered callbacks - each one may queue further setTimeout tasks
    for (const cb of this._pendingCallbacks) {
      cb();
    }
    this._pendingCallbacks = [];

    // If the transaction was marked for auto-commit (empty, already deactivated),
    // commit now that the scheduler has given permission.
    if (this._commitOnStart) {
      this._commitOnStart = false;
      this._maybeAutoCommit();
    }
  }

  /** Auto-commit when all requests are done and transaction becomes inactive */
  _commitWhenDone(): void {
    if (this._state === 'finished' || this._aborted) return;

    // Release the savepoint (commit)
    if (this._savepointStarted) {
      try {
        this._db._backend.releaseSavepoint(this._db._name, this._savepointName);
      } catch (e) {
        // If release fails, abort
        this._error = new DOMException('Commit failed', 'AbortError');
        this._state = 'finished';
        const abortEvent = new Event('abort', { bubbles: true, cancelable: false });
        this.dispatchEvent(abortEvent);
        return;
      }
      this._savepointStarted = false;
    }

    this._state = 'finished';

    // Fire complete event
    queueTask(() => {
      const completeEvent = new Event('complete');
      this.dispatchEvent(completeEvent);

      // Notify scheduler
      if (this._useScheduler) {
        getScheduler(this._db._name).transactionFinished(this);
      }

      // Notify database about completion for versionchange transactions
      if (this._mode === 'versionchange') {
        this._db._versionChangeTransactionFinished(false);
      }
    });
  }

  /** Called after a request's event has been dispatched */
  _requestFinished(): void {
    this._pendingRequestCount--;
    this._maybeAutoCommit();
  }

  /** Check if the transaction should auto-commit */
  _maybeAutoCommit(): void {
    if (this._state === 'inactive' && !this._aborted && this._pendingRequestCount <= 0) {
      // If using scheduler and not yet started, defer commit until started
      if (this._useScheduler && !this._started) {
        this._commitOnStart = true;
        return;
      }
      this._state = 'committing';
      this._commitWhenDone();
    }
  }

  /** Deactivate the transaction (called after event handlers finish) */
  _deactivate(): void {
    if (this._state === 'active') {
      this._state = 'inactive';
    }
  }

  /**
   * Dispatch a request's event with proper IDB semantics:
   * - Transaction is set active before dispatch
   * - Transaction stays active through the microtask checkpoint
   * - If an exception is thrown in any handler, the transaction aborts
   * - For error events: if not preventDefault'd, auto-abort with request's error as tx.error
   * - Deactivation + requestFinished happen after microtask checkpoint
   */
  _dispatchRequestEvent(request: IDBRequest, event: Event): void {
    if (this._aborted || this._state === 'finished') {
      this._requestFinished();
      return;
    }

    this._state = 'active';

    const notPrevented = request.dispatchEvent(event);
    const exceptionThrown = !!(event as any)._exceptionThrown;

    if (exceptionThrown) {
      // Per spec: if an exception was thrown during dispatch, abort the transaction
      // (event handlers may have already changed state via abort()/commit())
      if (!this._aborted && (this._state as string) !== 'finished') {
        this._error = new DOMException('The transaction was aborted.', 'AbortError');
        this.abort();
      }
      return;
    }

    if (event.type === 'error' && notPrevented) {
      // Per spec: if error event was not preventDefault'd, abort the transaction
      // Set tx.error to the request's error (e.g., ConstraintError), not AbortError
      if (!this._aborted && (this._state as string) !== 'finished') {
        this._error = request._error;
        this.abort();
        return;
      }
    }

    // Keep transaction active through microtask checkpoint, then deactivate
    queueMicrotask(() => queueMicrotask(() => {
      this._deactivate();
      this._requestFinished();
    }));
  }
}
