-- Subscription plans with limits. Admins set the limits; empty (NULL) means no limit.
-- Limits apply to collections made by non-admins, based on the plan of the person who made it.
CREATE TABLE plans (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  position          INTEGER NOT NULL,
  max_people        INTEGER, -- people on a collection's People list (excluding its maker)
  max_items         INTEGER, -- items in one collection
  max_photo_kb      INTEGER, -- size of one photo (the app never accepts more than 1536 KB)
  max_swipe_days    INTEGER, -- how far ahead the swipe deadline may be set
  delete_after_days INTEGER  -- closed collections are deleted this many days after closing
);
INSERT INTO plans (id, name, position) VALUES ('free', 'Free', 0), ('plus', 'Plus', 1), ('max', 'Max', 2), ('ultra', 'Ultra', 3);

ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free';
