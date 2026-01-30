// IDBRequest and IDBOpenDBRequest implementation

import { initEventTarget, idbDispatchEvent } from './scheduling.ts';

export class IDBRequest extends EventTarget {
  _result: any = undefined;
  _error: DOMException | null = null;
  _readyState: 'pending' | 'done' = 'pending';
  _source: any = null;
  _transaction: any = null;
  _constraintError: boolean = false;
  _suppressBubble: boolean = false;

  constructor() {
    super();
    initEventTarget(this);
  }

  get result(): any {
    if (this._readyState === 'pending') {
      throw new DOMException(
        "Failed to read the 'result' property from 'IDBRequest': The request has not finished.",
        'InvalidStateError'
      );
    }
    return this._result;
  }

  get error(): DOMException | null {
    if (this._readyState === 'pending') {
      throw new DOMException(
        "Failed to read the 'error' property from 'IDBRequest': The request has not finished.",
        'InvalidStateError'
      );
    }
    return this._error;
  }

  get readyState(): string {
    return this._readyState;
  }

  get source(): any {
    return this._source;
  }

  get transaction(): any {
    return this._transaction;
  }

  dispatchEvent(event: Event): boolean {
    // Build ancestor path for proper IDB event propagation (capture/target/bubble)
    const ancestors: EventTarget[] = [];
    if (this._transaction && !this._suppressBubble) {
      ancestors.push(this._transaction);
      if (this._transaction._db) {
        ancestors.push(this._transaction._db);
      }
    }

    if (ancestors.length > 0 && !this._suppressBubble) {
      return idbDispatchEvent(this, ancestors, event);
    }

    // Simple dispatch with on* handler (for IDBOpenDBRequest without transaction)
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

  // Event handlers
  onsuccess: ((this: IDBRequest, ev: Event) => any) | null = null;
  onerror: ((this: IDBRequest, ev: Event) => any) | null = null;
}

export class IDBOpenDBRequest extends IDBRequest {
  get [Symbol.toStringTag]() { return 'IDBOpenDBRequest'; }

  onblocked: ((this: IDBOpenDBRequest, ev: Event) => any) | null = null;
  onupgradeneeded: ((this: IDBOpenDBRequest, ev: Event) => any) | null = null;
}
