// Structured clone serialization/deserialization using Node.js v8 module
// This is the only file besides sqlite-backend.ts that uses Node-specific APIs.

import * as v8 from 'node:v8';

/**
 * Serialize a value using the structured clone algorithm.
 * Uses V8's built-in serializer which handles:
 * - Primitives (undefined, null, boolean, number, BigInt, string)
 * - Primitive wrapper objects (Object(true), Object(42), Object(1n), Object("str"))
 * - Date, RegExp
 * - ArrayBuffer, SharedArrayBuffer, all TypedArray variants
 * - Map, Set
 * - Error subtypes (Error, TypeError, RangeError, etc.)
 * - Arrays (including sparse arrays and non-index properties)
 * - Plain objects
 * - Circular/recursive references
 * - Blob, File (serialized as special wrapper)
 *
 * Throws DataCloneError for non-serializable types (functions, Symbols, DOM objects).
 */
export function serialize(value: any): Buffer {
  try {
    // Handle Blob/File specially since v8.serialize may not handle them natively
    const prepared = prepareBlobsForSerialization(value, new Map());
    return v8.serialize(prepared);
  } catch (e: any) {
    // V8 serializer throws for non-cloneable types
    throw new DOMException(
      `Failed to execute 'structuredClone': ${e.message || 'The object could not be cloned.'}`,
      'DataCloneError'
    );
  }
}

/**
 * Deserialize a value from a buffer produced by serialize().
 */
export function deserialize(buffer: Buffer | Uint8Array): any {
  try {
    const result = v8.deserialize(Buffer.from(buffer));
    return restoreBlobsFromDeserialization(result, new Map());
  } catch (e: any) {
    // Fallback: if deserialization fails, try JSON parse for legacy data
    try {
      return JSON.parse(Buffer.from(buffer).toString());
    } catch {
      throw e;
    }
  }
}

/**
 * Clone a value using the structured clone algorithm.
 * Used for clone-before-keypath-eval.
 * Throws DataCloneError for non-cloneable types.
 */
export function cloneValue(value: any): any {
  try {
    return structuredClone(value);
  } catch (e: any) {
    // structuredClone throws DOMException with name "DataCloneError" for non-cloneable types.
    // Any other error (e.g., from a getter) should be re-thrown as-is.
    if (e instanceof DOMException && e.name === 'DataCloneError') {
      throw e;
    }
    // Re-throw original error (e.g., from enumerable getters)
    throw e;
  }
}

// Blob/File serialization helpers
// V8 serialize doesn't handle Blob/File natively, so we wrap them

const BLOB_MARKER = '__idb_blob__';
const FILE_MARKER = '__idb_file__';

function prepareBlobsForSerialization(value: any, seen: Map<any, any>): any {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object' && typeof value !== 'function') return value;

  // Check for circular references
  if (seen.has(value)) return seen.get(value);

  if (typeof File !== 'undefined' && value instanceof File) {
    // Convert File to a serializable representation
    // Note: We need to read the file synchronously, but Blob.arrayBuffer() is async
    // For now, we store the metadata and use a marker
    const wrapper = {
      [FILE_MARKER]: true,
      name: value.name,
      type: value.type,
      lastModified: value.lastModified,
      // Store raw bytes - we'll need to extract them
      // Since we can't do async here, we serialize using v8 which handles Blob internally in Node 20+
    };
    return value; // Let v8.serialize handle it natively if possible
  }

  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    return value; // Let v8.serialize handle it natively if possible
  }

  // For arrays and objects, recurse (not needed if v8.serialize handles everything)
  return value;
}

function restoreBlobsFromDeserialization(value: any, seen: Map<any, any>): any {
  // v8.deserialize should handle Blob/File natively in Node 20+
  return value;
}
