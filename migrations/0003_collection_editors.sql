-- Creators who may manage a collection someone else made. Granted by managers and admins
-- (who can already manage every collection). Editors can do everything the creator can,
-- except delete the collection.
CREATE TABLE collection_editors (
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (collection_id, user_id)
);
CREATE INDEX collection_editors_user ON collection_editors(user_id);
