// DOMException helpers

export function dataError(message: string): DOMException {
  return new DOMException(message, 'DataError');
}

export function readOnlyError(message: string): DOMException {
  return new DOMException(message, 'ReadOnlyError');
}

export function transactionInactiveError(message: string): DOMException {
  return new DOMException(message, 'TransactionInactiveError');
}

export function invalidStateError(message: string): DOMException {
  return new DOMException(message, 'InvalidStateError');
}

export function notFoundError(message: string): DOMException {
  return new DOMException(message, 'NotFoundError');
}

export function constraintError(message: string): DOMException {
  return new DOMException(message, 'ConstraintError');
}

export function invalidAccessError(message: string): DOMException {
  return new DOMException(message, 'InvalidAccessError');
}

export function abortError(message: string): DOMException {
  return new DOMException(message, 'AbortError');
}

export function versionError(message: string): DOMException {
  return new DOMException(message, 'VersionError');
}
