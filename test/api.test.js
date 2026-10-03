'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');

const HOUR = 3600 * 1000;

async function startServer() {
  let clock = Date.parse('2026-01-01T12:00:00Z');
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swipio-test-'));
  const app = createApp({ db: openDb(':memory:'), uploadDir, now: () => clock });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  function client() {
    let cookie = '';
    return async function call(method, url, body) {
      const headers = { 'X-Requested-With': 'swipio' };
      if (cookie) headers.Cookie = cookie;
      let payload;
      if (body instanceof FormData) payload = body;
      else if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      }
      const res = await fetch(base + url, { method, headers, body: payload });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const data = await res.json().catch(() => null);
      return { status: res.status, data };
    };
  }

  return {
    base,
    client,
    advance: (ms) => (clock += ms),
    now: () => clock,
    close: () => {
      server.close();
      fs.rmSync(uploadDir, { recursive: true, force: true });
    },
  };
}

test('full flow: setup, invite, swipe, expire, collect', async (t) => {
  const srv = await startServer();
  t.after(srv.close);
  const admin = srv.client();

  // First run setup
  assert.equal((await admin('GET', '/api/setup')).data.needsSetup, true);
  let r = await admin('POST', '/api/setup', { name: 'Ada', email: 'ada@example.com', password: 'supersecret' });
  assert.equal(r.status, 201);
  assert.equal(r.data.user.role, 'admin');
  r = await admin('POST', '/api/setup', { name: 'Eve', email: 'eve@example.com', password: 'supersecret' });
  assert.equal(r.status, 409, 'setup can only run once');

  // Collection with items
  r = await admin('POST', '/api/admin/collections', { name: 'Giveaway', expiresAt: srv.now() + 2 * HOUR });
  assert.equal(r.status, 201);
  const cid = r.data.collection.id;
  assert.equal(r.data.collection.state, 'draft');

  const fd = new FormData();
  fd.set('title', 'Lamp');
  fd.set('quantity', '1');
  fd.set('image', new Blob([Buffer.from('fakepng')], { type: 'image/png' }), 'lamp.png');
  r = await admin('POST', `/api/admin/collections/${cid}/items`, fd);
  assert.equal(r.status, 201);
  const lamp = r.data.item;
  assert.match(lamp.image, /^\/uploads\/.+\.png$/);
  assert.equal((await fetch(srv.base + lamp.image)).status, 200);

  r = await admin('POST', `/api/admin/collections/${cid}/items`, { title: 'Chair', quantity: 2 });
  const chair = r.data.item;
  r = await admin('POST', `/api/admin/collections/${cid}/items`, { title: 'Plant' });
  const plant = r.data.item;

  // Invite two people straight into the collection
  r = await admin('POST', '/api/admin/users', { name: 'Bob', email: 'bob@example.com', collectionIds: [cid] });
  assert.equal(r.status, 201);
  assert.equal(r.data.user.status, 'invited');
  const bobToken = r.data.user.inviteUrl.split('/invite/')[1];
  r = await admin('POST', '/api/admin/users', { name: 'Cat', email: 'cat@example.com', collectionIds: [cid] });
  const catToken = r.data.user.inviteUrl.split('/invite/')[1];
  r = await admin('POST', '/api/admin/users', { name: 'Dup', email: 'BOB@example.com' });
  assert.equal(r.status, 409);

  const bob = srv.client();
  const cat = srv.client();
  assert.equal((await bob('GET', `/api/invites/${bobToken}`)).data.email, 'bob@example.com');
  r = await bob('POST', `/api/invites/${bobToken}`, { password: 'short' });
  assert.equal(r.status, 400);
  r = await bob('POST', `/api/invites/${bobToken}`, { name: 'Bobby', password: 'bobpassword' });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.name, 'Bobby');
  assert.equal((await bob('GET', `/api/invites/${bobToken}`)).status, 404, 'invite is single use');
  await cat('POST', `/api/invites/${catToken}`, { password: 'catpassword' });

  // Draft collections are hidden from participants
  assert.deepEqual((await bob('GET', '/api/collections')).data.collections, []);
  assert.equal((await bob('GET', `/api/collections/${cid}`)).status, 404);
  assert.equal((await bob('GET', '/api/admin/users')).status, 403);

  await admin('PATCH', `/api/admin/collections/${cid}`, { published: true });
  r = await bob('GET', '/api/collections');
  assert.equal(r.data.collections.length, 1);
  assert.equal(r.data.collections[0].state, 'open');
  assert.equal(r.data.collections[0].itemCount, 3);

  // Swiping
  assert.equal((await bob('PUT', `/api/items/${lamp.id}/swipe`, { liked: 'yes' })).status, 400);
  await bob('PUT', `/api/items/${lamp.id}/swipe`, { liked: true });
  await bob('PUT', `/api/items/${chair.id}/swipe`, { liked: true });
  await bob('PUT', `/api/items/${plant.id}/swipe`, { liked: false });
  await cat('PUT', `/api/items/${lamp.id}/swipe`, { liked: true });
  await cat('PUT', `/api/items/${chair.id}/swipe`, { liked: true });
  await cat('PUT', `/api/items/${plant.id}/swipe`, { liked: true });
  // Undo then change mind
  await cat('DELETE', `/api/items/${plant.id}/swipe`);
  r = await cat('GET', `/api/collections/${cid}`);
  assert.equal(r.data.items.find((i) => i.id === plant.id).swipe, null);
  await cat('PUT', `/api/items/${plant.id}/swipe`, { liked: true });

  r = await admin('GET', `/api/admin/collections/${cid}`);
  assert.equal(r.data.items.find((i) => i.id === lamp.id).likes, 2);
  assert.equal(r.data.members.length, 2);

  // Timer expires
  srv.advance(3 * HOUR);
  assert.equal((await bob('PUT', `/api/items/${lamp.id}/swipe`, { liked: false })).status, 409);

  const bobView = (await bob('GET', `/api/collections/${cid}`)).data;
  const catView = (await cat('GET', `/api/collections/${cid}`)).data;
  assert.equal(bobView.collection.state, 'closed');
  const won = (view) => view.items.filter((i) => i.won).map((i) => i.title).sort();
  // Chair has 2 units -> both. Plant only Cat. Lamp contested -> goes to Bob (fewer items).
  assert.deepEqual(won(bobView), ['Chair', 'Lamp']);
  assert.deepEqual(won(catView), ['Chair', 'Plant']);

  r = await admin('GET', `/api/admin/collections/${cid}`);
  assert.equal(r.data.allocations.length, 4);
  const alloc = r.data.allocations.find((a) => a.itemTitle === 'Lamp');
  await admin('PATCH', `/api/admin/allocations/${alloc.id}`, { collected: true });
  r = await bob('GET', `/api/collections/${cid}`);
  assert.equal(r.data.items.find((i) => i.id === lamp.id).collected, true);

  // Extending the deadline re-opens it and clears results
  await admin('PATCH', `/api/admin/collections/${cid}`, { expiresAt: srv.now() + HOUR });
  r = await bob('GET', `/api/collections/${cid}`);
  assert.equal(r.data.collection.state, 'open');
  assert.equal(r.data.items.some((i) => i.won), false);

  // Close now finalizes immediately
  r = await admin('POST', `/api/admin/collections/${cid}/close`);
  assert.equal(r.data.collection.state, 'closed');
  assert.equal((await admin('GET', `/api/admin/collections/${cid}`)).data.allocations.length, 4);
});

