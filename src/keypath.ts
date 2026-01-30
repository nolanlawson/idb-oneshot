// Key path validation and evaluation per IndexedDB spec
// https://w3c.github.io/IndexedDB/#key-path-construct

import { valueToKey } from './keys.ts';
import type { IDBValidKey } from './types.ts';

/**
 * Validate a single key path identifier.
 * Per spec, identifiers follow ECMAScript IdentifierName which includes
 * Unicode letters (Lu, Ll, Lt, Lm, Lo, Nl), combining marks, digits, etc.
 * We use a regex that supports Unicode identifier characters.
 */
function isValidIdentifier(ident: string): boolean {
  if (ident.length === 0) return false;
  // ECMAScript IdentifierName: IdentifierStart (IdentifierPart)*
  // IdentifierStart: $, _, or any Unicode ID_Start character
  // IdentifierPart: $, _, \u200C, \u200D, or any Unicode ID_Continue character
  // Using Unicode property escapes (supported in Node.js 10+)
  try {
    // Test if the identifier is a valid ECMAScript identifier name
    // This regex uses Unicode property escapes for full spec compliance
    return /^[\p{ID_Start}_$][\p{ID_Continue}$\u200C\u200D]*$/u.test(ident);
  } catch {
    // Fallback for environments without Unicode property escape support
    return /^[a-zA-Z_$\u00C0-\uFFFF][a-zA-Z0-9_$\u00B7\u00C0-\uFFFF]*$/.test(ident);
  }
}

/**
 * Validate a key path string per the spec.
 * A key path is either:
 * - An empty string (use value itself as key)
 * - A dot-separated sequence of valid identifiers
 */
export function isValidKeyPathString(keyPath: string): boolean {
  if (keyPath === '') return true;
  const parts = keyPath.split('.');
  return parts.every(p => isValidIdentifier(p));
}

/**
 * Validate a key path (string, array of strings, or null).
 */
export function isValidKeyPath(keyPath: string | string[] | null): boolean {
  if (keyPath === null) return true;
  if (Array.isArray(keyPath)) {
    if (keyPath.length === 0) return false;
    return keyPath.every(p => typeof p === 'string' && isValidKeyPathString(p));
  }
  if (typeof keyPath !== 'string') return false;
  return isValidKeyPathString(keyPath);
}

// Sentinel: key path resolved to a value that is not a valid key and not undefined.
export const KEY_NOT_VALID = Symbol('KEY_NOT_VALID');

/**
 * Evaluate a key path on a value.
 * Returns:
 * - A valid IDBValidKey if the path resolves to a valid key
 * - null if the path cannot be resolved (property doesn't exist or intermediate is not an object)
 * - KEY_NOT_VALID if the path resolves to a defined value that is not a valid key
 */
export function evaluateKeyPathDetailed(value: any, keyPath: string): IDBValidKey | null | typeof KEY_NOT_VALID {
  if (keyPath === '') {
    const key = valueToKey(value);
    return key !== null ? key : (value !== undefined ? KEY_NOT_VALID : null);
  }
  const parts = keyPath.split('.');
  let current = value;
  for (const part of parts) {
    if (current === null || current === undefined) {
      return null;
    }
    if (typeof current !== 'object' && typeof current !== 'string') {
      return null;
    }
    if (typeof current === 'string') {
      if (part === 'length') {
        current = current.length;
      } else {
        return null;
      }
    } else {
      if (!(part in current)) {
        return null;
      }
      current = current[part];
    }
  }
  const key = valueToKey(current);
  if (key === null && current !== undefined) {
    return KEY_NOT_VALID;
  }
  return key;
}

/**
 * Evaluate a key path on a value and return the result as an IDB key.
 * Returns null if the key path cannot be resolved or the result is not a valid key.
 */
export function evaluateKeyPath(value: any, keyPath: string): IDBValidKey | null {
  const result = evaluateKeyPathDetailed(value, keyPath);
  if (result === KEY_NOT_VALID) return null;
  return result;
}

/**
 * Evaluate a key path on a value and return the raw result (without key validation).
 * Used for multi-entry index extraction where the value may be an array
 * containing non-key elements.
 */
export function evaluateKeyPathRaw(value: any, keyPath: string): any {
  if (keyPath === '') return value;
  const parts = keyPath.split('.');
  let current = value;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

/**
 * Extract a key from a value using a key path (string or array of strings).
 */
export function extractKeyFromValue(value: any, keyPath: string | string[]): IDBValidKey | null {
  if (typeof keyPath === 'string') {
    return evaluateKeyPath(value, keyPath);
  }
  const result: IDBValidKey[] = [];
  for (const path of keyPath as string[]) {
    const key = evaluateKeyPath(value, path);
    if (key === null) return null;
    result.push(key);
  }
  return result;
}

/**
 * Inject a key into a value at the given key path.
 * Creates intermediate objects as needed.
 * The value should already be a clone.
 */
export function injectKeyIntoValue(value: any, keyPath: string | string[], key: IDBValidKey): any {
  if (typeof keyPath === 'string') {
    const clone = typeof value === 'object' && value !== null ? value : value;
    const parts = keyPath.split('.');
    let current = clone;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!(parts[i] in current)) {
        current[parts[i]] = {};
      }
      current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = key;
    return clone;
  }
  return value;
}

/**
 * Check if a key can be injected at the given key path.
 * Per spec, the "check that a key could be injected" algorithm
 * verifies that intermediate steps resolve to objects (not primitives).
 */
export function canInjectKey(value: any, keyPath: string): boolean {
  if (typeof keyPath !== 'string') return true;
  const parts = keyPath.split('.');
  if (parts.length <= 1) {
    // Single segment: value must be an object to inject into
    return typeof value === 'object' && value !== null;
  }
  let current = value;
  // Check all segments except the last
  for (let i = 0; i < parts.length - 1; i++) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return false;
    }
    if (Object.prototype.hasOwnProperty.call(current, parts[i])) {
      current = current[parts[i]];
      // If this intermediate value is not an object, we can't inject
      if (current !== undefined && current !== null && typeof current !== 'object') {
        return false;
      }
    } else {
      // Property doesn't exist — we'll create it, so it's injectable
      return true;
    }
  }
  return true;
}
