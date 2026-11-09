-- Everyone who was invited to a collection, whether or not they are ticked as a participant
-- right now. Only these people show up (and can be ticked) on the collection's People tab.
CREATE TABLE collection_people (
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (collection_id, user_id)
);
CREATE INDEX collection_people_user ON collection_people(user_id);

-- Backfill: current participants, plus anyone who swiped on or was given an item in it.
INSERT OR IGNORE INTO collection_people (collection_id, user_id)
  SELECT collection_id, user_id FROM collection_members;
INSERT OR IGNORE INTO collection_people (collection_id, user_id)
  SELECT i.collection_id, s.user_id FROM swipes s JOIN items i ON i.id = s.item_id;
INSERT OR IGNORE INTO collection_people (collection_id, user_id)
  SELECT i.collection_id, a.user_id FROM allocations a JOIN items i ON i.id = a.item_id;
DELETE FROM collection_people WHERE user_id IN (SELECT id FROM users WHERE access_role = 'admin');
