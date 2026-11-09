// Swipio API: a Cloudflare Worker backed by a D1 (SQLite) database.
//
// Auth uses bearer tokens (Authorization: Bearer ...) rather than cookies, because the frontend
// lives on GitHub Pages and the API on workers.dev, two different sites.
//
// Roles: participant (swipes), creator (+ makes and runs their own collections), manager (+ sees
// every collection, who chose what, and manages users), admin (+ manages admins).
//
// Vars (see wrangler.toml): ALLOWED_ORIGINS, PASSWORD_ITERATIONS. Binding: DB (D1).

import { allocate, productKey } from './allocation.js';
import * as auth from './auth.js';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// participant < creator < manager < admin: each role can do everything the roles below it can.
export const ROLES = ['participant', 'creator', 'manager', 'admin'];
const rank = (role) => ROLES.indexOf(role);
const atLeast = (user, role) => rank(user.access_role) >= rank(role);

const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif'];

/** @param {{now?: () => number}} [opts] clock is injectable for tests */
export function createApi({ now = Date.now } = {}) {
  const routes = [];
  const route = (method, path, opts, handler) => {
    if (typeof opts === 'function') [handler, opts] = [opts, {}];
    const re = new RegExp('^' + path.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$');
    routes.push({ method, re, opts, handler });
  };

  // ---------- helpers ----------

  const first = (db, sql, ...args) => db.prepare(sql).bind(...args).first();
  const all = async (db, sql, ...args) => (await db.prepare(sql).bind(...args).all()).results;
  const run = (db, sql, ...args) => db.prepare(sql).bind(...args).run();

  // The draw is seeded so results are reproducible; an admin's redo bumps the round for a fresh draw.
  const seedFor = (c, round = c.allocation_round || 0) => (round ? `${c.id}:${c.expires_at}:${round}` : `${c.id}:${c.expires_at}`);

  /** Items and the likes of current members (minus items an admin took away): the input for an allocation. */
  async function allocationInput(db, collectionId) {
    // Same group (or, without one, the same name) = same product, so nobody gets two of it:
    // e.g. three separate "Dopper" items, or two different mugs both in the group "Dopper".
    const items = (
      await all(db, 'SELECT id, quantity, title, product_group FROM items WHERE collection_id = ?', collectionId)
    ).map((i) => ({
      id: i.id,
      quantity: i.quantity,
      group: productKey(i.product_group || i.title),
    }));
    const likes = await all(
      db,
      `SELECT s.item_id AS itemId, s.user_id AS userId
         FROM swipes s
         JOIN items i ON i.id = s.item_id
         JOIN collection_members m ON m.collection_id = i.collection_id AND m.user_id = s.user_id
        WHERE i.collection_id = ? AND s.liked = 1
          AND NOT EXISTS (SELECT 1 FROM allocation_exclusions x WHERE x.item_id = s.item_id AND x.user_id = s.user_id)
        ORDER BY s.created_at`,
      collectionId
    );
    return { items, likes };
  }

  async function finalizeCollection(db, collectionId) {
    const c = await first(db, 'SELECT * FROM collections WHERE id = ?', collectionId);
    if (!c || c.finalized_at !== null) return;
    const { items, likes } = await allocationInput(db, collectionId);
    // After a reopen, items that were already picked up are still allocated: they stay put.
    const fixed = await all(
      db,
      'SELECT a.item_id AS itemId, a.user_id AS userId FROM allocations a JOIN items i ON i.id = a.item_id WHERE i.collection_id = ?',
      collectionId
    );
    // D1 has no interactive transactions, but a batch is atomic. The result is deterministic
    // (seeded), so INSERT OR IGNORE makes a concurrent finalization of the same collection harmless.
    const insert = db.prepare('INSERT OR IGNORE INTO allocations (item_id, user_id) VALUES (?, ?)');
    await db.batch([
      ...allocate({ items, likes, seed: seedFor(c), fixed }).map((a) => insert.bind(a.itemId, a.userId)),
      db.prepare('UPDATE collections SET finalized_at = ? WHERE id = ? AND finalized_at IS NULL').bind(now(), collectionId),
    ]);
  }

  // ---------- allocation versions (export / import / restore) ----------

  const VERSION_FORMAT = 'swipio-allocation';
  const MAX_VERSIONS = 30;

  /** The current allocation of a collection as a self-describing object (also the export file). */
  async function allocationSnapshot(db, c) {
    const [allocations, takenAway] = await Promise.all([
      all(
        db,
        `SELECT a.item_id, a.user_id, a.collected_at, i.title AS item_title, u.name AS user_name, u.email AS user_email
           FROM allocations a JOIN items i ON i.id = a.item_id JOIN users u ON u.id = a.user_id
          WHERE i.collection_id = ? ORDER BY u.name COLLATE NOCASE, i.title COLLATE NOCASE`,
        c.id
      ),
      all(
        db,
        `SELECT x.item_id, x.user_id, i.title AS item_title, u.email AS user_email
           FROM allocation_exclusions x JOIN items i ON i.id = x.item_id JOIN users u ON u.id = x.user_id
          WHERE i.collection_id = ?`,
        c.id
      ),
    ]);
    return {
      format: VERSION_FORMAT,
      version: 1,
      collection: { id: c.id, name: c.name },
      savedAt: new Date(now()).toISOString(),
      round: c.allocation_round || 0,
      allocations: allocations.map((a) => ({
        itemId: a.item_id,
        itemTitle: a.item_title,
        userId: a.user_id,
        userName: a.user_name,
        userEmail: a.user_email,
        collectedAt: a.collected_at,
      })),
      takenAway: takenAway.map((x) => ({ itemId: x.item_id, itemTitle: x.item_title, userId: x.user_id, userEmail: x.user_email })),
    };
  }

  /** Stores the current allocation as a version (before an admin changes it); keeps the newest 30. */
  async function saveVersion(db, c, label, userId) {
    const snapshot = await allocationSnapshot(db, c);
    await db.batch([
      db
        .prepare('INSERT INTO allocation_versions (collection_id, label, data, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(c.id, label, JSON.stringify(snapshot), userId, now()),
      db
        .prepare(
          `DELETE FROM allocation_versions WHERE collection_id = ?1 AND id NOT IN
             (SELECT id FROM allocation_versions WHERE collection_id = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2)`
        )
        .bind(c.id, MAX_VERSIONS),
    ]);
  }

  /**
   * Replaces the collection's allocation with a saved one. Items and people are matched by id,
   * falling back to the item's name and the person's email (e.g. after an item was re-added).
   * Entries that can't be matched are skipped and reported.
   */
  async function applySnapshot(db, c, snapshot) {
    if (!snapshot || snapshot.format !== VERSION_FORMAT || !Array.isArray(snapshot.allocations)) {
      throw new HttpError(400, 'This is not a Swipio allocation file');
    }
    if (snapshot.collection && Number(snapshot.collection.id) !== c.id) {
      throw new HttpError(400, `This file belongs to another collection ("${snapshot.collection.name}")`);
    }
    const items = await all(db, 'SELECT id, title FROM items WHERE collection_id = ?', c.id);
    const users = await all(db, 'SELECT id, email FROM users');
    const itemIds = new Set(items.map((i) => i.id));
    const userIds = new Set(users.map((u) => u.id));
    const findItem = (e) => {
      if (itemIds.has(Number(e.itemId))) return Number(e.itemId);
      const byTitle = items.filter((i) => i.title === e.itemTitle);
      return byTitle.length === 1 ? byTitle[0].id : null;
    };
    const findUser = (e) => {
      if (userIds.has(Number(e.userId))) return Number(e.userId);
      const email = String(e.userEmail || '').toLowerCase();
      return users.find((u) => u.email.toLowerCase() === email)?.id ?? null;
    };

    const skipped = [];
    const rows = new Map();
    for (const e of snapshot.allocations) {
      const itemId = findItem(e);
      const userId = findUser(e);
      if (!itemId || !userId) {
        skipped.push({ itemTitle: e.itemTitle, userName: e.userName, reason: !itemId ? 'item no longer exists' : 'person no longer exists' });
        continue;
      }
      const collectedAt = Number.isFinite(Number(e.collectedAt)) && e.collectedAt !== null ? Number(e.collectedAt) : null;
      rows.set(`${itemId}:${userId}`, { itemId, userId, collectedAt });
    }
    const taken = new Map();
    for (const x of Array.isArray(snapshot.takenAway) ? snapshot.takenAway : []) {
      const itemId = findItem(x);
      const userId = findUser(x);
      if (itemId && userId) taken.set(`${itemId}:${userId}`, { itemId, userId });
    }

    const insert = db.prepare('INSERT OR IGNORE INTO allocations (item_id, user_id, collected_at) VALUES (?, ?, ?)');
    const exclude = db.prepare('INSERT OR IGNORE INTO allocation_exclusions (item_id, user_id, created_at) VALUES (?, ?, ?)');
    await db.batch([
      db.prepare('DELETE FROM allocations WHERE item_id IN (SELECT id FROM items WHERE collection_id = ?)').bind(c.id),
      db.prepare('DELETE FROM allocation_exclusions WHERE item_id IN (SELECT id FROM items WHERE collection_id = ?)').bind(c.id),
      ...[...rows.values()].map((r) => insert.bind(r.itemId, r.userId, r.collectedAt)),
      ...[...taken.values()].map((x) => exclude.bind(x.itemId, x.userId, now())),
    ]);
    return { restored: rows.size, skipped };
  }

  async function finalizeDue(db) {
    const due = await all(
      db,
      'SELECT id FROM collections WHERE published = 1 AND finalized_at IS NULL AND expires_at <= ?',
      now()
    );
    for (const { id } of due) await finalizeCollection(db, id);
  }

  const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.access_role });

  // The frontend turns inviteToken into a link, since only it knows its own address.
  function adminUser(u) {
    const pending = !u.password_hash;
    return {
      ...publicUser(u),
      status: pending ? 'invited' : 'active',
      inviteToken: pending ? u.invite_token : null,
      inviteExpiresAt: pending ? u.invite_expires_at : null,
      createdAt: u.created_at,
    };
  }

  async function startSession(db, userId) {
    const token = auth.randomToken();
    await run(
      db,
      'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
      await auth.sha256(token),
      userId,
      now() + auth.SESSION_TTL
    );
    return token;
  }

  function collectionState(c) {
    if (!c.published) return 'draft';
    if (c.finalized_at !== null || c.expires_at <= now()) return 'closed';
    return 'open';
  }

  const serializeCollection = (c) => ({
    id: c.id,
    name: c.name,
    description: c.description,
    expiresAt: c.expires_at,
    published: !!c.published,
    finalizedAt: c.finalized_at,
    state: collectionState(c),
  });

  const serializeItem = (i) => ({
    id: i.id,
    collectionId: i.collection_id,
    title: i.title,
    description: i.description,
    image: i.image_id ? `/api/images/${i.image_id}` : i.image_url || null,
    quantity: i.quantity,
    group: i.product_group || null,
  });

  function str(value, field, { required = false, max = 2000 } = {}) {
    if (value === undefined || value === null) {
      if (required) throw new HttpError(400, `${field} is required`);
      return undefined;
    }
    const s = String(value).trim();
    if (required && !s) throw new HttpError(400, `${field} is required`);
    if (s.length > max) throw new HttpError(400, `${field} is too long`);
    return s;
  }

  function timestamp(value, field) {
    if (value === undefined) return undefined;
    const t = typeof value === 'number' ? value : Date.parse(value);
    if (!Number.isFinite(t)) throw new HttpError(400, `${field} must be a valid date`);
    return Math.round(t);
  }

  function quantity(value) {
    if (value === undefined || value === null || value === '') return undefined;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 10000) {
      throw new HttpError(400, 'quantity must be a whole number of at least 1');
    }
    return n;
  }

  function imageUrl(value) {
    const s = str(value, 'imageUrl', { max: 2000 });
    if (!s) return null;
    if (!/^https?:\/\//i.test(s)) throw new HttpError(400, 'imageUrl must start with http(s)://');
    return s;
  }

  async function password(value, env) {
    const p = String(value || '');
    if (p.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
    const iterations = Math.min(100_000, Math.max(10_000, Number(env.PASSWORD_ITERATIONS) || 100_000));
    return auth.hashPassword(p, iterations);
  }

  async function getCollection(db, id) {
    const c = await first(db, 'SELECT * FROM collections WHERE id = ?', Number(id));
    if (!c) throw new HttpError(404, 'Collection not found');
    return c;
  }

  async function getItem(db, id) {
    const i = await first(db, 'SELECT * FROM items WHERE id = ?', Number(id));
    if (!i) throw new HttpError(404, 'Item not found');
    return i;
  }

  async function getUser(db, id) {
    const u = await first(db, 'SELECT * FROM users WHERE id = ?', Number(id));
    if (!u) throw new HttpError(404, 'User not found');
    return u;
  }

  /** Returns the collection if the current user may participate in it. */
  async function memberCollection(ctx, collectionId) {
    const c = await getCollection(ctx.db, collectionId);
    const member = await first(
      ctx.db,
      'SELECT 1 AS ok FROM collection_members WHERE collection_id = ? AND user_id = ?',
      c.id,
      ctx.user.id
    );
    if (!member || !c.published) throw new HttpError(404, 'Collection not found');
    return c;
  }

  /**
   * Returns the collection if the current user may manage it: managers and admins all of them,
   * creators the ones they made or were made an editor of. Deleting is for the maker and managers+.
   */
  async function managedCollection(ctx, id, { toDelete = false } = {}) {
    const c = await getCollection(ctx.db, id);
    if (atLeast(ctx.user, 'manager') || c.created_by === ctx.user.id) return c;
    const editor = await first(
      ctx.db,
      'SELECT 1 AS ok FROM collection_editors WHERE collection_id = ? AND user_id = ?',
      c.id,
      ctx.user.id
    );
    if (!editor) throw new HttpError(404, 'Collection not found');
    if (toDelete) throw new HttpError(403, 'Only the person who made this collection or a manager can delete it');
    return c;
  }

  async function managedItem(ctx, id) {
    const item = await getItem(ctx.db, id);
    await managedCollection(ctx, item.collection_id);
    return item;
  }

  /** Reopening a closed collection is for admins and the person who made it. */
  const canReopen = (user, c) => atLeast(user, 'admin') || c.created_by === user.id;

  /**
   * Statements that reopen a closed collection: the allocation is set aside (a version is saved
   * first), except items already picked up, which stay with their person and count at the next close.
   */
  async function reopenStatements(ctx, c) {
    if (!canReopen(ctx.user, c)) {
      throw new HttpError(403, 'Only an admin or the person who made this collection can reopen it');
    }
    await saveVersion(ctx.db, c, 'Before reopening', ctx.user.id);
    return [
      ctx.db.prepare('DELETE FROM allocations WHERE collected_at IS NULL AND item_id IN (SELECT id FROM items WHERE collection_id = ?)').bind(c.id),
      ctx.db.prepare('DELETE FROM allocation_exclusions WHERE item_id IN (SELECT id FROM items WHERE collection_id = ?)').bind(c.id),
    ];
  }

  function parseRole(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    if (value === 'user') return 'participant'; // older clients
    if (!ROLES.includes(value)) throw new HttpError(400, `role must be one of: ${ROLES.join(', ')}`);
    return value;
  }

  /** Users can only manage people with a role up to their own, and only hand out roles up to their own. */
  function assertCanManage(ctx, target, newRole = target.access_role) {
    if (rank(target.access_role) > rank(ctx.user.access_role) || rank(newRole) > rank(ctx.user.access_role)) {
      throw new HttpError(403, 'You cannot manage users with a higher role than your own');
    }
  }

  /** Reads a JSON or multipart body into a plain object (files stay File objects). */
  async function readBody(req) {
    const type = req.headers.get('Content-Type') || '';
    if (type.includes('multipart/form-data')) {
      const form = await req.formData();
      return Object.fromEntries(form.entries());
    }
    if (!type.includes('application/json')) return {};
    const text = await req.text();
    if (!text.trim()) return {}; // a JSON header with an empty body just means "no options"
    try {
      return JSON.parse(text) || {};
    } catch {
      throw new HttpError(400, 'Invalid JSON');
    }
  }

  /** Stores an uploaded image and returns its id, or null when no file was sent. */
  async function storeImage(db, file) {
    if (!file || typeof file === 'string' || !file.size) return null;
    if (!IMAGE_TYPES.includes(file.type)) throw new HttpError(400, 'Only JPEG, PNG, GIF, WebP or AVIF images are allowed');
    if (file.size > MAX_IMAGE_BYTES) throw new HttpError(413, 'Image is too large (max 1.5 MB)');
    const row = await first(
      db,
      'INSERT INTO images (content_type, data, created_at) VALUES (?, ?, ?) RETURNING id',
      file.type,
      await file.arrayBuffer(),
      now()
    );
    return row.id;
  }

  const deleteImage = (db, id) => (id ? run(db, 'DELETE FROM images WHERE id = ?', id) : null);

  // ---------- setup & auth ----------

  route('GET', '/api/health', () => ({ ok: true }));

  route('GET', '/api/setup', async ({ db }) => {
    const admin = await first(db, "SELECT 1 AS ok FROM users WHERE access_role = 'admin' LIMIT 1");
    return { needsSetup: !admin };
  });

  route('POST', '/api/setup', async ({ db, body, env }) => {
    const name = str(body.name, 'name', { required: true, max: 100 });
    const email = str(body.email, 'email', { required: true, max: 200 }).toLowerCase();
    const hash = await password(body.password, env);
    // The WHERE NOT EXISTS makes "only one first admin" safe against concurrent requests.
    const user = await first(
      db,
      `INSERT INTO users (name, email, role, access_role, password_hash, created_at)
       SELECT ?, ?, 'admin', 'admin', ?, ? WHERE NOT EXISTS (SELECT 1 FROM users WHERE access_role = 'admin')
       RETURNING *`,
      name,
      email,
      hash,
      now()
    );
    if (!user) throw new HttpError(409, 'Setup has already been completed');
    return [201, { user: publicUser(user), token: await startSession(db, user.id) }];
  });

  route('POST', '/api/login', async ({ db, body }) => {
    const user = await first(db, 'SELECT * FROM users WHERE email = ?', String(body.email || '').trim());
    if (!user || !(await auth.verifyPassword(String(body.password || ''), user.password_hash))) {
      throw new HttpError(401, 'Invalid email or password');
    }
    return { user: publicUser(user), token: await startSession(db, user.id) };
  });

  route('POST', '/api/logout', async ({ db, tokenHash }) => {
    if (tokenHash) await run(db, 'DELETE FROM sessions WHERE token_hash = ?', tokenHash);
    return { ok: true };
  });

  route('GET', '/api/me', { auth: true }, ({ user }) => ({ user: publicUser(user) }));

  async function findInvite(db, token) {
    const user = await first(db, 'SELECT * FROM users WHERE invite_token = ?', String(token));
    if (!user || user.password_hash || user.invite_expires_at < now()) {
      throw new HttpError(404, 'This invite link is invalid or has expired');
    }
    return user;
  }

  route('GET', '/api/invites/:token', async ({ db, params }) => {
    const user = await findInvite(db, params.token);
    return { name: user.name, email: user.email };
  });

  route('POST', '/api/invites/:token', async ({ db, params, body, env }) => {
    const user = await findInvite(db, params.token);
    const name = str(body.name, 'name', { max: 100 }) || user.name;
    const hash = await password(body.password, env);
    const r = await run(
      db,
      `UPDATE users SET name = ?, password_hash = ?, invite_token = NULL, invite_expires_at = NULL
        WHERE id = ? AND invite_token = ?`,
      name,
      hash,
      user.id,
      params.token
    );
    if (!r.meta.changes) throw new HttpError(404, 'This invite link is invalid or has expired');
    return { user: publicUser({ ...user, name }), token: await startSession(db, user.id) };
  });

  // ---------- images ----------

  route('GET', '/api/images/:id', async ({ db, params }) => {
    const img = await first(db, 'SELECT content_type, data FROM images WHERE id = ?', Number(params.id));
    if (!img) throw new HttpError(404, 'Image not found');
    return new Response(new Uint8Array(img.data), {
      headers: { 'Content-Type': img.content_type, 'Cache-Control': 'public, max-age=31536000, immutable' },
    });
  });

  // ---------- participant API ----------

  route('GET', '/api/collections', { auth: true }, async ({ db, user }) => {
    const rows = await all(
      db,
      `SELECT c.*,
              (SELECT COUNT(*) FROM items i WHERE i.collection_id = c.id) AS item_count,
              (SELECT COUNT(*) FROM swipes s JOIN items i ON i.id = s.item_id
                WHERE i.collection_id = c.id AND s.user_id = ?1) AS swiped_count,
              (SELECT COUNT(*) FROM swipes s JOIN items i ON i.id = s.item_id
                WHERE i.collection_id = c.id AND s.user_id = ?1 AND s.liked = 1) AS liked_count,
              (SELECT COUNT(*) FROM allocations a JOIN items i ON i.id = a.item_id
                WHERE i.collection_id = c.id AND a.user_id = ?1) AS won_count
         FROM collections c
         JOIN collection_members m ON m.collection_id = c.id AND m.user_id = ?1
        WHERE c.published = 1
        ORDER BY c.finalized_at IS NOT NULL, c.expires_at`,
      user.id
    );
    return {
      collections: rows.map((c) => ({
        ...serializeCollection(c),
        itemCount: c.item_count,
        swipedCount: c.swiped_count,
        likedCount: c.liked_count,
        wonCount: c.won_count,
      })),
    };
  });

  route('GET', '/api/collections/:id', { auth: true }, async (ctx) => {
    const c = await memberCollection(ctx, ctx.params.id);
    const items = await all(
      ctx.db,
      `SELECT i.*, s.liked AS liked, a.id AS allocation_id, a.collected_at AS collected_at,
              (SELECT COUNT(*) FROM allocations p WHERE p.item_id = i.id AND p.collected_at IS NOT NULL) AS picked_up
         FROM items i
         LEFT JOIN swipes s ON s.item_id = i.id AND s.user_id = ?1
         LEFT JOIN allocations a ON a.item_id = i.id AND a.user_id = ?1
        WHERE i.collection_id = ?2
        ORDER BY i.id`,
      ctx.user.id,
      c.id
    );
    return {
      collection: serializeCollection(c),
      items: items.map((i) => ({
        ...serializeItem(i),
        swipe: i.liked === null ? null : i.liked ? 'like' : 'pass',
        won: i.allocation_id !== null,
        collected: i.collected_at !== null,
        // Units left to hand out; 0 means everything was already picked up (after a reopen).
        available: Math.max(0, i.quantity - i.picked_up),
      })),
    };
  });

  async function swipeableItem(ctx) {
    const item = await getItem(ctx.db, ctx.params.id);
    const c = await memberCollection(ctx, item.collection_id);
    if (collectionState(c) !== 'open') throw new HttpError(409, 'This collection has closed');
    return item;
  }

  route('PUT', '/api/items/:id/swipe', { auth: true }, async (ctx) => {
    const item = await swipeableItem(ctx);
    if (typeof ctx.body.liked !== 'boolean') throw new HttpError(400, 'liked must be true or false');
    await run(
      ctx.db,
      `INSERT INTO swipes (user_id, item_id, liked, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, item_id) DO UPDATE SET liked = excluded.liked, created_at = excluded.created_at`,
      ctx.user.id,
      item.id,
      ctx.body.liked ? 1 : 0,
      now()
    );
    return { ok: true };
  });

  route('DELETE', '/api/items/:id/swipe', { auth: true }, async (ctx) => {
    const item = await swipeableItem(ctx);
    await run(ctx.db, 'DELETE FROM swipes WHERE user_id = ? AND item_id = ?', ctx.user.id, item.id);
    return { ok: true };
  });

  // ---------- admin: users ----------

  // Creators get the list too (to pick participants), but without invite links.
  route('GET', '/api/admin/users', { role: 'creator' }, async (ctx) => {
    const users = await all(ctx.db, 'SELECT * FROM users ORDER BY name COLLATE NOCASE');
    const full = atLeast(ctx.user, 'manager');
    return {
      users: users.map((u) => {
        const out = adminUser(u);
        return full ? out : { ...out, inviteToken: null, inviteExpiresAt: null };
      }),
    };
  });

  route('POST', '/api/admin/users', { role: 'manager' }, async (ctx) => {
    const { db, body } = ctx;
    const name = str(body.name, 'name', { required: true, max: 100 });
    const email = str(body.email, 'email', { required: true, max: 200 }).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new HttpError(400, 'email is not valid');
    const role = parseRole(body.role, 'participant');
    assertCanManage(ctx, { access_role: 'participant' }, role);
    const collectionIds = Array.isArray(body.collectionIds) ? [...new Set(body.collectionIds.map(Number))] : [];
    for (const cid of collectionIds) await getCollection(db, cid);
    if (await first(db, 'SELECT 1 AS ok FROM users WHERE email = ?', email)) {
      throw new HttpError(409, 'A user with this email already exists');
    }
    const user = await first(
      db,
      `INSERT INTO users (name, email, role, access_role, invite_token, invite_expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      name,
      email,
      role === 'admin' ? 'admin' : 'user',
      role,
      auth.randomToken(),
      now() + auth.INVITE_TTL,
      now()
    );
    if (collectionIds.length) {
      const add = db.prepare('INSERT OR IGNORE INTO collection_members (collection_id, user_id) VALUES (?, ?)');
      await db.batch(collectionIds.map((cid) => add.bind(cid, user.id)));
    }
    return [201, { user: adminUser(user) }];
  });

  route('PATCH', '/api/admin/users/:id', { role: 'manager' }, async (ctx) => {
    const user = await getUser(ctx.db, ctx.params.id);
    const name = str(ctx.body.name, 'name', { max: 100 }) || user.name;
    const role = parseRole(ctx.body.role, user.access_role);
    if (user.id === ctx.user.id && role !== user.access_role) {
      throw new HttpError(400, 'You cannot change your own role');
    }
    assertCanManage(ctx, user, role);
    await run(
      ctx.db,
      'UPDATE users SET name = ?, role = ?, access_role = ? WHERE id = ?',
      name,
      role === 'admin' ? 'admin' : 'user',
      role,
      user.id
    );
    return { user: adminUser({ ...user, name, access_role: role }) };
  });

  route('POST', '/api/admin/users/:id/invite', { role: 'manager' }, async (ctx) => {
    const user = await getUser(ctx.db, ctx.params.id);
    if (user.id === ctx.user.id) throw new HttpError(400, 'You cannot reset your own password here');
    assertCanManage(ctx, user);
    const token = auth.randomToken();
    const expires = now() + auth.INVITE_TTL;
    // Re-inviting an active user acts as a password reset and signs them out everywhere.
    await ctx.db.batch([
      ctx.db
        .prepare('UPDATE users SET invite_token = ?, invite_expires_at = ?, password_hash = NULL WHERE id = ?')
        .bind(token, expires, user.id),
      ctx.db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
    ]);
    return {
      user: adminUser({ ...user, password_hash: null, invite_token: token, invite_expires_at: expires }),
    };
  });

  route('DELETE', '/api/admin/users/:id', { role: 'manager' }, async (ctx) => {
    const user = await getUser(ctx.db, ctx.params.id);
    if (user.id === ctx.user.id) throw new HttpError(400, 'You cannot delete yourself');
    assertCanManage(ctx, user);
    await run(ctx.db, 'DELETE FROM users WHERE id = ?', user.id);
    return { ok: true };
  });

  // ---------- admin: collections ----------

  // Managers and admins see every collection; creators only the ones they made.
  route('GET', '/api/admin/collections', { role: 'creator' }, async ({ db, user }) => {
    const rows = await all(
      db,
      `SELECT c.*, u.name AS creator_name,
              (SELECT COUNT(*) FROM items i WHERE i.collection_id = c.id) AS item_count,
              (SELECT COUNT(*) FROM collection_members m WHERE m.collection_id = c.id) AS member_count
         FROM collections c LEFT JOIN users u ON u.id = c.created_by
        WHERE ?1 OR c.created_by = ?2
           OR EXISTS (SELECT 1 FROM collection_editors e WHERE e.collection_id = c.id AND e.user_id = ?2)
        ORDER BY c.created_at DESC`,
      atLeast(user, 'manager') ? 1 : 0,
      user.id
    );
    return {
      collections: rows.map((c) => ({
        ...serializeCollection(c),
        itemCount: c.item_count,
        memberCount: c.member_count,
        createdBy: c.created_by ? { id: c.created_by, name: c.creator_name } : null,
        sharedWithMe: !atLeast(user, 'manager') && c.created_by !== user.id,
      })),
    };
  });

  route('POST', '/api/admin/collections', { role: 'creator' }, async ({ db, body, user }) => {
    const name = str(body.name, 'name', { required: true, max: 120 });
    const description = str(body.description, 'description') || '';
    const expiresAt = timestamp(body.expiresAt, 'expiresAt');
    if (expiresAt === undefined) throw new HttpError(400, 'expiresAt is required');
    const c = await first(
      db,
      'INSERT INTO collections (name, description, expires_at, published, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *',
      name,
      description,
      expiresAt,
      body.published ? 1 : 0,
      user.id,
      now()
    );
    return [201, { collection: serializeCollection(c) }];
  });

  // Creators see totals (likes per item, how far people are); "who chose what" is for managers+.
  route('GET', '/api/admin/collections/:id', { role: 'creator' }, async (ctx) => {
    const { db } = ctx;
    const c = await managedCollection(ctx, ctx.params.id);
    const seeChoices = atLeast(ctx.user, 'manager');
    const [items, members, allocations, swipes, editors, creator, exclusions] = await Promise.all([
      all(
        db,
        `SELECT i.*,
                (SELECT COUNT(*) FROM swipes s WHERE s.item_id = i.id AND s.liked = 1) AS likes,
                (SELECT COUNT(*) FROM swipes s WHERE s.item_id = i.id AND s.liked = 0) AS passes,
                (SELECT COUNT(*) FROM allocations a WHERE a.item_id = i.id) AS allocated
           FROM items i WHERE i.collection_id = ? ORDER BY i.id`,
        c.id
      ),
      all(
        db,
        `SELECT u.*,
                (SELECT COUNT(*) FROM swipes s JOIN items i ON i.id = s.item_id
                  WHERE i.collection_id = m.collection_id AND s.user_id = u.id) AS swiped
           FROM collection_members m JOIN users u ON u.id = m.user_id
          WHERE m.collection_id = ? ORDER BY u.name COLLATE NOCASE`,
        c.id
      ),
      all(
        db,
        `SELECT a.id, a.item_id, a.user_id, a.collected_at, u.name AS user_name, i.title AS item_title
           FROM allocations a
           JOIN items i ON i.id = a.item_id
           JOIN users u ON u.id = a.user_id
          WHERE i.collection_id = ? ORDER BY u.name COLLATE NOCASE, i.title COLLATE NOCASE`,
        c.id
      ),
      seeChoices
        ? all(
            db,
            `SELECT s.user_id, s.item_id, s.liked FROM swipes s
               JOIN items i ON i.id = s.item_id
               JOIN collection_members m ON m.collection_id = i.collection_id AND m.user_id = s.user_id
              WHERE i.collection_id = ?`,
            c.id
          )
        : [],
      all(
        db,
        `SELECT u.id, u.name, u.email FROM collection_editors e JOIN users u ON u.id = e.user_id
          WHERE e.collection_id = ? ORDER BY u.name COLLATE NOCASE`,
        c.id
      ),
      c.created_by ? first(db, 'SELECT id, name FROM users WHERE id = ?', c.created_by) : null,
      seeChoices
        ? all(
            db,
            `SELECT x.user_id, x.item_id, u.name AS user_name, i.title AS item_title
               FROM allocation_exclusions x JOIN items i ON i.id = x.item_id JOIN users u ON u.id = x.user_id
              WHERE i.collection_id = ? ORDER BY u.name COLLATE NOCASE, i.title COLLATE NOCASE`,
            c.id
          )
        : [],
    ]);
    return {
      collection: serializeCollection(c),
      seeChoices,
      createdBy: creator ? { id: creator.id, name: creator.name } : null,
      editors,
      allocationRound: c.allocation_round || 0,
      canReopen: canReopen(ctx.user, c),
      removed: exclusions.map((x) => ({ userId: x.user_id, userName: x.user_name, itemId: x.item_id, itemTitle: x.item_title })),
      canDelete: seeChoices || c.created_by === ctx.user.id,
      canManageEditors: seeChoices,
      items: items.map((i) => ({ ...serializeItem(i), likes: i.likes, passes: i.passes, allocated: i.allocated })),
      members: members.map((u) => {
        const m = { ...adminUser(u), swiped: u.swiped };
        return seeChoices ? m : { ...m, inviteToken: null, inviteExpiresAt: null };
      }),
      choices: swipes.map((s) => ({ userId: s.user_id, itemId: s.item_id, liked: !!s.liked })),
      allocations: (seeChoices ? allocations : []).map((a) => ({
        id: a.id,
        itemId: a.item_id,
        itemTitle: a.item_title,
        userId: a.user_id,
        userName: a.user_name,
        collected: a.collected_at !== null,
        collectedAt: a.collected_at,
      })),
    };
  });

  route('PATCH', '/api/admin/collections/:id', { role: 'creator' }, async (ctx) => {
    const { db, body } = ctx;
    const c = await managedCollection(ctx, ctx.params.id);
    const name = str(body.name, 'name', { max: 120 }) || c.name;
    const description = str(body.description, 'description') ?? c.description;
    const expiresAt = timestamp(body.expiresAt, 'expiresAt') ?? c.expires_at;
    const published = body.published === undefined ? c.published : body.published ? 1 : 0;
    const stmts = [];
    // Moving the deadline into the future re-opens a closed collection.
    let finalizedAt = c.finalized_at;
    if (finalizedAt !== null && expiresAt > now()) {
      stmts.push(...(await reopenStatements(ctx, c)));
      finalizedAt = null;
    }
    stmts.push(
      db
        .prepare('UPDATE collections SET name = ?, description = ?, expires_at = ?, published = ?, finalized_at = ? WHERE id = ?')
        .bind(name, description, expiresAt, published, finalizedAt, c.id)
    );
    await db.batch(stmts);
    await finalizeDue(db);
    return { collection: serializeCollection(await getCollection(db, c.id)) };
  });

  route('POST', '/api/admin/collections/:id/reopen', { role: 'creator' }, async (ctx) => {
    const { db, body } = ctx;
    const c = await managedCollection(ctx, ctx.params.id);
    if (c.finalized_at === null) throw new HttpError(409, 'This collection is not closed');
    const expiresAt = timestamp(body.expiresAt, 'expiresAt');
    if (expiresAt === undefined || expiresAt <= now()) throw new HttpError(400, 'Choose a new deadline in the future');
    await db.batch([
      ...(await reopenStatements(ctx, c)),
      db.prepare('UPDATE collections SET expires_at = ?, finalized_at = NULL, published = 1 WHERE id = ?').bind(expiresAt, c.id),
    ]);
    return { collection: serializeCollection(await getCollection(db, c.id)) };
  });

  route('POST', '/api/admin/collections/:id/close', { role: 'creator' }, async (ctx) => {
    const { db } = ctx;
    const c = await managedCollection(ctx, ctx.params.id);
    if (!c.published) throw new HttpError(409, 'Publish the collection before closing it');
    if (c.expires_at > now()) await run(db, 'UPDATE collections SET expires_at = ? WHERE id = ?', now(), c.id);
    await finalizeCollection(db, c.id);
    return { collection: serializeCollection(await getCollection(db, c.id)) };
  });

  // Admins can throw away a collection's allocation and draw a new one. Items already picked up
  // stay with their person unless keepCollected is false.
  route('POST', '/api/admin/collections/:id/reallocate', { role: 'admin' }, async ({ db, params, body, user }) => {
    const c = await getCollection(db, params.id);
    if (c.finalized_at === null) throw new HttpError(409, 'This collection has not been allocated yet');
    // onlyFree: everyone keeps what they have and only free units (e.g. taken away) are handed out.
    const onlyFree = body.onlyFree === true;
    await saveVersion(db, c, onlyFree ? 'Before handing out free items' : 'Before redoing the allocation', user.id);
    const keepCollected = onlyFree || body.keepCollected !== false;
    const kept = keepCollected
      ? await all(
          db,
          `SELECT a.item_id AS itemId, a.user_id AS userId FROM allocations a JOIN items i ON i.id = a.item_id
            WHERE i.collection_id = ?${onlyFree ? '' : ' AND a.collected_at IS NOT NULL'}`,
          c.id
        )
      : [];
    const { items, likes } = await allocationInput(db, c.id);
    const round = (c.allocation_round || 0) + 1;
    const fresh = allocate({ items, likes, seed: seedFor(c, round), fixed: kept });
    const insert = db.prepare('INSERT OR IGNORE INTO allocations (item_id, user_id) VALUES (?, ?)');
    const clear = onlyFree
      ? [] // everyone keeps what they have
      : [
          db
            .prepare(
              `DELETE FROM allocations WHERE item_id IN (SELECT id FROM items WHERE collection_id = ?)${keepCollected ? ' AND collected_at IS NULL' : ''}`
            )
            .bind(c.id),
        ];
    await db.batch([
      ...clear,
      ...fresh.map((a) => insert.bind(a.itemId, a.userId)),
      db.prepare('UPDATE collections SET allocation_round = ?, finalized_at = ? WHERE id = ?').bind(round, now(), c.id),
      // Take-aways only steer this hand-out; afterwards they're forgotten.
      db.prepare('DELETE FROM allocation_exclusions WHERE item_id IN (SELECT id FROM items WHERE collection_id = ?)').bind(c.id),
    ]);
    return { collection: serializeCollection(await getCollection(db, c.id)), round, kept: kept.length, allocated: fresh.length };
  });

  // Admins can change a participant's choices, also after closing. A new hand-out uses them.
  route('PUT', '/api/admin/collections/:id/choices', { role: 'admin' }, async ({ db, params, body }) => {
    const c = await getCollection(db, params.id);
    const userId = Number(body.userId);
    const itemId = Number(body.itemId);
    const item = await first(db, 'SELECT id FROM items WHERE id = ? AND collection_id = ?', itemId, c.id);
    if (!item) throw new HttpError(404, 'Item not found in this collection');
    const member = await first(db, 'SELECT 1 AS ok FROM collection_members WHERE collection_id = ? AND user_id = ?', c.id, userId);
    if (!member) throw new HttpError(400, 'That person is not a participant of this collection');
    if (body.liked === null) {
      await run(db, 'DELETE FROM swipes WHERE user_id = ? AND item_id = ?', userId, itemId);
    } else if (typeof body.liked === 'boolean') {
      await run(
        db,
        `INSERT INTO swipes (user_id, item_id, liked, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, item_id) DO UPDATE SET liked = excluded.liked`,
        userId,
        itemId,
        body.liked ? 1 : 0,
        now()
      );
    } else {
      throw new HttpError(400, 'liked must be true, false or null');
    }
    return { ok: true };
  });

  // Admins can take allocated items away from someone. The units become free, and that person
  // is skipped for those items in later (re)allocations.
  route('POST', '/api/admin/collections/:id/release', { role: 'admin' }, async ({ db, params, body, user }) => {
    const c = await getCollection(db, params.id);
    if (!Array.isArray(body.allocationIds) || !body.allocationIds.length) {
      throw new HttpError(400, 'allocationIds must be a non-empty array');
    }
    const rows = [];
    for (const id of new Set(body.allocationIds.map(Number))) {
      const a = await first(
        db,
        'SELECT a.id, a.item_id, a.user_id FROM allocations a JOIN items i ON i.id = a.item_id WHERE a.id = ? AND i.collection_id = ?',
        id,
        c.id
      );
      if (!a) throw new HttpError(404, `Allocation ${id} not found in this collection`);
      rows.push(a);
    }
    await saveVersion(db, c, rows.length === 1 ? 'Before taking an item away' : `Before taking ${rows.length} items away`, user.id);
    const exclude = db.prepare('INSERT OR IGNORE INTO allocation_exclusions (item_id, user_id, created_at) VALUES (?, ?, ?)');
    const remove = db.prepare('DELETE FROM allocations WHERE id = ?');
    await db.batch(rows.flatMap((a) => [exclude.bind(a.item_id, a.user_id, now()), remove.bind(a.id)]));
    return { ok: true, released: rows.length };
  });

  // Undo a take-away: the person may get the item again in a later (re)allocation.
  route('POST', '/api/admin/collections/:id/unrelease', { role: 'admin' }, async ({ db, params, body }) => {
    const c = await getCollection(db, params.id);
    const r = await run(
      db,
      'DELETE FROM allocation_exclusions WHERE user_id = ? AND item_id IN (SELECT id FROM items WHERE id = ? AND collection_id = ?)',
      Number(body.userId),
      Number(body.itemId),
      c.id
    );
    if (!r.meta.changes) throw new HttpError(404, 'Nothing to undo');
    return { ok: true };
  });

  // ---------- allocation versions ----------

  async function closedCollection(db, id) {
    const c = await getCollection(db, id);
    if (c.finalized_at === null) throw new HttpError(409, 'This collection has not been allocated yet');
    return c;
  }

  route('GET', '/api/admin/collections/:id/allocation', { role: 'admin' }, async ({ db, params }) => {
    return allocationSnapshot(db, await closedCollection(db, params.id));
  });

  route('GET', '/api/admin/collections/:id/allocation/versions', { role: 'admin' }, async ({ db, params }) => {
    const c = await getCollection(db, params.id);
    const rows = await all(
      db,
      `SELECT v.id, v.label, v.created_at, v.data, u.name AS by_name
         FROM allocation_versions v LEFT JOIN users u ON u.id = v.created_by
        WHERE v.collection_id = ? ORDER BY v.created_at DESC, v.id DESC`,
      c.id
    );
    return {
      versions: rows.map((v) => {
        let count = 0;
        try {
          count = JSON.parse(v.data).allocations.length;
        } catch {
          // ignore unreadable data
        }
        return { id: v.id, label: v.label, createdAt: v.created_at, by: v.by_name, items: count };
      }),
    };
  });

  route('GET', '/api/admin/collections/:id/allocation/versions/:vid', { role: 'admin' }, async ({ db, params }) => {
    const c = await getCollection(db, params.id);
    const v = await first(db, 'SELECT data FROM allocation_versions WHERE id = ? AND collection_id = ?', Number(params.vid), c.id);
    if (!v) throw new HttpError(404, 'Version not found');
    return JSON.parse(v.data);
  });

  route('POST', '/api/admin/collections/:id/allocation/versions/:vid/restore', { role: 'admin' }, async ({ db, params, user }) => {
    const c = await closedCollection(db, params.id);
    const v = await first(db, 'SELECT data FROM allocation_versions WHERE id = ? AND collection_id = ?', Number(params.vid), c.id);
    if (!v) throw new HttpError(404, 'Version not found');
    await saveVersion(db, c, 'Before restoring a version', user.id);
    return applySnapshot(db, c, JSON.parse(v.data));
  });

  // Removes the whole allocation (who gets what, pickups and take-aways). A version is saved first.
  route('POST', '/api/admin/collections/:id/allocation/reset', { role: 'admin' }, async ({ db, params, user }) => {
    const c = await closedCollection(db, params.id);
    await saveVersion(db, c, 'Before reset', user.id);
    const r = await run(db, 'DELETE FROM allocations WHERE item_id IN (SELECT id FROM items WHERE collection_id = ?)', c.id);
    await run(db, 'DELETE FROM allocation_exclusions WHERE item_id IN (SELECT id FROM items WHERE collection_id = ?)', c.id);
    return { ok: true, removed: r.meta.changes };
  });

  route('POST', '/api/admin/collections/:id/allocation/import', { role: 'admin' }, async ({ db, params, body, user }) => {
    const c = await closedCollection(db, params.id);
    // Validate before saving a version, so a wrong file changes nothing.
    if (!body || body.format !== VERSION_FORMAT) throw new HttpError(400, 'This is not a Swipio allocation file');
    if (body.collection && Number(body.collection.id) !== c.id) {
      throw new HttpError(400, `This file belongs to another collection ("${body.collection.name}")`);
    }
    await saveVersion(db, c, 'Before importing a file', user.id);
    return applySnapshot(db, c, body);
  });

  route('DELETE', '/api/admin/collections/:id', { role: 'creator' }, async (ctx) => {
    const { db } = ctx;
    const c = await managedCollection(ctx, ctx.params.id, { toDelete: true });
    await db.batch([
      db
        .prepare('DELETE FROM images WHERE id IN (SELECT image_id FROM items WHERE collection_id = ? AND image_id IS NOT NULL)')
        .bind(c.id),
      db.prepare('DELETE FROM collections WHERE id = ?').bind(c.id),
    ]);
    return { ok: true };
  });

  route('PUT', '/api/admin/collections/:id/members', { role: 'creator' }, async (ctx) => {
    const { db, body } = ctx;
    const c = await managedCollection(ctx, ctx.params.id);
    if (!Array.isArray(body.userIds)) throw new HttpError(400, 'userIds must be an array');
    const ids = [...new Set(body.userIds.map(Number))];
    for (const id of ids) {
      if (!(await first(db, 'SELECT 1 AS ok FROM users WHERE id = ?', id))) throw new HttpError(400, `Unknown user ${id}`);
    }
    const add = db.prepare('INSERT INTO collection_members (collection_id, user_id) VALUES (?, ?)');
    await db.batch([
      db.prepare('DELETE FROM collection_members WHERE collection_id = ?').bind(c.id),
      ...ids.map((id) => add.bind(c.id, id)),
    ]);
    return { ok: true, userIds: ids };
  });

  // Managers and admins choose which creators may also manage this collection.
  route('PUT', '/api/admin/collections/:id/editors', { role: 'manager' }, async (ctx) => {
    const { db, body } = ctx;
    const c = await getCollection(db, ctx.params.id);
    if (!Array.isArray(body.userIds)) throw new HttpError(400, 'userIds must be an array');
    const ids = [...new Set(body.userIds.map(Number))].filter((id) => id !== c.created_by);
    for (const id of ids) {
      const u = await first(db, 'SELECT name, access_role FROM users WHERE id = ?', id);
      if (!u) throw new HttpError(400, `Unknown user ${id}`);
      if (u.access_role !== 'creator') {
        throw new HttpError(
          400,
          u.access_role === 'participant'
            ? `${u.name} is a participant. Give them the Creator role first.`
            : `${u.name} can already manage every collection.`
        );
      }
    }
    const add = db.prepare('INSERT INTO collection_editors (collection_id, user_id) VALUES (?, ?)');
    await db.batch([
      db.prepare('DELETE FROM collection_editors WHERE collection_id = ?').bind(c.id),
      ...ids.map((id) => add.bind(c.id, id)),
    ]);
    return { ok: true, userIds: ids };
  });

  // ---------- admin: items ----------

  route('POST', '/api/admin/collections/:id/items', { role: 'creator' }, async (ctx) => {
    const { db, body } = ctx;
    const c = await managedCollection(ctx, ctx.params.id);
    const title = str(body.title, 'title', { required: true, max: 120 });
    const description = str(body.description, 'description') || '';
    const qty = quantity(body.quantity) ?? 1;
    const group = str(body.group, 'group', { max: 60 }) || null;
    const url = imageUrl(body.imageUrl);
    const imageId = await storeImage(db, body.image);
    const item = await first(
      db,
      `INSERT INTO items (collection_id, title, description, image_id, image_url, quantity, product_group, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      c.id,
      title,
      description,
      imageId,
      imageId ? null : url,
      qty,
      group,
      now()
    );
    return [201, { item: serializeItem(item) }];
  });

  route('PATCH', '/api/admin/items/:id', { role: 'creator' }, async (ctx) => {
    const { db, body } = ctx;
    const item = await managedItem(ctx, ctx.params.id);
    const title = str(body.title, 'title', { max: 120 }) || item.title;
    const description = str(body.description, 'description') ?? item.description;
    const qty = quantity(body.quantity) ?? item.quantity;
    // An empty group removes it; leaving the field out keeps the current one.
    const group = body.group === undefined ? item.product_group : str(body.group, 'group', { max: 60 }) || null;
    const url = body.imageUrl ? imageUrl(body.imageUrl) : undefined;
    let imageId = item.image_id;
    let imgUrl = item.image_url;
    const uploaded = await storeImage(db, body.image);
    if (uploaded) [imageId, imgUrl] = [uploaded, null];
    else if (body.removeImage === 'true' || body.removeImage === true) [imageId, imgUrl] = [null, null];
    else if (url) [imageId, imgUrl] = [null, url];
    const updated = await first(
      db,
      'UPDATE items SET title = ?, description = ?, quantity = ?, image_id = ?, image_url = ?, product_group = ? WHERE id = ? RETURNING *',
      title,
      description,
      qty,
      imageId,
      imgUrl,
      group,
      item.id
    );
    if (item.image_id && item.image_id !== imageId) await deleteImage(db, item.image_id);
    return { item: serializeItem(updated) };
  });

  route('DELETE', '/api/admin/items/:id', { role: 'creator' }, async (ctx) => {
    const { db } = ctx;
    const item = await managedItem(ctx, ctx.params.id);
    await run(db, 'DELETE FROM items WHERE id = ?', item.id);
    await deleteImage(db, item.image_id);
    return { ok: true };
  });

  // Pickup tracking is part of the results overview, so it's for managers and admins.
  route('PATCH', '/api/admin/allocations/:id', { role: 'manager' }, async ({ db, params, body }) => {
    const r = await run(
      db,
      'UPDATE allocations SET collected_at = ? WHERE id = ?',
      body.collected ? now() : null,
      Number(params.id)
    );
    if (!r.meta.changes) throw new HttpError(404, 'Allocation not found');
    return { ok: true };
  });

  // ---------- request handling ----------

  function cors(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = String(env.ALLOWED_ORIGINS || '*')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!allowed.includes('*') && !allowed.includes(origin)) return {};
    return {
      'Access-Control-Allow-Origin': allowed.includes('*') ? '*' : origin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
  }

  const json = (body, status, headers) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

  async function fetch(request, env) {
    const headers = cors(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    const url = new URL(request.url);
    try {
      const db = env.DB;
      let params;
      const match = routes.find((r) => {
        if (r.method !== request.method) return false;
        const m = url.pathname.match(r.re);
        if (m) params = m.groups || {};
        return !!m;
      });
      if (!match) throw new HttpError(404, 'Not found');

      const ctx = { req: request, env, url, db, params, user: null, tokenHash: null, body: {} };
      const bearer = (request.headers.get('Authorization') || '').match(/^Bearer\s+(\S+)$/i);
      if (bearer) {
        ctx.tokenHash = await auth.sha256(bearer[1]);
        ctx.user = await first(
          db,
          `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
            WHERE s.token_hash = ? AND s.expires_at > ?`,
          ctx.tokenHash,
          now()
        );
      }
      if ((match.opts.auth || match.opts.role) && !ctx.user) throw new HttpError(401, 'Please log in');
      if (match.opts.role && !atLeast(ctx.user, match.opts.role)) {
        throw new HttpError(403, "You don't have permission to do this");
      }
      if (request.method !== 'GET') ctx.body = await readBody(request);

      if (url.pathname.startsWith('/api/collections') || url.pathname.startsWith('/api/admin')) {
        await finalizeDue(db);
      }

      const result = await match.handler(ctx);
      if (result instanceof Response) {
        for (const [k, v] of Object.entries(headers)) result.headers.set(k, v);
        return result;
      }
      const [status, body] = Array.isArray(result) ? result : [200, result];
      return json(body, status, headers);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(err);
      return json({ error: status >= 500 ? 'Something went wrong' : err.message }, status, headers);
    }
  }

  async function scheduled(event, env) {
    await finalizeDue(env.DB);
  }

  return { fetch, scheduled, finalizeDue };
}
