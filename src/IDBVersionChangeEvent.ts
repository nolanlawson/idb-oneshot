// IDBVersionChangeEvent implementation

export class IDBVersionChangeEvent extends Event {
  readonly oldVersion: number;
  readonly newVersion: number | null;

  constructor(
    type: string,
    eventInitDict?: { oldVersion?: number; newVersion?: number | null }
  ) {
    super(type, { bubbles: false, cancelable: false });
    this.oldVersion = eventInitDict?.oldVersion ?? 0;
    this.newVersion = eventInitDict?.newVersion ?? null;
  }
}
