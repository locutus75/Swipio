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

test('0003_collection_editors applies on top of 0002', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  for (const f of ['0001_init.sql', '0002_roles.sql', '0003_collection_editors.sql']) db.exec(sql(f));
  db.exec(`
    INSERT INTO users (id, name, email, created_at) VALUES (1, 'Cas', 'cas@x', 0);
    INSERT INTO collections (id, name, expires_at, created_at) VALUES (1, 'C', 0, 0);
    INSERT INTO collection_editors VALUES (1, 1);
    DELETE FROM collections WHERE id = 1;
  `);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM collection_editors').get().n, 0, 'cascades with the collection');
});
