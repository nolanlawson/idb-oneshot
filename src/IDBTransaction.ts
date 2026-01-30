// IDBTransaction implementation

import { DOMStringList } from './DOMStringList.ts';
import { IDBRequest } from './IDBRequest.ts';
import { queueTask } from './scheduling.ts';

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

  // Event handlers
  onabort: ((this: IDBTransaction, ev: Event) => any) | null = null;
  oncomplete: ((this: IDBTransaction, ev: Event) => any) | null = null;
  onerror: ((this: IDBTransaction, ev: Event) => any) | null = null;

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

  constructor(db: any, storeNames: string[], mode: IDBTransactionMode) {
    super();
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
    if (this._state === 'committing' || this._state === 'finished') {
      throw new DOMException(
        "Failed to execute 'abort' on 'IDBTransaction': The transaction has already been committed or aborted.",
        'InvalidStateError'
      );
    }
    this._aborted = true;
    this._state = 'finished';
    this._error = new DOMException('The transaction was aborted.', 'AbortError');

    // Rollback SQLite savepoint
    if (this._savepointStarted) {
      try {
        this._db._backend.rollbackSavepoint(this._db._name, this._savepointName);
      } catch {
        // ignore errors during rollback
      }
      this._savepointStarted = false;
    }

    // Set error on all pending requests
    for (const request of this._requests) {
      if (request._readyState === 'pending') {
        request._readyState = 'done';
        request._error = this._error;
      }
    }

    // Fire abort event
    queueTask(() => {
      const abortEvent = new Event('abort', { bubbles: true, cancelable: false });
      this.dispatchEvent(abortEvent);

      // Notify database about abort for versionchange transactions
      if (this._mode === 'versionchange') {
        this._db._versionChangeTransactionFinished(true);
      }
    });
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
}
