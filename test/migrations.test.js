import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const sql = (name) => fs.readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8');

test('0002_roles upgrades an existing database without losing data', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(sql('0001_init.sql'));
  db.exec(`
    INSERT INTO users (id, name, email, role, created_at) VALUES (1, 'Ada', 'ada@x', 'admin', 0), (2, 'Bob', 'bob@x', 'user', 0);
    INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ('t', 2, 9999999999999);
    INSERT INTO collections (id, name, expires_at, created_at) VALUES (1, 'Old', 0, 0);
    INSERT INTO items (id, collection_id, title, created_at) VALUES (1, 1, 'Lamp', 0);
    INSERT INTO collection_members VALUES (1, 2);
    INSERT INTO swipes VALUES (2, 1, 1, 0);
  `);
  db.exec(sql('0002_roles.sql'));

  assert.deepEqual(
    db.prepare('SELECT id, access_role FROM users ORDER BY id').all().map((r) => ({ ...r })),
    [{ id: 1, access_role: 'admin' }, { id: 2, access_role: 'participant' }]
  );
  assert.equal(db.prepare('SELECT created_by FROM collections').get().created_by, 1);
  for (const table of ['sessions', 'collection_members', 'swipes']) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 1, table);
  }
  assert.throws(() => db.exec("UPDATE users SET access_role = 'king' WHERE id = 2"), /CHECK/);
});

test('later migrations apply on top of 0002', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  for (const f of ['0001_init.sql', '0002_roles.sql', '0003_collection_editors.sql', '0004_allocation_round.sql', '0005_allocation_exclusions.sql', '0006_item_groups.sql', '0007_allocation_versions.sql', '0008_open_signup.sql', '0009_editor_can_like.sql', '0010_admins_not_participants.sql']) db.exec(sql(f));
  db.exec(`
    INSERT INTO users (id, name, email, created_at) VALUES (1, 'Cas', 'cas@x', 0);
    INSERT INTO collections (id, name, expires_at, created_at) VALUES (1, 'C', 0, 0);
    INSERT INTO collection_editors (collection_id, user_id) VALUES (1, 1);
    DELETE FROM collections WHERE id = 1;
  `);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM collection_editors').get().n, 0, 'cascades with the collection');
});

test('0008_open_signup turns participants and managers into regular users', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  for (const f of fs.readdirSync(new URL('../migrations/', import.meta.url)).sort()) {
    if (f >= '0008') continue;
    db.exec(sql(f));
  }
  db.exec(`INSERT INTO users (id, name, email, access_role, created_at) VALUES
    (1, 'Ada', 'ada@x', 'admin', 0), (2, 'Max', 'max@x', 'manager', 0), (3, 'Cas', 'cas@x', 'creator', 0), (4, 'Pim', 'pim@x', 'participant', 0);`);
  db.exec(sql('0008_open_signup.sql'));
  assert.deepEqual(
    db.prepare('SELECT access_role FROM users ORDER BY id').all().map((r) => r.access_role),
    ['admin', 'creator', 'creator', 'creator']
  );
  db.exec('UPDATE users SET invited_by = 1, blocked_at = 5 WHERE id = 4; DELETE FROM users WHERE id = 1;');
  assert.equal(db.prepare('SELECT invited_by FROM users WHERE id = 4').get().invited_by, null, 'inviter deleted → SET NULL');
});
