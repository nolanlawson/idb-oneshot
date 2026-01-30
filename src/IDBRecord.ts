// IDBRecord — returned by getAllRecords()

export class IDBRecord {
  get [Symbol.toStringTag]() { return 'IDBRecord'; }

  _key: any;
  _primaryKey: any;
  _value: any;

  constructor(key: any, primaryKey: any, value: any) {
    this._key = key;
    this._primaryKey = primaryKey;
    this._value = value;
  }

  get key(): any {
    return this._key;
  }

  get primaryKey(): any {
    return this._primaryKey;
  }

  get value(): any {
    return this._value;
  }
}
