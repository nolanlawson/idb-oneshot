// DOMStringList implementation

export class DOMStringList {
  private _items: string[];
  [index: number]: string;

  constructor(items: string[]) {
    this._items = [...items];
    for (let i = 0; i < this._items.length; i++) {
      Object.defineProperty(this, i, {
        get: () => this._items[i],
        enumerable: true,
        configurable: false,
      });
    }
  }

  get length(): number {
    return this._items.length;
  }

  item(index: number): string | null {
    return this._items[index] ?? null;
  }

  contains(string: string): boolean {
    return this._items.includes(string);
  }

  [Symbol.iterator](): IterableIterator<string> {
    return this._items[Symbol.iterator]();
  }
}
