-- How often an admin has redone a collection's allocation. It is part of the random seed, so a
-- redo gives a fresh draw instead of repeating the same result.
ALTER TABLE collections ADD COLUMN allocation_round INTEGER NOT NULL DEFAULT 0;
