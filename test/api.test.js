import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, HOUR, ORIGIN } from './helpers.js';

test('full flow: setup, invite, swipe, expire, collect', async () => {
  const srv = setup();
  const admin = srv.client();

  // First run setup
  assert.equal((await admin('GET', '/api/setup')).data.needsSetup, true);
  let r = await admin('POST', '/api/setup', { name: 'Ada', email: 'ada@example.com', password: 'supersecret' });
  assert.equal(r.status, 201);
  assert.equal(r.data.user.role, 'admin');
  assert.ok(r.data.token);
  r = await srv.client()('POST', '/api/setup', { name: 'Eve', email: 'eve@example.com', password: 'supersecret' });
  assert.equal(r.status, 409, 'setup can only run once');

  // Collection with items
  r = await admin('POST', '/api/admin/collections', { name: 'Giveaway', expiresAt: srv.now() + 2 * HOUR });
  assert.equal(r.status, 201);
  const cid = r.data.collection.id;
  assert.equal(r.data.collection.state, 'draft');

  const fd = new FormData();
  fd.set('title', 'Lamp');
  fd.set('quantity', '1');
  fd.set('image', new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/jpeg' }), 'lamp.jpg');
  r = await admin('POST', `/api/admin/collections/${cid}/items`, fd);
  assert.equal(r.status, 201);
  const lamp = r.data.item;
  assert.match(lamp.image, /^\/api\/images\/\d+$/);
  r = await admin('GET', lamp.image);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Content-Type'), 'image/jpeg');
  assert.deepEqual([...new Uint8Array(r.data)], [1, 2, 3, 4]);

  const bad = new FormData();
  bad.set('title', 'Script');
  bad.set('image', new Blob(['<svg/>'], { type: 'image/svg+xml' }), 'x.svg');
  assert.equal((await admin('POST', `/api/admin/collections/${cid}/items`, bad)).status, 400);

  r = await admin('POST', `/api/admin/collections/${cid}/items`, { title: 'Chair', quantity: 2 });
  const chair = r.data.item;
  r = await admin('POST', `/api/admin/collections/${cid}/items`, { title: 'Plant', imageUrl: 'https://example.com/p.jpg' });
  const plant = r.data.item;
  assert.equal(plant.image, 'https://example.com/p.jpg');

  // Invite two people straight into the collection
  r = await admin('POST', '/api/admin/users', { name: 'Bob', email: 'bob@example.com', collectionIds: [cid] });
  assert.equal(r.status, 201);
  assert.equal(r.data.user.status, 'invited');
  const bobToken = r.data.user.inviteToken;
  r = await admin('POST', '/api/admin/users', { name: 'Cat', email: 'cat@example.com', collectionIds: [cid] });
  const catToken = r.data.user.inviteToken;
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

  // Deleting the collection removes its uploaded images too
  await admin('DELETE', `/api/admin/collections/${cid}`);
  assert.equal((await admin('GET', lamp.image)).status, 404);
});

test('the cron trigger closes expired collections', async () => {
  const srv = setup();
  const admin = srv.client();
  await admin('POST', '/api/setup', { name: 'Ada', email: 'ada@example.com', password: 'supersecret' });
  const { data } = await admin('POST', '/api/admin/collections', { name: 'C', expiresAt: srv.now() + HOUR, published: true });
  srv.advance(2 * HOUR);
  await srv.api.scheduled({}, srv.env);
  const row = await srv.env.DB.prepare('SELECT finalized_at FROM collections WHERE id = ?').bind(data.collection.id).first();
  assert.equal(row.finalized_at, srv.now());
});

test('auth and CORS', async () => {
  const srv = setup();
  const admin = srv.client();
  await admin('POST', '/api/setup', { name: 'Ada', email: 'ada@example.com', password: 'supersecret' });

  const anon = srv.client();
  assert.equal((await anon('GET', '/api/collections')).status, 401);
  assert.equal((await anon('POST', '/api/login', { email: 'ada@example.com', password: 'nope' })).status, 401);
  const r = await anon('POST', '/api/login', { email: 'ADA@example.com', password: 'supersecret' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), ORIGIN);

  // A forged token gets nowhere
  const res = await srv.api.fetch(
    new Request('https://api.test/api/me', { headers: { Authorization: 'Bearer forged' } }),
    srv.env
  );
  assert.equal(res.status, 401);

  // Preflight from an unknown site gets no CORS headers
  const pre = await srv.api.fetch(
    new Request('https://api.test/api/login', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }),
    srv.env
  );
  assert.equal(pre.headers.get('Access-Control-Allow-Origin'), null);

  await admin('POST', '/api/logout');
  assert.equal((await admin('GET', '/api/me')).status, 401);
});

test('non-members cannot see or swipe a collection', async () => {
  const srv = setup();
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
  await zed('POST', `/api/invites/${invite.inviteToken}`, { password: 'zedpassword' });

  assert.equal((await zed('GET', `/api/collections/${data.collection.id}`)).status, 404);
  assert.equal((await zed('PUT', `/api/items/${item.id}/swipe`, { liked: true })).status, 404);
});
