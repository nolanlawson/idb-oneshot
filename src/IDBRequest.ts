// IDBRequest and IDBOpenDBRequest implementation

export class IDBRequest extends EventTarget {
  _result: any = undefined;
  _error: DOMException | null = null;
  _readyState: 'pending' | 'done' = 'pending';
  _source: any = null;
  _transaction: any = null;

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
    // In the DOM, on* attribute handlers fire alongside addEventListener listeners.
    // We temporarily add the on* handler as a listener so event.target is set correctly.
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
  onblocked: ((this: IDBOpenDBRequest, ev: Event) => any) | null = null;
  onupgradeneeded: ((this: IDBOpenDBRequest, ev: Event) => any) | null = null;
}
