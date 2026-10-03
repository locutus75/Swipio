// Minimal in-memory stand-in for a Cloudflare D1 binding, built on node:sqlite, so the Worker
// can be tested in plain Node. Only the parts of the D1 API that Swipio uses are implemented.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS = path.join(import.meta.dirname, '..', 'migrations');

const toSqlite = (v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : typeof v === 'boolean' ? Number(v) : v);
const plain = (row) => (row ? { ...row } : null);

class Statement {
  constructor(db, sql, args = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }
  bind(...args) {
    if (args.some((a) => a === undefined)) throw new Error('D1_TYPE_ERROR: undefined is not a supported type');
    return new Statement(this.db, this.sql, args);
  }
  get #stmt() {
    return this.db.prepare(this.sql);
  }
  get #params() {
    return this.args.map(toSqlite);
  }
  async first(column) {
    const row = plain(this.#stmt.get(...this.#params));
    return row && column ? row[column] : row;
  }
  async all() {
    return { success: true, meta: {}, results: this.#stmt.all(...this.#params).map(plain) };
  }
  async run() {
    return this.runSync();
  }
  runSync() {
    if (/^\s*select\b|\breturning\b/i.test(this.sql)) {
      return { success: true, meta: {}, results: this.#stmt.all(...this.#params).map(plain) };
    }
    const r = this.#stmt.run(...this.#params);
    return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}

export function createD1() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;'); // D1 enforces foreign keys too
  for (const file of fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(fs.readFileSync(path.join(MIGRATIONS, file), 'utf8'));
  }
  return {
    prepare: (sql) => new Statement(db, sql),
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const results = statements.map((s) => s.runSync());
        db.exec('COMMIT');
        return results;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
}
