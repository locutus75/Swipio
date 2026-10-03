'use strict';

const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id                INTEGER PRIMARY KEY,
  name              TEXT NOT NULL,
  email             TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role              TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  password_hash     TEXT,
  invite_token      TEXT UNIQUE,
  invite_expires_at INTEGER,
  created_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS collections (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  expires_at   INTEGER NOT NULL,
  published    INTEGER NOT NULL DEFAULT 0,
  finalized_at INTEGER,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id            INTEGER PRIMARY KEY,
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  image         TEXT,
  quantity      INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS items_collection ON items(collection_id);

CREATE TABLE IF NOT EXISTS collection_members (
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (collection_id, user_id)
);

CREATE TABLE IF NOT EXISTS swipes (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  liked      INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, item_id)
);

CREATE TABLE IF NOT EXISTS allocations (
  id           INTEGER PRIMARY KEY,
  item_id      INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  collected_at INTEGER,
  UNIQUE (item_id, user_id)
);
`;

function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

/** Runs fn inside a transaction, rolling back if it throws. */
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { openDb, tx };
