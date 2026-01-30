// SQLite backend - the only file that imports better-sqlite3
// Provides all database storage operations for the IndexedDB implementation

import Database from 'better-sqlite3';
import { mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const METADATA_DB = '_metadata.sqlite';

// Schema for per-database SQLite files
const DB_SCHEMA = `
CREATE TABLE IF NOT EXISTS object_stores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  key_path TEXT,
  auto_increment INTEGER NOT NULL DEFAULT 0,
  current_key INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS indexes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  object_store_id INTEGER NOT NULL REFERENCES object_stores(id),
  name TEXT NOT NULL,
  key_path TEXT NOT NULL,
  unique_index INTEGER NOT NULL DEFAULT 0,
  multi_entry INTEGER NOT NULL DEFAULT 0,
  UNIQUE(object_store_id, name)
);

CREATE TABLE IF NOT EXISTS records (
  object_store_id INTEGER NOT NULL,
  key BLOB NOT NULL,
  value BLOB NOT NULL,
  PRIMARY KEY (object_store_id, key)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS index_entries (
  index_id INTEGER NOT NULL,
  key BLOB NOT NULL,
  primary_key BLOB NOT NULL,
  PRIMARY KEY (index_id, key, primary_key)
) WITHOUT ROWID;
`;

export class SQLiteBackend {
  private _storagePath: string;
  private _metaDb: Database.Database;
  // Map of open database connections: dbName -> Database.Database
  private _openDbs: Map<string, Database.Database> = new Map();

  constructor(storagePath: string) {
    this._storagePath = storagePath;
    mkdirSync(storagePath, { recursive: true });
    this._metaDb = new Database(join(storagePath, METADATA_DB));
    this._metaDb.pragma('journal_mode = WAL');
    this._metaDb.exec(
      'CREATE TABLE IF NOT EXISTS databases (name TEXT PRIMARY KEY, version INTEGER NOT NULL)'
    );
  }

  /** Get or create a database connection for a named IDB database */
  getDatabase(name: string): Database.Database {
    let db = this._openDbs.get(name);
    if (!db) {
      const dbPath = join(this._storagePath, this._fileNameForDb(name));
      db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      db.exec(DB_SCHEMA);
      this._openDbs.set(name, db);
    }
    return db;
  }

  /** Close a specific database connection */
  closeDatabase(name: string): void {
    const db = this._openDbs.get(name);
    if (db) {
      db.close();
      this._openDbs.delete(name);
    }
  }

  /** Get the stored version of a database, or 0 if it doesn't exist */
  getDatabaseVersion(name: string): number {
    const row = this._metaDb
      .prepare('SELECT version FROM databases WHERE name = ?')
      .get(name) as { version: number } | undefined;
    return row ? row.version : 0;
  }

  /** Check if a database exists in metadata */
  databaseExists(name: string): boolean {
    const row = this._metaDb
      .prepare('SELECT 1 FROM databases WHERE name = ?')
      .get(name);
    return !!row;
  }

  /** Set the version of a database in metadata */
  setDatabaseVersion(name: string, version: number): void {
    this._metaDb
      .prepare(
        'INSERT INTO databases (name, version) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET version = ?'
      )
      .run(name, version, version);
  }

  /** Delete database metadata and SQLite file */
  deleteDatabaseRecord(name: string): void {
    this.closeDatabase(name);
    this._metaDb.prepare('DELETE FROM databases WHERE name = ?').run(name);
    const dbPath = join(this._storagePath, this._fileNameForDb(name));
    if (existsSync(dbPath)) {
      try {
        unlinkSync(dbPath);
      } catch {
        // ignore
      }
    }
    // Also remove WAL/SHM files
    for (const suffix of ['-wal', '-shm']) {
      const p = dbPath + suffix;
      if (existsSync(p)) {
        try { unlinkSync(p); } catch { /* ignore */ }
      }
    }
  }

  /** List all databases */
  listDatabases(): Array<{ name: string; version: number }> {
    return this._metaDb
      .prepare('SELECT name, version FROM databases')
      .all() as Array<{ name: string; version: number }>;
  }

  /** Get all object store names for a database */
  getObjectStoreNames(dbName: string): string[] {
    const db = this.getDatabase(dbName);
    const rows = db
      .prepare('SELECT name FROM object_stores ORDER BY name')
      .all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  /** Create an object store */
  createObjectStore(
    dbName: string,
    storeName: string,
    keyPath: string | string[] | null,
    autoIncrement: boolean
  ): number {
    const db = this.getDatabase(dbName);
    const result = db
      .prepare(
        'INSERT INTO object_stores (name, key_path, auto_increment) VALUES (?, ?, ?)'
      )
      .run(storeName, keyPath === null ? null : JSON.stringify(keyPath), autoIncrement ? 1 : 0);
    return Number(result.lastInsertRowid);
  }

  /** Delete an object store and its records/indexes */
  deleteObjectStore(dbName: string, storeName: string): void {
    const db = this.getDatabase(dbName);
    const store = db
      .prepare('SELECT id FROM object_stores WHERE name = ?')
      .get(storeName) as { id: number } | undefined;
    if (!store) return;
    db.prepare('DELETE FROM index_entries WHERE index_id IN (SELECT id FROM indexes WHERE object_store_id = ?)').run(store.id);
    db.prepare('DELETE FROM indexes WHERE object_store_id = ?').run(store.id);
    db.prepare('DELETE FROM records WHERE object_store_id = ?').run(store.id);
    db.prepare('DELETE FROM object_stores WHERE id = ?').run(store.id);
  }

  /** Get object store metadata */
  getObjectStoreMetadata(
    dbName: string,
    storeName: string
  ): { id: number; keyPath: string | string[] | null; autoIncrement: boolean; currentKey: number } | null {
    const db = this.getDatabase(dbName);
    const row = db
      .prepare('SELECT id, key_path, auto_increment, current_key FROM object_stores WHERE name = ?')
      .get(storeName) as
      | { id: number; key_path: string | null; auto_increment: number; current_key: number }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      keyPath: row.key_path === null ? null : JSON.parse(row.key_path),
      autoIncrement: row.auto_increment !== 0,
      currentKey: row.current_key,
    };
  }

  /** Put a record into an object store */
  putRecord(dbName: string, storeId: number, key: Buffer | Uint8Array, value: Buffer | Uint8Array): void {
    const db = this.getDatabase(dbName);
    db.prepare(
      'INSERT OR REPLACE INTO records (object_store_id, key, value) VALUES (?, ?, ?)'
    ).run(storeId, Buffer.from(key), Buffer.from(value));
  }

  /** Get a record from an object store by exact key */
  getRecord(dbName: string, storeId: number, key: Buffer | Uint8Array): Buffer | null {
    const db = this.getDatabase(dbName);
    const row = db
      .prepare('SELECT value FROM records WHERE object_store_id = ? AND key = ?')
      .get(storeId, Buffer.from(key)) as { value: Buffer } | undefined;
    return row ? row.value : null;
  }

  /** Get the first record within a key range */
  getRecordInRange(dbName: string, storeId: number, lower: Buffer | Uint8Array | null, upper: Buffer | Uint8Array | null, lowerOpen: boolean, upperOpen: boolean): { key: Buffer; value: Buffer } | null {
    const db = this.getDatabase(dbName);
    const { sql, params } = this._buildRangeQuery(
      'SELECT key, value FROM records',
      storeId, lower, upper, lowerOpen, upperOpen
    );
    const row = db.prepare(sql + ' ORDER BY key ASC LIMIT 1').get(...params) as { key: Buffer; value: Buffer } | undefined;
    return row ?? null;
  }

  /** Delete a record by exact key */
  deleteRecord(dbName: string, storeId: number, key: Buffer | Uint8Array): void {
    const db = this.getDatabase(dbName);
    db.prepare('DELETE FROM records WHERE object_store_id = ? AND key = ?').run(
      storeId,
      Buffer.from(key)
    );
  }

  /** Delete records within a key range */
  deleteRecordsInRange(dbName: string, storeId: number, lower: Buffer | Uint8Array | null, upper: Buffer | Uint8Array | null, lowerOpen: boolean, upperOpen: boolean): void {
    const db = this.getDatabase(dbName);
    const { sql, params } = this._buildRangeQuery(
      'DELETE FROM records',
      storeId, lower, upper, lowerOpen, upperOpen
    );
    db.prepare(sql).run(...params);
  }

  /** Count records in an object store, optionally within a range */
  countRecords(dbName: string, storeId: number, lower?: Buffer | Uint8Array | null, upper?: Buffer | Uint8Array | null, lowerOpen?: boolean, upperOpen?: boolean): number {
    const db = this.getDatabase(dbName);
    if (lower === undefined && upper === undefined) {
      const row = db
        .prepare('SELECT COUNT(*) as cnt FROM records WHERE object_store_id = ?')
        .get(storeId) as { cnt: number };
      return row.cnt;
    }
    const { sql, params } = this._buildRangeQuery(
      'SELECT COUNT(*) as cnt FROM records',
      storeId, lower ?? null, upper ?? null, lowerOpen ?? false, upperOpen ?? false
    );
    const row = db.prepare(sql).get(...params) as { cnt: number };
    return row.cnt;
  }

  /** Clear all records from an object store */
  clearRecords(dbName: string, storeId: number): void {
    const db = this.getDatabase(dbName);
    db.prepare('DELETE FROM records WHERE object_store_id = ?').run(storeId);
  }

  /** Check if a unique index constraint would be violated */
  checkUniqueIndexConstraint(dbName: string, indexId: number, indexKey: Buffer | Uint8Array, excludePrimaryKey?: Buffer | Uint8Array): boolean {
    const db = this.getDatabase(dbName);
    if (excludePrimaryKey) {
      const row = db.prepare(
        'SELECT 1 FROM index_entries WHERE index_id = ? AND key = ? AND primary_key != ? LIMIT 1'
      ).get(indexId, Buffer.from(indexKey), Buffer.from(excludePrimaryKey));
      return !!row;
    }
    const row = db.prepare(
      'SELECT 1 FROM index_entries WHERE index_id = ? AND key = ? LIMIT 1'
    ).get(indexId, Buffer.from(indexKey));
    return !!row;
  }

  /** Delete index entries for a primary key */
  deleteIndexEntriesForRecord(dbName: string, storeId: number, primaryKey: Buffer | Uint8Array): void {
    const db = this.getDatabase(dbName);
    db.prepare(
      'DELETE FROM index_entries WHERE primary_key = ? AND index_id IN (SELECT id FROM indexes WHERE object_store_id = ?)'
    ).run(Buffer.from(primaryKey), storeId);
  }

  /** Get all indexes for a store */
  getIndexesForStore(dbName: string, storeId: number): Array<{ id: number; keyPath: string | string[]; unique: boolean; multiEntry: boolean }> {
    const db = this.getDatabase(dbName);
    const rows = db.prepare(
      'SELECT id, key_path, unique_index, multi_entry FROM indexes WHERE object_store_id = ?'
    ).all(storeId) as Array<{ id: number; key_path: string; unique_index: number; multi_entry: number }>;
    return rows.map(r => ({
      id: r.id,
      keyPath: JSON.parse(r.key_path),
      unique: r.unique_index !== 0,
      multiEntry: r.multi_entry !== 0,
    }));
  }

  /** Build a SQL query with range conditions */
  private _buildRangeQuery(
    prefix: string,
    storeId: number,
    lower: Buffer | Uint8Array | null,
    upper: Buffer | Uint8Array | null,
    lowerOpen: boolean,
    upperOpen: boolean
  ): { sql: string; params: any[] } {
    const conditions: string[] = ['object_store_id = ?'];
    const params: any[] = [storeId];
    if (lower !== null) {
      conditions.push(lowerOpen ? 'key > ?' : 'key >= ?');
      params.push(Buffer.from(lower));
    }
    if (upper !== null) {
      conditions.push(upperOpen ? 'key < ?' : 'key <= ?');
      params.push(Buffer.from(upper));
    }
    return { sql: `${prefix} WHERE ${conditions.join(' AND ')}`, params };
  }

  /** Update auto-increment counter */
  updateCurrentKey(dbName: string, storeId: number, currentKey: number): void {
    const db = this.getDatabase(dbName);
    db.prepare('UPDATE object_stores SET current_key = ? WHERE id = ?').run(currentKey, storeId);
  }

  /** Begin a savepoint for a transaction */
  beginSavepoint(dbName: string, savepointName: string): void {
    const db = this.getDatabase(dbName);
    db.exec(`SAVEPOINT "${savepointName}"`);
  }

  /** Release (commit) a savepoint */
  releaseSavepoint(dbName: string, savepointName: string): void {
    const db = this.getDatabase(dbName);
    db.exec(`RELEASE SAVEPOINT "${savepointName}"`);
  }

  /** Rollback to a savepoint */
  rollbackSavepoint(dbName: string, savepointName: string): void {
    const db = this.getDatabase(dbName);
    db.exec(`ROLLBACK TO SAVEPOINT "${savepointName}"`);
    // Release after rollback to clean up the savepoint
    db.exec(`RELEASE SAVEPOINT "${savepointName}"`);
  }

  /** Create an index */
  createIndex(
    dbName: string,
    storeId: number,
    indexName: string,
    keyPath: string | string[],
    unique: boolean,
    multiEntry: boolean
  ): number {
    const db = this.getDatabase(dbName);
    const result = db
      .prepare(
        'INSERT INTO indexes (object_store_id, name, key_path, unique_index, multi_entry) VALUES (?, ?, ?, ?, ?)'
      )
      .run(storeId, indexName, JSON.stringify(keyPath), unique ? 1 : 0, multiEntry ? 1 : 0);
    return Number(result.lastInsertRowid);
  }

  /** Get index names for an object store */
  getIndexNames(dbName: string, storeId: number): string[] {
    const db = this.getDatabase(dbName);
    const rows = db
      .prepare('SELECT name FROM indexes WHERE object_store_id = ? ORDER BY name')
      .all(storeId) as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  /** Get index metadata */
  getIndexMetadata(
    dbName: string,
    storeId: number,
    indexName: string
  ): { id: number; keyPath: string | string[]; unique: boolean; multiEntry: boolean } | null {
    const db = this.getDatabase(dbName);
    const row = db
      .prepare(
        'SELECT id, key_path, unique_index, multi_entry FROM indexes WHERE object_store_id = ? AND name = ?'
      )
      .get(storeId, indexName) as
      | { id: number; key_path: string; unique_index: number; multi_entry: number }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      keyPath: JSON.parse(row.key_path),
      unique: row.unique_index !== 0,
      multiEntry: row.multi_entry !== 0,
    };
  }

  /** Delete an index */
  deleteIndex(dbName: string, storeId: number, indexName: string): void {
    const db = this.getDatabase(dbName);
    const idx = db
      .prepare('SELECT id FROM indexes WHERE object_store_id = ? AND name = ?')
      .get(storeId, indexName) as { id: number } | undefined;
    if (!idx) return;
    db.prepare('DELETE FROM index_entries WHERE index_id = ?').run(idx.id);
    db.prepare('DELETE FROM indexes WHERE id = ?').run(idx.id);
  }

  /** Get the first record via an index by exact key */
  getRecordByIndexKey(dbName: string, indexId: number, indexKey: Buffer | Uint8Array): { primaryKey: Buffer; value: Buffer } | null {
    const db = this.getDatabase(dbName);
    const storeIdRow = db.prepare('SELECT object_store_id FROM indexes WHERE id = ?').get(indexId) as { object_store_id: number } | undefined;
    if (!storeIdRow) return null;
    const row = db.prepare(
      'SELECT ie.primary_key, r.value FROM index_entries ie ' +
      'JOIN records r ON r.object_store_id = ? AND r.key = ie.primary_key ' +
      'WHERE ie.index_id = ? AND ie.key = ? ORDER BY ie.primary_key ASC LIMIT 1'
    ).get(storeIdRow.object_store_id, indexId, Buffer.from(indexKey)) as { primary_key: Buffer; value: Buffer } | undefined;
    return row ? { primaryKey: row.primary_key, value: row.value } : null;
  }

  /** Get the first record via an index within a key range */
  getRecordByIndexRange(dbName: string, indexId: number, lower: Buffer | Uint8Array | null, upper: Buffer | Uint8Array | null, lowerOpen: boolean, upperOpen: boolean): { primaryKey: Buffer; value: Buffer; indexKey: Buffer } | null {
    const db = this.getDatabase(dbName);
    const storeIdRow = db.prepare('SELECT object_store_id FROM indexes WHERE id = ?').get(indexId) as { object_store_id: number } | undefined;
    if (!storeIdRow) return null;
    const conditions: string[] = ['ie.index_id = ?'];
    const params: any[] = [storeIdRow.object_store_id, indexId];
    if (lower !== null) {
      conditions.push(lowerOpen ? 'ie.key > ?' : 'ie.key >= ?');
      params.push(Buffer.from(lower));
    }
    if (upper !== null) {
      conditions.push(upperOpen ? 'ie.key < ?' : 'ie.key <= ?');
      params.push(Buffer.from(upper));
    }
    const sql = 'SELECT ie.key as idx_key, ie.primary_key, r.value FROM index_entries ie ' +
      'JOIN records r ON r.object_store_id = ? AND r.key = ie.primary_key ' +
      'WHERE ' + conditions.join(' AND ') + ' ORDER BY ie.key ASC, ie.primary_key ASC LIMIT 1';
    const row = db.prepare(sql).get(...params) as { idx_key: Buffer; primary_key: Buffer; value: Buffer } | undefined;
    return row ? { primaryKey: row.primary_key, value: row.value, indexKey: row.idx_key } : null;
  }

  /** Count index entries, optionally within a range */
  countIndexEntries(dbName: string, indexId: number, lower?: Buffer | Uint8Array | null, upper?: Buffer | Uint8Array | null, lowerOpen?: boolean, upperOpen?: boolean): number {
    const db = this.getDatabase(dbName);
    if (lower === undefined && upper === undefined) {
      const row = db.prepare(
        'SELECT COUNT(*) as cnt FROM index_entries WHERE index_id = ?'
      ).get(indexId) as { cnt: number };
      return row.cnt;
    }
    const conditions: string[] = ['index_id = ?'];
    const params: any[] = [indexId];
    if (lower !== null && lower !== undefined) {
      conditions.push(lowerOpen ? 'key > ?' : 'key >= ?');
      params.push(Buffer.from(lower));
    }
    if (upper !== null && upper !== undefined) {
      conditions.push(upperOpen ? 'key < ?' : 'key <= ?');
      params.push(Buffer.from(upper));
    }
    const sql = 'SELECT COUNT(*) as cnt FROM index_entries WHERE ' + conditions.join(' AND ');
    const row = db.prepare(sql).get(...params) as { cnt: number };
    return row.cnt;
  }

  /** Add an index entry */
  addIndexEntry(dbName: string, indexId: number, key: Buffer | Uint8Array, primaryKey: Buffer | Uint8Array): void {
    const db = this.getDatabase(dbName);
    db.prepare(
      'INSERT OR REPLACE INTO index_entries (index_id, key, primary_key) VALUES (?, ?, ?)'
    ).run(indexId, Buffer.from(key), Buffer.from(primaryKey));
  }

  /** Get records from an object store for cursor iteration */
  getRecordsForCursor(
    dbName: string,
    storeId: number,
    lower: Buffer | Uint8Array | null,
    upper: Buffer | Uint8Array | null,
    lowerOpen: boolean,
    upperOpen: boolean,
    direction: 'next' | 'prev' | 'nextunique' | 'prevunique'
  ): Array<{ key: Buffer; value: Buffer }> {
    const db = this.getDatabase(dbName);
    const { sql, params } = this._buildRangeQuery(
      'SELECT key, value FROM records',
      storeId, lower, upper, lowerOpen, upperOpen
    );
    const order = (direction === 'prev' || direction === 'prevunique') ? 'DESC' : 'ASC';
    return db.prepare(sql + ` ORDER BY key ${order}`).all(...params) as Array<{ key: Buffer; value: Buffer }>;
  }

  /** Get index entries for cursor iteration */
  getIndexEntriesForCursor(
    dbName: string,
    indexId: number,
    storeId: number,
    lower: Buffer | Uint8Array | null,
    upper: Buffer | Uint8Array | null,
    lowerOpen: boolean,
    upperOpen: boolean,
    direction: 'next' | 'prev' | 'nextunique' | 'prevunique'
  ): Array<{ index_key: Buffer; primary_key: Buffer; value: Buffer }> {
    const db = this.getDatabase(dbName);
    const conditions: string[] = ['ie.index_id = ?'];
    const params: any[] = [storeId, indexId];
    if (lower !== null) {
      conditions.push(lowerOpen ? 'ie.key > ?' : 'ie.key >= ?');
      params.push(Buffer.from(lower));
    }
    if (upper !== null) {
      conditions.push(upperOpen ? 'ie.key < ?' : 'ie.key <= ?');
      params.push(Buffer.from(upper));
    }
    let order: string;
    if (direction === 'prev') {
      order = 'ie.key DESC, ie.primary_key DESC';
    } else if (direction === 'prevunique') {
      order = 'ie.key DESC, ie.primary_key ASC';
    } else {
      order = 'ie.key ASC, ie.primary_key ASC';
    }
    const sql = 'SELECT ie.key as index_key, ie.primary_key, r.value FROM index_entries ie ' +
      'JOIN records r ON r.object_store_id = ? AND r.key = ie.primary_key ' +
      'WHERE ' + conditions.join(' AND ') + ` ORDER BY ${order}`;
    return db.prepare(sql).all(...params) as Array<{ index_key: Buffer; primary_key: Buffer; value: Buffer }>;
  }

  /** Get a single record by exact primary key (returns key + value) */
  getRecordWithKey(dbName: string, storeId: number, key: Buffer | Uint8Array): { key: Buffer; value: Buffer } | null {
    const db = this.getDatabase(dbName);
    const row = db
      .prepare('SELECT key, value FROM records WHERE object_store_id = ? AND key = ?')
      .get(storeId, Buffer.from(key)) as { key: Buffer; value: Buffer } | undefined;
    return row ?? null;
  }

  /** Get all records from an object store within a range, with optional count limit */
  getAllRecords(
    dbName: string,
    storeId: number,
    lower: Buffer | Uint8Array | null,
    upper: Buffer | Uint8Array | null,
    lowerOpen: boolean,
    upperOpen: boolean,
    direction: 'next' | 'prev' | 'nextunique' | 'prevunique',
    maxCount?: number
  ): Array<{ key: Buffer; value: Buffer }> {
    const db = this.getDatabase(dbName);
    const { sql, params } = this._buildRangeQuery(
      'SELECT key, value FROM records',
      storeId, lower, upper, lowerOpen, upperOpen
    );
    const order = (direction === 'prev' || direction === 'prevunique') ? 'DESC' : 'ASC';
    let fullSql = sql + ` ORDER BY key ${order}`;
    if (maxCount !== undefined && maxCount > 0) {
      fullSql += ` LIMIT ${maxCount}`;
    }
    return db.prepare(fullSql).all(...params) as Array<{ key: Buffer; value: Buffer }>;
  }

  /** Get all index entries within a range, with optional count limit */
  getAllIndexEntries(
    dbName: string,
    indexId: number,
    storeId: number,
    lower: Buffer | Uint8Array | null,
    upper: Buffer | Uint8Array | null,
    lowerOpen: boolean,
    upperOpen: boolean,
    direction: 'next' | 'prev' | 'nextunique' | 'prevunique',
    maxCount?: number
  ): Array<{ index_key: Buffer; primary_key: Buffer; value: Buffer }> {
    const db = this.getDatabase(dbName);
    const conditions: string[] = ['ie.index_id = ?'];
    const params: any[] = [storeId, indexId];
    if (lower !== null) {
      conditions.push(lowerOpen ? 'ie.key > ?' : 'ie.key >= ?');
      params.push(Buffer.from(lower));
    }
    if (upper !== null) {
      conditions.push(upperOpen ? 'ie.key < ?' : 'ie.key <= ?');
      params.push(Buffer.from(upper));
    }
    let order: string;
    if (direction === 'prev') {
      order = 'ie.key DESC, ie.primary_key DESC';
    } else if (direction === 'prevunique') {
      order = 'ie.key DESC, ie.primary_key ASC';
    } else {
      order = 'ie.key ASC, ie.primary_key ASC';
    }
    let sql = 'SELECT ie.key as index_key, ie.primary_key, r.value FROM index_entries ie ' +
      'JOIN records r ON r.object_store_id = ? AND r.key = ie.primary_key ' +
      'WHERE ' + conditions.join(' AND ') + ` ORDER BY ${order}`;
    if (maxCount !== undefined && maxCount > 0) {
      // For unique directions, we can't just LIMIT since we need to deduplicate first
      // So we fetch all and let the caller handle dedup + limit
      if (direction !== 'nextunique' && direction !== 'prevunique') {
        sql += ` LIMIT ${maxCount}`;
      }
    }
    return db.prepare(sql).all(...params) as Array<{ index_key: Buffer; primary_key: Buffer; value: Buffer }>;
  }

  /** Rename an object store */
  renameObjectStore(dbName: string, oldName: string, newName: string): void {
    const db = this.getDatabase(dbName);
    db.prepare('UPDATE object_stores SET name = ? WHERE name = ?').run(newName, oldName);
  }

  /** Rename an index */
  renameIndex(dbName: string, storeId: number, oldName: string, newName: string): void {
    const db = this.getDatabase(dbName);
    db.prepare('UPDATE indexes SET name = ? WHERE object_store_id = ? AND name = ?').run(newName, storeId, oldName);
  }

  /** Close all connections */
  closeAll(): void {
    for (const [name, db] of this._openDbs) {
      db.close();
    }
    this._openDbs.clear();
    this._metaDb.close();
  }

  private _fileNameForDb(name: string): string {
    // Sanitize database name for filesystem
    const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_');
    return `db_${safe}.sqlite`;
  }
}
