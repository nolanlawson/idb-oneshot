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
    // Escape U+0000 as 0x00 0x01 so 0x00 0x00 can serve as terminator
    const bytes: number[] = [];
    for (let i = 0; i < key.length; i++) {
      const code = key.charCodeAt(i);
      const hi = (code >> 8) & 0xff;
      const lo = code & 0xff;
      if (code === 0) {
        bytes.push(0x00, 0x01); // escape NUL
      } else {
        bytes.push(hi, lo);
      }
    }
    bytes.push(0x00, 0x00); // terminator
    parts.push(new Uint8Array(bytes));
  } else if (key instanceof ArrayBuffer) {
    parts.push(new Uint8Array([TAG_BINARY]));
    // Escape 0x00 as 0x00 0x01 so 0x00 0x00 can serve as terminator
    const src = new Uint8Array(key);
    const bytes: number[] = [];
    for (let i = 0; i < src.length; i++) {
      if (src[i] === 0x00) {
        bytes.push(0x00, 0x01); // escape
      } else {
        bytes.push(src[i]);
      }
    }
    bytes.push(0x00, 0x00); // terminator
    parts.push(new Uint8Array(bytes));
  } else if (Array.isArray(key)) {
    parts.push(new Uint8Array([TAG_ARRAY]));
    for (const element of key) {
      encodeKeyInto(element, parts);
    }
    parts.push(new Uint8Array([TAG_ARRAY_TERMINATOR]));
  }
}

/** Decode a binary-encoded key back into an IDBValidKey */
export function decodeKey(buf: Buffer | Uint8Array): IDBValidKey {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const { key } = decodeKeyAt(bytes, 0);
  return key;
}

function decodeKeyAt(bytes: Uint8Array, offset: number): { key: IDBValidKey; nextOffset: number } {
  const tag = bytes[offset];
  offset++;

  if (tag === TAG_NUMBER || tag === TAG_DATE) {
    const dbytes = new Uint8Array(8);
    dbytes.set(bytes.subarray(offset, offset + 8));
    if (dbytes[0] & 0x80) {
      dbytes[0] ^= 0x80;
    } else {
      for (let i = 0; i < 8; i++) dbytes[i] ^= 0xff;
    }
    const view = new DataView(dbytes.buffer, dbytes.byteOffset, 8);
    const value = view.getFloat64(0, false);
    if (tag === TAG_DATE) {
      return { key: new Date(value), nextOffset: offset + 8 };
    }
    return { key: value, nextOffset: offset + 8 };
  }

  if (tag === TAG_STRING) {
    // Read UTF-16 BE pairs until 0x00 0x00 terminator
    // 0x00 0x01 is escaped NUL character (U+0000)
    const chars: number[] = [];
    let pos = offset;
    while (pos + 1 < bytes.length) {
      if (bytes[pos] === 0x00 && bytes[pos + 1] === 0x00) {
        pos += 2; // skip terminator
        break;
      }
      if (bytes[pos] === 0x00 && bytes[pos + 1] === 0x01) {
        chars.push(0); // unescaped NUL
        pos += 2;
        continue;
      }
      const code = (bytes[pos] << 8) | bytes[pos + 1];
      chars.push(code);
      pos += 2;
    }
    return { key: String.fromCharCode(...chars), nextOffset: pos };
  }

  if (tag === TAG_BINARY) {
    // Read bytes until 0x00 0x00 terminator
    // 0x00 0x01 is escaped 0x00 byte
    const data: number[] = [];
    let pos = offset;
    while (pos < bytes.length) {
      if (pos + 1 < bytes.length && bytes[pos] === 0x00 && bytes[pos + 1] === 0x00) {
        pos += 2; // skip terminator
        break;
      }
      if (pos + 1 < bytes.length && bytes[pos] === 0x00 && bytes[pos + 1] === 0x01) {
        data.push(0); // unescaped 0x00
        pos += 2;
        continue;
      }
      data.push(bytes[pos]);
      pos++;
    }
    return { key: new Uint8Array(data).buffer as ArrayBuffer, nextOffset: pos };
  }

  if (tag === TAG_ARRAY) {
    const elements: IDBValidKey[] = [];
    let pos = offset;
    while (pos < bytes.length && bytes[pos] !== TAG_ARRAY_TERMINATOR) {
      const { key, nextOffset } = decodeKeyAt(bytes, pos);
      elements.push(key);
      pos = nextOffset;
    }
    if (pos < bytes.length) pos++; // skip terminator
    return { key: elements, nextOffset: pos };
  }

  throw new Error(`Unknown key tag: 0x${tag.toString(16)}`);
}
