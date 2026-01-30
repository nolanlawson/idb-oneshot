// Key validation, comparison, and binary encoding
// Spec: https://w3c.github.io/IndexedDB/#key-construct

import type { IDBValidKey } from './types.ts';

// Type tags for key ordering (number < date < string < binary < array)
const KeyType_Number = 1;
const KeyType_Date = 2;
const KeyType_String = 3;
const KeyType_Binary = 4;
const KeyType_Array = 5;

type KeyTypeValue = 1 | 2 | 3 | 4 | 5;

function keyType(key: IDBValidKey): KeyTypeValue {
  if (typeof key === 'number') return KeyType_Number;
  if (key instanceof Date) return KeyType_Date;
  if (typeof key === 'string') return KeyType_String;
  if (key instanceof ArrayBuffer) return KeyType_Binary;
  if (Array.isArray(key)) return KeyType_Array;
  throw new Error('Invalid key type');
}

/**
 * Validate whether a value is a valid IndexedDB key.
 * Returns the key (with ArrayBuffer views converted) or null if invalid.
 *
 * Spec: https://w3c.github.io/IndexedDB/#key-construct
 */
export function valueToKey(input: unknown, seen?: Set<object>): IDBValidKey | null {
  if (typeof input === 'number') {
    return Number.isNaN(input) ? null : input;
  }
  if (input instanceof Date) {
    const time = input.getTime();
    return Number.isNaN(time) || !Number.isFinite(time) ? null : input;
  }
  if (typeof input === 'string') {
    return input;
  }
  if (
    input instanceof ArrayBuffer ||
    ArrayBuffer.isView(input)
  ) {
    if (ArrayBuffer.isView(input)) {
      // Convert to ArrayBuffer (use unsigned byte view of the underlying buffer)
      return (input.buffer as ArrayBuffer).slice(input.byteOffset, input.byteOffset + input.byteLength);
    }
    return input;
  }
  // Must check Array.isArray BEFORE checking for Proxy.
  // Proxy of an array returns true for Array.isArray but is NOT a valid key per spec.
  if (Array.isArray(input)) {
    // Reject Proxy-wrapped arrays: they are Array.isArray but not instanceof Array
    if (!(input instanceof Array)) {
      return null;
    }
    if (!seen) seen = new Set();
    if (seen.has(input)) return null; // recursive
    seen.add(input);

    const len = input.length;
    const result: IDBValidKey[] = [];
    for (let i = 0; i < len; i++) {
      // Sparse array check: property must exist
      if (!(i in input)) return null;
      const element = valueToKey(input[i], seen);
      if (element === null) return null;
      result.push(element);
    }
    seen.delete(input);
    return result;
  }
  return null;
}

/**
 * Convert value to key, throwing DataError if invalid.
 */
export function valueToKeyOrThrow(input: unknown): IDBValidKey {
  const key = valueToKey(input);
  if (key === null) {
    throw new DOMException(
      `The parameter is not a valid key.`,
      'DataError'
    );
  }
  return key;
}

/**
 * Compare two valid IndexedDB keys.
 * Returns -1, 0, or 1.
 *
 * Spec: https://w3c.github.io/IndexedDB/#compare-two-keys
 */
export function compareKeys(a: IDBValidKey, b: IDBValidKey): -1 | 0 | 1 {
  const ta = keyType(a);
  const tb = keyType(b);

  if (ta !== tb) {
    return ta < tb ? -1 : 1;
  }

  switch (ta) {
    case KeyType_Number: {
      const na = a as number;
      const nb = b as number;
      if (na === nb || (Object.is(na, 0) && Object.is(nb, -0)) || (Object.is(na, -0) && Object.is(nb, 0))) return 0;
      return na < nb ? -1 : 1;
    }
    case KeyType_Date: {
      const da = (a as Date).getTime();
      const db = (b as Date).getTime();
      if (da === db) return 0;
      return da < db ? -1 : 1;
    }
    case KeyType_String: {
      const sa = a as string;
      const sb = b as string;
      if (sa === sb) return 0;
      return sa < sb ? -1 : 1;
    }
    case KeyType_Binary: {
      const ba = new Uint8Array(a as ArrayBuffer);
      const bb = new Uint8Array(b as ArrayBuffer);
      const len = Math.min(ba.length, bb.length);
      for (let i = 0; i < len; i++) {
        if (ba[i] !== bb[i]) return ba[i] < bb[i] ? -1 : 1;
      }
      if (ba.length === bb.length) return 0;
      return ba.length < bb.length ? -1 : 1;
    }
    case KeyType_Array: {
      const aa = a as IDBValidKey[];
      const ab = b as IDBValidKey[];
      const len = Math.min(aa.length, ab.length);
      for (let i = 0; i < len; i++) {
        const c = compareKeys(aa[i], ab[i]);
        if (c !== 0) return c;
      }
      if (aa.length === ab.length) return 0;
      return aa.length < ab.length ? -1 : 1;
    }
  }
}

// Binary encoding for SQLite storage (memcmp-sortable)
// Type tag bytes: 0x10=number, 0x20=date, 0x30=string, 0x40=binary, 0x50=array

const TAG_NUMBER = 0x10;
const TAG_DATE = 0x20;
const TAG_STRING = 0x30;
const TAG_BINARY = 0x40;
const TAG_ARRAY = 0x50;
const TAG_ARRAY_TERMINATOR = 0x00;

/**
 * Encode a double as 8 bytes in a way that preserves sort order via memcmp.
 * IEEE 754: flip sign bit. If originally negative, flip all bits.
 */
function encodeDouble(value: number): Uint8Array {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setFloat64(0, value, false); // big-endian
  const bytes = new Uint8Array(buf);

  if (bytes[0] & 0x80) {
    // Negative: flip all bits
    for (let i = 0; i < 8; i++) bytes[i] ^= 0xff;
  } else {
    // Positive or zero: flip sign bit
    bytes[0] ^= 0x80;
  }
  return bytes;
}

/**
 * Encode a key to a binary-comparable buffer.
 */
export function encodeKey(key: IDBValidKey): Uint8Array {
  const parts: Uint8Array[] = [];
  encodeKeyInto(key, parts);
  // Concatenate
  let totalLen = 0;
  for (const p of parts) totalLen += p.length;
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const p of parts) {
    result.set(p, offset);
    offset += p.length;
  }
  return result;
}

function encodeKeyInto(key: IDBValidKey, parts: Uint8Array[]): void {
  if (typeof key === 'number') {
    parts.push(new Uint8Array([TAG_NUMBER]));
    parts.push(encodeDouble(key));
  } else if (key instanceof Date) {
    parts.push(new Uint8Array([TAG_DATE]));
    parts.push(encodeDouble(key.getTime()));
  } else if (typeof key === 'string') {
    parts.push(new Uint8Array([TAG_STRING]));
    // Encode as UTF-16 code units, big-endian uint16
    const encoded = new Uint8Array(key.length * 2);
    for (let i = 0; i < key.length; i++) {
      const code = key.charCodeAt(i);
      encoded[i * 2] = (code >> 8) & 0xff;
      encoded[i * 2 + 1] = code & 0xff;
    }
    parts.push(encoded);
  } else if (key instanceof ArrayBuffer) {
    parts.push(new Uint8Array([TAG_BINARY]));
    parts.push(new Uint8Array(key));
  } else if (Array.isArray(key)) {
    parts.push(new Uint8Array([TAG_ARRAY]));
    for (const element of key) {
      encodeKeyInto(element, parts);
    }
    parts.push(new Uint8Array([TAG_ARRAY_TERMINATOR]));
  }
}
