-- Per co-manager: may they also like (swipe) items in the collection? 0 = only manage it:
-- they don't see it in their swipe list and their likes don't count in the allocation.
ALTER TABLE collection_editors ADD COLUMN can_like INTEGER NOT NULL DEFAULT 1;
