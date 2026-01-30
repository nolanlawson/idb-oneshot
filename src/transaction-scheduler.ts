// Transaction Scheduler
// Manages transaction execution order per database per the IndexedDB spec.
//
// Rules:
// - Multiple readonly transactions with non-overlapping or overlapping scopes can run in parallel
// - A readwrite transaction blocks other readwrite transactions with overlapping scopes
// - A readwrite transaction blocks readonly transactions with overlapping scopes
// - Transactions execute in creation order when they have overlapping scopes
// - Transactions on different databases are independent

interface PendingTransaction {
  transaction: any; // IDBTransaction
  scope: string[];
  mode: IDBTransactionMode;
  started: boolean;
  onStart: () => void;
}

// Per-database scheduler
class DatabaseScheduler {
  // Queue of all transactions (pending + active), in creation order
  _queue: PendingTransaction[] = [];

  addTransaction(transaction: any, scope: string[], mode: IDBTransactionMode, onStart: () => void): void {
    const entry: PendingTransaction = {
      transaction,
      scope,
      mode,
      started: false,
      onStart,
    };
    this._queue.push(entry);
    this._processQueue();
  }

  transactionFinished(transaction: any): void {
    const idx = this._queue.findIndex(e => e.transaction === transaction);
    if (idx !== -1) {
      this._queue.splice(idx, 1);
    }
    this._processQueue();
  }

  _processQueue(): void {
    for (const entry of this._queue) {
      if (entry.started) continue;
      if (this._canStart(entry)) {
        entry.started = true;
        // Start asynchronously to avoid re-entrance issues
        const startFn = entry.onStart;
        queueMicrotask(() => startFn());
      }
    }
  }

  _canStart(entry: PendingTransaction): boolean {
    // Check all transactions that were created before this one
    for (const other of this._queue) {
      if (other === entry) break; // Only check transactions created before this one
      if (!other.started) continue; // Not started yet, can't block
      if (!this._scopesOverlap(entry.scope, other.scope)) continue;

      // Overlapping scopes:
      // - If either transaction is readwrite, they conflict
      if (entry.mode === 'readwrite' || other.mode === 'readwrite') {
        return false;
      }
      // Both readonly with overlapping scopes is fine
    }

    // Also check if any earlier pending (not started) transaction would need to go first
    // (to maintain creation order for conflicting transactions)
    for (const other of this._queue) {
      if (other === entry) break;
      if (other.started) continue;
      // There's an earlier unstarted transaction - does it conflict with us?
      if (!this._scopesOverlap(entry.scope, other.scope)) continue;
      if (entry.mode === 'readwrite' || other.mode === 'readwrite') {
        return false;
      }
    }

    return true;
  }

  _scopesOverlap(a: string[], b: string[]): boolean {
    for (const name of a) {
      if (b.includes(name)) return true;
    }
    return false;
  }
}

// Global scheduler map: dbName -> DatabaseScheduler
const schedulers = new Map<string, DatabaseScheduler>();

export function getScheduler(dbName: string): DatabaseScheduler {
  let scheduler = schedulers.get(dbName);
  if (!scheduler) {
    scheduler = new DatabaseScheduler();
    schedulers.set(dbName, scheduler);
  }
  return scheduler;
}
