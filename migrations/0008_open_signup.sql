-- Open sign-up: everyone can create collections and invite people; a collection is visible only
-- to its owner, its co-managers and the people invited to it. Admins manage the platform.
--
-- The Participant and Manager roles go away: everyone who isn't an admin becomes a regular
-- user ('creator'), who manages the collections they make.
UPDATE users SET access_role = 'creator' WHERE access_role IN ('participant', 'manager');

-- Who invited someone (to show the invite link to the right person, and for privacy:
-- people only see users they invited or share a collection with).
ALTER TABLE users ADD COLUMN invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- Admins can block an account; blocked users can't log in.
ALTER TABLE users ADD COLUMN blocked_at INTEGER;
