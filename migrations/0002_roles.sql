-- Four roles: participant < creator < manager < admin. Each role can do everything below it.
--
-- users.role has a CHECK that only allows 'admin'/'user', and SQLite can't change a CHECK
-- without rebuilding the table (which would cascade-delete sessions, swipes, etc.). So the
-- role now lives in a new column; the old one is kept in sync for 'admin' but no longer read.
ALTER TABLE users ADD COLUMN access_role TEXT NOT NULL DEFAULT 'participant'
  CHECK (access_role IN ('participant', 'creator', 'manager', 'admin'));
UPDATE users SET access_role = 'admin' WHERE role = 'admin';

-- Creators see and manage only the collections they created; managers and admins see all.
ALTER TABLE collections ADD COLUMN created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
UPDATE collections SET created_by = (SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1);
CREATE INDEX collections_created_by ON collections(created_by);
