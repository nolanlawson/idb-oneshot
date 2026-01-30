// Public API — barrel export

// Register the IDBObjectStore factory to break circular dependency
import { IDBObjectStore } from './IDBObjectStore.ts';
import { _setObjectStoreFactory } from './IDBTransaction.ts';
_setObjectStoreFactory((transaction, name) => new IDBObjectStore(transaction, name));

export { IDBFactory } from './IDBFactory.ts';
export { IDBKeyRange } from './IDBKeyRange.ts';
export { IDBRequest, IDBOpenDBRequest } from './IDBRequest.ts';
export { IDBDatabase } from './IDBDatabase.ts';
export { IDBTransaction } from './IDBTransaction.ts';
export { IDBObjectStore } from './IDBObjectStore.ts';
export { IDBIndex } from './IDBIndex.ts';
export { IDBCursor, IDBCursorWithValue } from './IDBCursor.ts';
export { IDBRecord } from './IDBRecord.ts';
export { IDBVersionChangeEvent } from './IDBVersionChangeEvent.ts';
export { DOMStringList } from './DOMStringList.ts';
