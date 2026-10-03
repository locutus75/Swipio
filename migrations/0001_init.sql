-- Swipio schema (Cloudflare D1 / SQLite). Times are milliseconds since the epoch.

CREATE TABLE users (
  id                INTEGER PRIMARY KEY,
  name              TEXT NOT NULL,
  email             TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role              TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  password_hash     TEXT,
  invite_token      TEXT UNIQUE,
  invite_expires_at INTEGER,
  created_at        INTEGER NOT NULL
);

-- token_hash is the SHA-256 of the bearer token, so a database leak doesn't leak sessions.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE collections (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  expires_at   INTEGER NOT NULL,
  published    INTEGER NOT NULL DEFAULT 0,
  finalized_at INTEGER,
  created_at   INTEGER NOT NULL
);

-- Uploaded photos, resized in the browser before upload so each is well under D1's 2 MB row limit.
CREATE TABLE images (
  id           INTEGER PRIMARY KEY,
  content_type TEXT NOT NULL,
  data         BLOB NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE TABLE items (
  id            INTEGER PRIMARY KEY,
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  image_id      INTEGER REFERENCES images(id) ON DELETE SET NULL,
  image_url     TEXT,
  quantity      INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  created_at    INTEGER NOT NULL
);
CREATE INDEX items_collection ON items(collection_id);

CREATE TABLE collection_members (
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (collection_id, user_id)
);

CREATE TABLE swipes (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  liked      INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, item_id)
);
CREATE INDEX swipes_item ON swipes(item_id);

CREATE TABLE allocations (
  id           INTEGER PRIMARY KEY,
  item_id      INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  collected_at INTEGER,
  UNIQUE (item_id, user_id)
);