test('auth and CSRF protections', async (t) => {
  const srv = await startServer();
  t.after(srv.close);
  const admin = srv.client();
  await admin('POST', '/api/setup', { name: 'Ada', email: 'ada@example.com', password: 'supersecret' });

  const anon = srv.client();
  assert.equal((await anon('GET', '/api/collections')).status, 401);
  assert.equal((await anon('POST', '/api/login', { email: 'ada@example.com', password: 'nope' })).status, 401);
  assert.equal((await anon('POST', '/api/login', { email: 'ADA@example.com', password: 'supersecret' })).status, 200);

  const res = await fetch(srv.base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'ada@example.com', password: 'supersecret' }),
  });
  assert.equal(res.status, 403, 'mutations without the custom header are rejected');

  await admin('POST', '/api/logout');
  assert.equal((await admin('GET', '/api/me')).status, 401);
});

test('non-members cannot see or swipe a collection', async (t) => {
  const srv = await startServer();
  t.after(srv.close);
  const admin = srv.client();
  await admin('POST', '/api/setup', { name: 'Ada', email: 'ada@example.com', password: 'supersecret' });
  const { data } = await admin('POST', '/api/admin/collections', {
    name: 'Secret',
    expiresAt: srv.now() + HOUR,
    published: true,
  });
  const item = (await admin('POST', `/api/admin/collections/${data.collection.id}/items`, { title: 'Thing' })).data.item;
  const invite = (await admin('POST', '/api/admin/users', { name: 'Zed', email: 'zed@example.com' })).data.user;
  const zed = srv.client();
  await zed('POST', `/api/invites/${invite.inviteUrl.split('/invite/')[1]}`, { password: 'zedpassword' });

  assert.equal((await zed('GET', `/api/collections/${data.collection.id}`)).status, 404);
  assert.equal((await zed('PUT', `/api/items/${item.id}/swipe`, { liked: true })).status, 404);
});
