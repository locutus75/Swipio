-- Saved copies of a collection's allocation. One is stored automatically before every admin
-- change (hand out again, take away, restore, import), so a previous version can be restored.
-- `data` is the same JSON as an exported allocation file.
CREATE TABLE allocation_versions (
  id            INTEGER PRIMARY KEY,
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,
  data          TEXT NOT NULL,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX allocation_versions_collection ON allocation_versions(collection_id, created_at);
