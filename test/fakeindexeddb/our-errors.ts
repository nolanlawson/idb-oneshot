function makeDOMExceptionSubclass(name: string, code: number) {
  return class extends DOMException {
    constructor(message?: string) {
      super(message ?? "", name);
    }
    static get code() {
      return code;
    }
  };
}

// DOMException error codes from the WebIDL spec
export const AbortError = makeDOMExceptionSubclass("AbortError", 20);
export const ConstraintError = makeDOMExceptionSubclass("ConstraintError", 0);
export const DataCloneError = makeDOMExceptionSubclass("DataCloneError", 25);
export const DataError = makeDOMExceptionSubclass("DataError", 0);
export const InvalidAccessError = makeDOMExceptionSubclass("InvalidAccessError", 15);
export const InvalidStateError = makeDOMExceptionSubclass("InvalidStateError", 11);
export const NotFoundError = makeDOMExceptionSubclass("NotFoundError", 8);
export const ReadOnlyError = makeDOMExceptionSubclass("ReadOnlyError", 0);
export const TransactionInactiveError = makeDOMExceptionSubclass("TransactionInactiveError", 0);
export const VersionError = makeDOMExceptionSubclass("VersionError", 0);
