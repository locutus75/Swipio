'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const { tx } = require('./db');
const { allocate } = require('./allocation');
const auth = require('./auth');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const IMAGE_TYPES = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
};

/**
 * @param {object} opts
 * @param {import('node:sqlite').DatabaseSync} opts.db
 * @param {string} opts.uploadDir  where item images are stored
 * @param {() => number} [opts.now] clock, injectable for tests
 * @param {string} [opts.publicUrl] base URL used in invite links
 * @param {boolean} [opts.secureCookies]
 */
function createApp({ db, uploadDir, now = Date.now, publicUrl, secureCookies = false }) {
  fs.mkdirSync(uploadDir, { recursive: true });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  const upload = multer({
    storage: multer.diskStorage({
      destination: uploadDir,
      filename: (req, file, cb) =>
        cb(null, crypto.randomBytes(12).toString('hex') + IMAGE_TYPES[file.mimetype]),
    }),
    limits: { fileSize: 8 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => {
      if (IMAGE_TYPES[file.mimetype]) cb(null, true);
      else cb(new HttpError(400, 'Only JPEG, PNG, GIF, WebP or AVIF images are allowed'));
    },
  });

  // ---------- helpers ----------

  const q = (sql) => db.prepare(sql);

  function finalizeCollection(collectionId) {
    tx(db, () => {
      const c = q('SELECT * FROM collections WHERE id = ?').get(collectionId);
      if (!c || c.finalized_at !== null) return;
      const items = q('SELECT id, quantity FROM items WHERE collection_id = ?').all(collectionId);
      const likes = q(
        `SELECT s.item_id AS itemId, s.user_id AS userId
           FROM swipes s
           JOIN items i ON i.id = s.item_id
           JOIN collection_members m ON m.collection_id = i.collection_id AND m.user_id = s.user_id
          WHERE i.collection_id = ? AND s.liked = 1
          ORDER BY s.created_at`
      ).all(collectionId);
      const insert = q('INSERT INTO allocations (item_id, user_id) VALUES (?, ?)');
      for (const a of allocate({ items, likes, seed: `${c.id}:${c.expires_at}` })) {
        insert.run(a.itemId, a.userId);
      }
      q('UPDATE collections SET finalized_at = ? WHERE id = ?').run(now(), collectionId);
    });
  }

  function finalizeDue() {
    const due = q(
      'SELECT id FROM collections WHERE published = 1 AND finalized_at IS NULL AND expires_at <= ?'
    ).all(now());
    for (const { id } of due) finalizeCollection(id);
  }

  function inviteUrl(req, token) {
    const base = publicUrl || `${req.protocol}://${req.get('host')}`;
    return `${base.replace(/\/$/, '')}/#/invite/${token}`;
  }

  function publicUser(u) {
    return { id: u.id, name: u.name, email: u.email, role: u.role };
  }

  function adminUser(req, u) {
    const pending = !u.password_hash;
    return {
      ...publicUser(u),
      status: pending ? 'invited' : 'active',
      inviteUrl: pending && u.invite_token ? inviteUrl(req, u.invite_token) : null,
      inviteExpiresAt: pending ? u.invite_expires_at : null,
      createdAt: u.created_at,
    };
  }

  function startSession(res, userId) {
    const token = auth.randomToken();
    q('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(
      token,
      userId,
      now() + auth.SESSION_TTL
    );
    res.cookie(auth.COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookies,
      maxAge: auth.SESSION_TTL,
      path: '/',
    });
  }

  function collectionState(c) {
    if (!c.published) return 'draft';
    if (c.finalized_at !== null || c.expires_at <= now()) return 'closed';
    return 'open';
  }

  function serializeCollection(c) {
    return {
      id: c.id,
      name: c.name,
      description: c.description,
      expiresAt: c.expires_at,
      published: !!c.published,
      finalizedAt: c.finalized_at,
      state: collectionState(c),
    };
  }

  function serializeItem(i) {
    return {
      id: i.id,
      collectionId: i.collection_id,
      title: i.title,
      description: i.description,
      image: i.image,
      quantity: i.quantity,
    };
  }

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
    if (value === undefined || value === '') return undefined;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 10000) {
      throw new HttpError(400, 'quantity must be a whole number of at least 1');
    }
    return n;
  }

  function imageUrl(value) {
    const s = str(value, 'imageUrl', { max: 2000 });
    if (!s) return s;
    if (!/^https?:\/\//i.test(s)) throw new HttpError(400, 'imageUrl must start with http(s)://');
    return s;
  }

  function removeUpload(image) {
    if (!image || !image.startsWith('/uploads/')) return;
    fs.rm(path.join(uploadDir, path.basename(image)), { force: true }, () => {});
  }

  function getCollection(id) {
    const c = q('SELECT * FROM collections WHERE id = ?').get(Number(id));
    if (!c) throw new HttpError(404, 'Collection not found');
    return c;
  }

  function getItem(id) {
    const i = q('SELECT * FROM items WHERE id = ?').get(Number(id));
    if (!i) throw new HttpError(404, 'Item not found');
    return i;
  }

  /** Returns the collection if the current user may participate in it. */
  function memberCollection(req, collectionId) {
    const c = getCollection(collectionId);
    const member = q('SELECT 1 FROM collection_members WHERE collection_id = ? AND user_id = ?').get(
      c.id,
      req.user.id
    );
    if (!member || !c.published) throw new HttpError(404, 'Collection not found');
    return c;
  }

  // ---------- middleware ----------

  app.use(express.json({ limit: '100kb' }));

  // Mutating API calls must carry a custom header. Browsers will not send it
  // cross-site without a CORS preflight, which protects against CSRF.
  app.use('/api', (req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('X-Requested-With') !== 'swipio') {
      return next(new HttpError(403, 'Missing X-Requested-With header'));
    }
    next();
  });

  app.use('/api', (req, res, next) => {
    const token = auth.parseCookies(req.headers.cookie)[auth.COOKIE];
    req.sessionToken = token;
    if (token) {
      const row = q(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token = ? AND s.expires_at > ?`
      ).get(token, now());
      if (row) req.user = row;
    }
    finalizeDue();
    next();
  });

  const requireAuth = (req, res, next) =>
    req.user ? next() : next(new HttpError(401, 'Please log in'));
  const requireAdmin = (req, res, next) => {
    if (!req.user) return next(new HttpError(401, 'Please log in'));
    if (req.user.role !== 'admin') return next(new HttpError(403, 'Admins only'));
    next();
  };

  // ---------- setup & auth ----------

  app.get('/api/setup', (req, res) => {
    const admin = q("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get();
    res.json({ needsSetup: !admin });
  });

  app.post('/api/setup', (req, res) => {
    const name = str(req.body.name, 'name', { required: true, max: 100 });
    const email = str(req.body.email, 'email', { required: true, max: 200 }).toLowerCase();
    const password = String(req.body.password || '');
    if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
    const user = tx(db, () => {
      if (q("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get()) {
        throw new HttpError(409, 'Setup has already been completed');
      }
      const r = q(
        "INSERT INTO users (name, email, role, password_hash, created_at) VALUES (?, ?, 'admin', ?, ?)"
      ).run(name, email, auth.hashPassword(password), now());
      return q('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);
    });
    startSession(res, user.id);
    res.status(201).json({ user: publicUser(user) });
  });

  app.post('/api/login', (req, res) => {
    const email = String(req.body.email || '').trim();
    const password = String(req.body.password || '');
    const user = q('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !auth.verifyPassword(password, user.password_hash)) {
      throw new HttpError(401, 'Invalid email or password');
    }
    startSession(res, user.id);
    res.json({ user: publicUser(user) });
  });

  app.post('/api/logout', (req, res) => {
    if (req.sessionToken) q('DELETE FROM sessions WHERE token = ?').run(req.sessionToken);
    res.clearCookie(auth.COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  app.get('/api/me', requireAuth, (req, res) => {
    res.json({ user: publicUser(req.user) });
  });

  function findInvite(token) {
    const user = q('SELECT * FROM users WHERE invite_token = ?').get(String(token));
    if (!user || user.password_hash || user.invite_expires_at < now()) {
      throw new HttpError(404, 'This invite link is invalid or has expired');
    }
    return user;
  }

  app.get('/api/invites/:token', (req, res) => {
    const user = findInvite(req.params.token);
    res.json({ name: user.name, email: user.email });
  });

  app.post('/api/invites/:token', (req, res) => {
    const user = findInvite(req.params.token);
    const name = str(req.body.name, 'name', { max: 100 }) || user.name;
    const password = String(req.body.password || '');
    if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
    q(
      'UPDATE users SET name = ?, password_hash = ?, invite_token = NULL, invite_expires_at = NULL WHERE id = ?'
    ).run(name, auth.hashPassword(password), user.id);
    startSession(res, user.id);
    res.json({ user: publicUser({ ...user, name }) });
  });

  // ---------- participant API ----------

  app.get('/api/collections', requireAuth, (req, res) => {
    const rows = q(
      `SELECT c.*,
              (SELECT COUNT(*) FROM items i WHERE i.collection_id = c.id) AS item_count,
              (SELECT COUNT(*) FROM swipes s JOIN items i ON i.id = s.item_id
                WHERE i.collection_id = c.id AND s.user_id = $uid) AS swiped_count,
              (SELECT COUNT(*) FROM swipes s JOIN items i ON i.id = s.item_id
                WHERE i.collection_id = c.id AND s.user_id = $uid AND s.liked = 1) AS liked_count,
              (SELECT COUNT(*) FROM allocations a JOIN items i ON i.id = a.item_id
                WHERE i.collection_id = c.id AND a.user_id = $uid) AS won_count
         FROM collections c
         JOIN collection_members m ON m.collection_id = c.id AND m.user_id = $uid
        WHERE c.published = 1
        ORDER BY c.finalized_at IS NOT NULL, c.expires_at`
    ).all({ $uid: req.user.id });
    res.json({
      collections: rows.map((c) => ({
        ...serializeCollection(c),
        itemCount: c.item_count,
        swipedCount: c.swiped_count,
        likedCount: c.liked_count,
        wonCount: c.won_count,
      })),
    });
  });

  app.get('/api/collections/:id', requireAuth, (req, res) => {
    const c = memberCollection(req, req.params.id);
    const items = q(
      `SELECT i.*, s.liked AS liked, a.id AS allocation_id, a.collected_at AS collected_at
         FROM items i
         LEFT JOIN swipes s ON s.item_id = i.id AND s.user_id = $uid
         LEFT JOIN allocations a ON a.item_id = i.id AND a.user_id = $uid
        WHERE i.collection_id = $cid
        ORDER BY i.id`
    ).all({ $uid: req.user.id, $cid: c.id });
    res.json({
      collection: serializeCollection(c),
      items: items.map((i) => ({
        ...serializeItem(i),
        swipe: i.liked === null ? null : i.liked ? 'like' : 'pass',
        won: i.allocation_id !== null,
        collected: i.collected_at !== null,
      })),
    });
  });

  function swipeableItem(req) {
    const item = getItem(req.params.id);
    const c = memberCollection(req, item.collection_id);
    if (collectionState(c) !== 'open') throw new HttpError(409, 'This collection has closed');
    return item;
  }

  app.put('/api/items/:id/swipe', requireAuth, (req, res) => {
    const item = swipeableItem(req);
    if (typeof req.body.liked !== 'boolean') throw new HttpError(400, 'liked must be true or false');
    q(
      `INSERT INTO swipes (user_id, item_id, liked, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, item_id) DO UPDATE SET liked = excluded.liked, created_at = excluded.created_at`
    ).run(req.user.id, item.id, req.body.liked ? 1 : 0, now());
    res.json({ ok: true });
  });

  app.delete('/api/items/:id/swipe', requireAuth, (req, res) => {
    const item = swipeableItem(req);
    q('DELETE FROM swipes WHERE user_id = ? AND item_id = ?').run(req.user.id, item.id);
    res.json({ ok: true });
  });

  // ---------- admin: users ----------

  app.get('/api/admin/users', requireAdmin, (req, res) => {
    const users = q('SELECT * FROM users ORDER BY name COLLATE NOCASE').all();
    res.json({ users: users.map((u) => adminUser(req, u)) });
  });

  app.post('/api/admin/users', requireAdmin, (req, res) => {
    const name = str(req.body.name, 'name', { required: true, max: 100 });
    const email = str(req.body.email, 'email', { required: true, max: 200 }).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new HttpError(400, 'email is not valid');
    const role = req.body.role === 'admin' ? 'admin' : 'user';
    const collectionIds = Array.isArray(req.body.collectionIds) ? req.body.collectionIds.map(Number) : [];
    const user = tx(db, () => {
      if (q('SELECT 1 FROM users WHERE email = ?').get(email)) {
        throw new HttpError(409, 'A user with this email already exists');
      }
      const r = q(
        'INSERT INTO users (name, email, role, invite_token, invite_expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(name, email, role, auth.randomToken(), now() + auth.INVITE_TTL, now());
      const addMember = q('INSERT OR IGNORE INTO collection_members (collection_id, user_id) VALUES (?, ?)');
      for (const cid of collectionIds) {
        getCollection(cid);
        addMember.run(cid, r.lastInsertRowid);
      }
      return q('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);
    });
    res.status(201).json({ user: adminUser(req, user) });
  });

  app.patch('/api/admin/users/:id', requireAdmin, (req, res) => {
    const user = q('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
    if (!user) throw new HttpError(404, 'User not found');
    const name = str(req.body.name, 'name', { max: 100 }) || user.name;
    let role = user.role;
    if (req.body.role === 'admin' || req.body.role === 'user') role = req.body.role;
    if (user.id === req.user.id && role !== 'admin') {
      throw new HttpError(400, 'You cannot remove your own admin role');
    }
    q('UPDATE users SET name = ?, role = ? WHERE id = ?').run(name, role, user.id);
    res.json({ user: adminUser(req, { ...user, name, role }) });
  });

  app.post('/api/admin/users/:id/invite', requireAdmin, (req, res) => {
    const user = q('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
    if (!user) throw new HttpError(404, 'User not found');
    if (user.id === req.user.id) throw new HttpError(400, 'You cannot reset your own password here');
    const token = auth.randomToken();
    const expires = now() + auth.INVITE_TTL;
    // Re-inviting an active user acts as a password reset.
    tx(db, () => {
      q('UPDATE users SET invite_token = ?, invite_expires_at = ?, password_hash = NULL WHERE id = ?').run(
        token,
        expires,
        user.id
      );
      q('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    });
    res.json({
      user: adminUser(req, { ...user, password_hash: null, invite_token: token, invite_expires_at: expires }),
    });
  });

  app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.id) throw new HttpError(400, 'You cannot delete yourself');
    const r = q('DELETE FROM users WHERE id = ?').run(id);
    if (!r.changes) throw new HttpError(404, 'User not found');
    res.json({ ok: true });
  });

  // ---------- admin: collections ----------

  app.get('/api/admin/collections', requireAdmin, (req, res) => {
    const rows = q(
      `SELECT c.*,
              (SELECT COUNT(*) FROM items i WHERE i.collection_id = c.id) AS item_count,
              (SELECT COUNT(*) FROM collection_members m WHERE m.collection_id = c.id) AS member_count
         FROM collections c ORDER BY c.created_at DESC`
    ).all();
    res.json({
      collections: rows.map((c) => ({
        ...serializeCollection(c),
        itemCount: c.item_count,
        memberCount: c.member_count,
      })),
    });
  });

  app.post('/api/admin/collections', requireAdmin, (req, res) => {
    const name = str(req.body.name, 'name', { required: true, max: 120 });
    const description = str(req.body.description, 'description') || '';
    const expiresAt = timestamp(req.body.expiresAt, 'expiresAt');
    if (expiresAt === undefined) throw new HttpError(400, 'expiresAt is required');
    const r = q(
      'INSERT INTO collections (name, description, expires_at, published, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(name, description, expiresAt, req.body.published ? 1 : 0, now());
    res.status(201).json({ collection: serializeCollection(getCollection(r.lastInsertRowid)) });
  });

  app.get('/api/admin/collections/:id', requireAdmin, (req, res) => {
    const c = getCollection(req.params.id);
    const items = q(
      `SELECT i.*,
              (SELECT COUNT(*) FROM swipes s WHERE s.item_id = i.id AND s.liked = 1) AS likes,
              (SELECT COUNT(*) FROM swipes s WHERE s.item_id = i.id AND s.liked = 0) AS passes
         FROM items i WHERE i.collection_id = ? ORDER BY i.id`
    ).all(c.id);
    const members = q(
      `SELECT u.*,
              (SELECT COUNT(*) FROM swipes s JOIN items i ON i.id = s.item_id
                WHERE i.collection_id = m.collection_id AND s.user_id = u.id) AS swiped
         FROM collection_members m JOIN users u ON u.id = m.user_id
        WHERE m.collection_id = ? ORDER BY u.name COLLATE NOCASE`
    ).all(c.id);
    const allocations = q(
      `SELECT a.id, a.item_id, a.user_id, a.collected_at, u.name AS user_name, i.title AS item_title
         FROM allocations a
         JOIN items i ON i.id = a.item_id
         JOIN users u ON u.id = a.user_id
        WHERE i.collection_id = ? ORDER BY u.name COLLATE NOCASE, i.title COLLATE NOCASE`
    ).all(c.id);
    res.json({
      collection: serializeCollection(c),
      items: items.map((i) => ({ ...serializeItem(i), likes: i.likes, passes: i.passes })),
      members: members.map((u) => ({ ...adminUser(req, u), swiped: u.swiped })),
      allocations: allocations.map((a) => ({
        id: a.id,
        itemId: a.item_id,
        itemTitle: a.item_title,
        userId: a.user_id,
        userName: a.user_name,
        collected: a.collected_at !== null,
        collectedAt: a.collected_at,
      })),
    });
  });

  app.patch('/api/admin/collections/:id', requireAdmin, (req, res) => {
    const c = getCollection(req.params.id);
    const name = str(req.body.name, 'name', { max: 120 }) || c.name;
    const description = str(req.body.description, 'description') ?? c.description;
    const expiresAt = timestamp(req.body.expiresAt, 'expiresAt') ?? c.expires_at;
    const published = req.body.published === undefined ? c.published : req.body.published ? 1 : 0;
    tx(db, () => {
      // Moving the deadline into the future re-opens a closed collection.
      let finalizedAt = c.finalized_at;
      if (finalizedAt !== null && expiresAt > now()) {
        q('DELETE FROM allocations WHERE item_id IN (SELECT id FROM items WHERE collection_id = ?)').run(c.id);
        finalizedAt = null;
      }
      q(
        'UPDATE collections SET name = ?, description = ?, expires_at = ?, published = ?, finalized_at = ? WHERE id = ?'
      ).run(name, description, expiresAt, published, finalizedAt, c.id);
    });
    finalizeDue();
    res.json({ collection: serializeCollection(getCollection(c.id)) });
  });

  app.post('/api/admin/collections/:id/close', requireAdmin, (req, res) => {
    const c = getCollection(req.params.id);
    if (!c.published) throw new HttpError(409, 'Publish the collection before closing it');
    if (c.expires_at > now()) q('UPDATE collections SET expires_at = ? WHERE id = ?').run(now(), c.id);
    finalizeCollection(c.id);
    res.json({ collection: serializeCollection(getCollection(c.id)) });
  });

  app.delete('/api/admin/collections/:id', requireAdmin, (req, res) => {
    const c = getCollection(req.params.id);
    const images = q('SELECT image FROM items WHERE collection_id = ?').all(c.id);
    q('DELETE FROM collections WHERE id = ?').run(c.id);
    images.forEach((i) => removeUpload(i.image));
    res.json({ ok: true });
  });

  app.put('/api/admin/collections/:id/members', requireAdmin, (req, res) => {
    const c = getCollection(req.params.id);
    if (!Array.isArray(req.body.userIds)) throw new HttpError(400, 'userIds must be an array');
    const ids = [...new Set(req.body.userIds.map(Number))];
    tx(db, () => {
      q('DELETE FROM collection_members WHERE collection_id = ?').run(c.id);
      const add = q('INSERT INTO collection_members (collection_id, user_id) VALUES (?, ?)');
      for (const id of ids) {
        if (!q('SELECT 1 FROM users WHERE id = ?').get(id)) throw new HttpError(400, `Unknown user ${id}`);
        add.run(c.id, id);
      }
    });
    res.json({ ok: true, userIds: ids });
  });

  // ---------- admin: items ----------

  const imageUpload = (req, res, next) =>
    upload.single('image')(req, res, (err) => {
      if (err instanceof multer.MulterError) return next(new HttpError(400, err.message));
      next(err);
    });

  app.post('/api/admin/collections/:id/items', requireAdmin, imageUpload, (req, res) => {
    try {
      const c = getCollection(req.params.id);
      const title = str(req.body.title, 'title', { required: true, max: 120 });
      const description = str(req.body.description, 'description') || '';
      const qty = quantity(req.body.quantity) ?? 1;
      const image = req.file ? `/uploads/${req.file.filename}` : imageUrl(req.body.imageUrl) || null;
      const r = q(
        'INSERT INTO items (collection_id, title, description, image, quantity, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(c.id, title, description, image, qty, now());
      res.status(201).json({ item: serializeItem(getItem(r.lastInsertRowid)) });
    } catch (err) {
      if (req.file) removeUpload(`/uploads/${req.file.filename}`);
      throw err;
    }
  });

  app.patch('/api/admin/items/:id', requireAdmin, imageUpload, (req, res) => {
    try {
      const item = getItem(req.params.id);
      const title = str(req.body.title, 'title', { max: 120 }) || item.title;
      const description = str(req.body.description, 'description') ?? item.description;
      const qty = quantity(req.body.quantity) ?? item.quantity;
      let image = item.image;
      if (req.file) image = `/uploads/${req.file.filename}`;
      else if (req.body.removeImage === 'true' || req.body.removeImage === true) image = null;
      else if (req.body.imageUrl) image = imageUrl(req.body.imageUrl);
      q('UPDATE items SET title = ?, description = ?, quantity = ?, image = ? WHERE id = ?').run(
        title,
        description,
        qty,
        image,
        item.id
      );
      if (image !== item.image) removeUpload(item.image);
      res.json({ item: serializeItem(getItem(item.id)) });
    } catch (err) {
      if (req.file) removeUpload(`/uploads/${req.file.filename}`);
      throw err;
    }
  });

  app.delete('/api/admin/items/:id', requireAdmin, (req, res) => {
    const item = getItem(req.params.id);
    q('DELETE FROM items WHERE id = ?').run(item.id);
    removeUpload(item.image);
    res.json({ ok: true });
  });

  app.patch('/api/admin/allocations/:id', requireAdmin, (req, res) => {
    const r = q('UPDATE allocations SET collected_at = ? WHERE id = ?').run(
      req.body.collected ? now() : null,
      Number(req.params.id)
    );
    if (!r.changes) throw new HttpError(404, 'Allocation not found');
    res.json({ ok: true });
  });

  // ---------- static & errors ----------

  app.use('/api', (req, res, next) => next(new HttpError(404, 'Not found')));
  app.use('/uploads', express.static(uploadDir, { maxAge: '7d', fallthrough: false }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong' : err.message });
  });

  app.finalizeDue = finalizeDue;
  return app;
}

module.exports = { createApp };
