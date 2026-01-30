// Shared TypeScript interfaces and types

export type IDBKey = number | string | Date | ArrayBuffer | IDBKey[];

// Valid key as stored internally (ArrayBuffer views are converted to ArrayBuffer)
export type IDBValidKey = number | string | Date | ArrayBuffer | IDBValidKey[];
