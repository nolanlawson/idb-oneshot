// IDBFactory implementation
// Phase 1: only cmp() is implemented

import { valueToKeyOrThrow, compareKeys } from './keys.ts';
import type { IDBValidKey } from './types.ts';

export interface IDBFactoryOptions {
  storagePath: string;
}

export class IDBFactory {
  private _storagePath: string;

  constructor(options: IDBFactoryOptions) {
    this._storagePath = options.storagePath;
  }

  cmp(first: any, second: any): number {
    if (arguments.length < 2) {
      throw new TypeError(
        "Failed to execute 'cmp' on 'IDBFactory': 2 arguments required, but only " +
          arguments.length +
          ' present.'
      );
    }
    const a = valueToKeyOrThrow(first);
    const b = valueToKeyOrThrow(second);
    return compareKeys(a as IDBValidKey, b as IDBValidKey);
  }

  // Stubs for Phase 2+
  open(_name: string, _version?: number): any {
    throw new Error('IDBFactory.open() not yet implemented');
  }

  deleteDatabase(_name: string): any {
    throw new Error('IDBFactory.deleteDatabase() not yet implemented');
  }

  databases(): Promise<Array<{ name: string; version: number }>> {
    throw new Error('IDBFactory.databases() not yet implemented');
  }
}
