-- Items an admin took away from someone after the allocation. That person is skipped for that
-- item in any later (re)allocation, so the freed units go to others. Cleared when the
-- collection is re-opened.
CREATE TABLE allocation_exclusions (
  item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (item_id, user_id)
);
