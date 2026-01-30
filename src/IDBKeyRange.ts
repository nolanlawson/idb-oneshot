// IDBKeyRange implementation
// Spec: https://w3c.github.io/IndexedDB/#keyrange

import { valueToKeyOrThrow, compareKeys } from './keys.ts';
import type { IDBValidKey } from './types.ts';

export class IDBKeyRange {
  readonly lower: any;
  readonly upper: any;
  readonly lowerOpen: boolean;
  readonly upperOpen: boolean;

  constructor(
    lower: any,
    upper: any,
    lowerOpen: boolean,
    upperOpen: boolean,
  ) {
    this.lower = lower;
    this.upper = upper;
    this.lowerOpen = lowerOpen;
    this.upperOpen = upperOpen;
  }

  /**
   * Returns true if key is included in the range.
   */
  includes(key: any): boolean {
    if (arguments.length === 0) {
      throw new TypeError(
        "Failed to execute 'includes' on 'IDBKeyRange': 1 argument required, but only 0 present."
      );
    }
    const k = valueToKeyOrThrow(key);

    // Check lower bound
    if (this.lower !== undefined) {
      const cmp = compareKeys(k as IDBValidKey, this.lower as IDBValidKey);
      if (this.lowerOpen ? cmp <= 0 : cmp < 0) return false;
    }

    // Check upper bound
    if (this.upper !== undefined) {
      const cmp = compareKeys(k as IDBValidKey, this.upper as IDBValidKey);
      if (this.upperOpen ? cmp >= 0 : cmp > 0) return false;
    }

    return true;
  }

  static only(value: any): IDBKeyRange {
    if (arguments.length === 0) {
      throw new TypeError(
        "Failed to execute 'only' on 'IDBKeyRange': 1 argument required, but only 0 present."
      );
    }
    const key = valueToKeyOrThrow(value);
    return new IDBKeyRange(key, key, false, false);
  }

  static lowerBound(lower: any, open: boolean = false): IDBKeyRange {
    if (arguments.length === 0) {
      throw new TypeError(
        "Failed to execute 'lowerBound' on 'IDBKeyRange': 1 argument required, but only 0 present."
      );
    }
    const key = valueToKeyOrThrow(lower);
    return new IDBKeyRange(key, undefined, !!open, true);
  }

  static upperBound(upper: any, open: boolean = false): IDBKeyRange {
    if (arguments.length === 0) {
      throw new TypeError(
        "Failed to execute 'upperBound' on 'IDBKeyRange': 1 argument required, but only 0 present."
      );
    }
    const key = valueToKeyOrThrow(upper);
    return new IDBKeyRange(undefined, key, true, !!open);
  }

  static bound(
    lower: any,
    upper: any,
    lowerOpen: boolean = false,
    upperOpen: boolean = false,
  ): IDBKeyRange {
    if (arguments.length < 2) {
      throw new TypeError(
        "Failed to execute 'bound' on 'IDBKeyRange': 2 arguments required, but only " +
          arguments.length +
          ' present.'
      );
    }
    const lowerKey = valueToKeyOrThrow(lower);
    const upperKey = valueToKeyOrThrow(upper);

    // Lower must not be greater than upper
    if (compareKeys(lowerKey as IDBValidKey, upperKey as IDBValidKey) > 0) {
      throw new DOMException(
        "The lower key is greater than the upper key.",
        'DataError'
      );
    }

    return new IDBKeyRange(lowerKey, upperKey, !!lowerOpen, !!upperOpen);
  }
}
