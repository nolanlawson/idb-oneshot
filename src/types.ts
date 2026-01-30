// Shared TypeScript interfaces and types

export type IDBKey = number | string | Date | ArrayBuffer | IDBKey[];

// Valid key as stored internally (ArrayBuffer views are converted to ArrayBuffer)
export type IDBValidKey = number | string | Date | ArrayBuffer | IDBValidKey[];

// Transaction mode type (not available in Node's type system)
declare global {
  type IDBTransactionMode = 'readonly' | 'readwrite' | 'versionchange';
  type IDBCursorDirection = 'next' | 'nextunique' | 'prev' | 'prevunique';
}
