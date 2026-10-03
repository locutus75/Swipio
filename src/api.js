// Swipio API: a Cloudflare Worker backed by a D1 (SQLite) database.
//
// Auth uses bearer tokens (Authorization: Bearer ...) rather than cookies, because the frontend
// lives on GitHub Pages and the API on workers.dev, two different sites.
//
// Roles: participant (swipes), creator (+ makes and runs their own collections), manager (+ sees
// every collection, who chose what, and manages users), admin (+ manages admins).
//
// Vars (see wrangler.toml): ALLOWED_ORIGINS, PASSWORD_ITERATIONS. Binding: DB (D1).

import { allocate } from './allocation.js';
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

  async function finalizeCollection(db, collectionId) {
    const c = await first(db, 'SELECT * FROM collections WHERE id = ?', collectionId);
    if (!c || c.finalized_at !== null) return;
    const items = await all(db, 'SELECT id, quantity FROM items WHERE collection_id = ?', collectionId);
    const likes = await all(
      db,
      `SELECT s.item_id AS itemId, s.user_id AS userId
         FROM swipes s
         JOIN items i ON i.id = s.item_id
         JOIN collection_members m ON m.collection_id = i.collection_id AND m.user_id = s.user_id
        WHERE i.collection_id = ? AND s.liked = 1
        ORDER BY s.created_at`,
      collectionId
    );
    // D1 has no interactive transactions, but a batch is atomic. The result is deterministic
    // (seeded), so INSERT OR IGNORE makes a concurrent finalization of the same collection harmless.
    const insert = db.prepare('INSERT OR IGNORE INTO allocations (item_id, user_id) VALUES (?, ?)');
    await db.batch([
      ...allocate({ items, likes, seed: `${c.id}:${c.expires_at}` }).map((a) => insert.bind(a.itemId, a.userId)),
      db.prepare('UPDATE collections SET finalized_at = ? WHERE id = ? AND finalized_at IS NULL').bind(now(), collectionId),
    ]);
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

  /** Returns the collection if the current user may manage it: managers all, creators their own. */
  async function managedCollection(ctx, id) {
    const c = await getCollection(ctx.db, id);
    if (!atLeast(ctx.user, 'manager') && c.created_by !== ctx.user.id) throw new HttpError(404, 'Collection not found');
    return c;
  }

  async function managedItem(ctx, id) {
    const item = await getItem(ctx.db, id);
    await managedCollection(ctx, item.collection_id);
    return item;
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
    try {
      return (await req.json()) || {};
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
      `SELECT i.*, s.liked AS liked, a.id AS allocation_id, a.collected_at AS collected_at
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
    const [items, members, allocations, swipes] = await Promise.all([
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
    ]);
    return {
      collection: serializeCollection(c),
      seeChoices,
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
      stmts.push(
        db.prepare('DELETE FROM allocations WHERE item_id IN (SELECT id FROM items WHERE collection_id = ?)').bind(c.id)
      );
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

  route('POST', '/api/admin/collections/:id/close', { role: 'creator' }, async (ctx) => {
    const { db } = ctx;
    const c = await managedCollection(ctx, ctx.params.id);
    if (!c.published) throw new HttpError(409, 'Publish the collection before closing it');
    if (c.expires_at > now()) await run(db, 'UPDATE collections SET expires_at = ? WHERE id = ?', now(), c.id);
    await finalizeCollection(db, c.id);
    return { collection: serializeCollection(await getCollection(db, c.id)) };
  });

  route('DELETE', '/api/admin/collections/:id', { role: 'creator' }, async (ctx) => {
    const { db } = ctx;
    const c = await managedCollection(ctx, ctx.params.id);
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

  // ---------- admin: items ----------

  route('POST', '/api/admin/collections/:id/items', { role: 'creator' }, async (ctx) => {
    const { db, body } = ctx;
    const c = await managedCollection(ctx, ctx.params.id);
    const title = str(body.title, 'title', { required: true, max: 120 });
    const description = str(body.description, 'description') || '';
    const qty = quantity(body.quantity) ?? 1;
    const url = imageUrl(body.imageUrl);
    const imageId = await storeImage(db, body.image);
    const item = await first(
      db,
      `INSERT INTO items (collection_id, title, description, image_id, image_url, quantity, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      c.id,
      title,
      description,
      imageId,
      imageId ? null : url,
      qty,
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
    const url = body.imageUrl ? imageUrl(body.imageUrl) : undefined;
    let imageId = item.image_id;
    let imgUrl = item.image_url;
    const uploaded = await storeImage(db, body.image);
    if (uploaded) [imageId, imgUrl] = [uploaded, null];
    else if (body.removeImage === 'true' || body.removeImage === true) [imageId, imgUrl] = [null, null];
    else if (url) [imageId, imgUrl] = [null, url];
    const updated = await first(
      db,
      'UPDATE items SET title = ?, description = ?, quantity = ?, image_id = ?, image_url = ? WHERE id = ? RETURNING *',
      title,
      description,
      qty,
      imageId,
      imgUrl,
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
