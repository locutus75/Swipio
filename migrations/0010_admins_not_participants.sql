-- Admins run the platform; they never take part in collections themselves.
DELETE FROM collection_editors WHERE user_id IN (SELECT id FROM users WHERE access_role = 'admin');
DELETE FROM collection_members WHERE user_id IN (SELECT id FROM users WHERE access_role = 'admin');
