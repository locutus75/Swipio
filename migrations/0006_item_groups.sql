-- Optional product group per item, e.g. "Dopper". Items in the same group count as one product
-- when allocating, so nobody gets more than one of them, even if their names differ.
ALTER TABLE items ADD COLUMN product_group TEXT;
