import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, HOUR } from './helpers.js';

/** An admin (the platform owner) plus two people who signed up themselves. */
async function world(opts) {
  const srv = setup(opts);
  const admin = srv.client();
  await admin('POST', '/api/setup', { name: 'Ada', email: 'ada@example.com', password: 'supersecret' });
  const signup = async (name) => {
    const c = srv.client();
    const r = await c('POST', '/api/signup', { name, email: `${name.toLowerCase()}@example.com`, password: `${name}password` });
    assert.equal(r.status, 201, r.data?.error);
    return { c, id: r.data.user.id };
  };
  return { srv, admin, anna: await signup('Anna'), bob: await signup('Bob') };
}

/** Anna's collection with one item, closed after her invitee liked it. */
async function annasCollection(w) {
  const cid = (await w.anna.c('POST', '/api/admin/collections', { name: 'Anna stuff', expiresAt: w.srv.now() + HOUR, published: true })).data.collection.id;
  const item = (await w.anna.c('POST', `/api/admin/collections/${cid}/items`, { title: 'Lamp' })).data.item;
  return { cid, item };
}

test('anyone can sign up and create collections', async () => {
  const w = await world();
  const r = await w.anna.c('GET', '/api/me');
  assert.equal(r.data.user.role, 'creator');
  const created = await w.anna.c('POST', '/api/admin/collections', { name: 'Mine', expiresAt: w.srv.now() + HOUR });
  assert.equal(created.status, 201);

  // Same email twice is refused; bad email too
  const c = w.srv.client();
  assert.equal((await c('POST', '/api/signup', { name: 'X', email: 'ANNA@example.com', password: 'whatever123' })).status, 409);
  assert.equal((await c('POST', '/api/signup', { name: 'X', email: 'nope', password: 'whatever123' })).status, 400);
  assert.equal((await c('POST', '/api/signup', { name: 'X', email: 'x@example.com', password: 'short' })).status, 400);
});

test('sign-ups are throttled per hour', async () => {
  const w = await world({ env: { SIGNUPS_PER_HOUR: '4' } });
  const c = w.srv.client();
  assert.equal((await c('POST', '/api/signup', { name: 'C', email: 'c@example.com', password: 'cpassword1' })).status, 201);
  assert.equal((await c('POST', '/api/signup', { name: 'D', email: 'd@example.com', password: 'dpassword1' })).status, 429);
  w.srv.advance(2 * HOUR);
  assert.equal((await c('POST', '/api/signup', { name: 'D', email: 'd@example.com', password: 'dpassword1' })).status, 201);
});

test('with TURNSTILE_SECRET set, sign-up needs a valid bot check', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => (globalThis.fetch = realFetch));
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('turnstile')) {
      const ok = init.body.get('response') === 'good-token' && init.body.get('secret') === 's3cret';
      return new Response(JSON.stringify({ success: ok }), { headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(url, init);
  };
  const w = await world({ env: { TURNSTILE_SECRET: 's3cret' } }).catch((e) => e);
  // world() signs up without a token, so it must fail
  assert.ok(w instanceof Error);
  const srv = setup({ env: { TURNSTILE_SECRET: 's3cret' } });
  const c = srv.client();
  const body = { name: 'E', email: 'e@example.com', password: 'epassword1' };
  assert.equal((await c('POST', '/api/signup', body)).status, 400);
  assert.equal((await c('POST', '/api/signup', { ...body, turnstileToken: 'bad' })).status, 400);
  assert.equal((await c('POST', '/api/signup', { ...body, turnstileToken: 'good-token' })).status, 201);
});

test('a collection is only visible to its owner, co-managers and invitees', async () => {
  const w = await world();
  const { cid } = await annasCollection(w);
  // Bob (a stranger) can't see or touch it
  assert.deepEqual((await w.bob.c('GET', '/api/admin/collections')).data.collections, []);
  assert.equal((await w.bob.c('GET', `/api/admin/collections/${cid}`)).status, 404);
  assert.equal((await w.bob.c('GET', `/api/collections/${cid}`)).status, 404);
  assert.equal((await w.bob.c('POST', `/api/admin/collections/${cid}/items`, { title: 'Sneaky' })).status, 404);
  // The admin sees everything
  assert.equal((await w.admin('GET', '/api/admin/collections')).data.collections.length, 1);
  assert.equal((await w.admin('GET', `/api/admin/collections/${cid}`)).status, 200);
  // Once invited, Bob can swipe on it, but not manage it
  await w.anna.c('POST', '/api/admin/users', { name: 'Bob', email: 'bob@example.com', collectionIds: [cid] });
  assert.equal((await w.bob.c('GET', `/api/collections/${cid}`)).status, 200);
  assert.equal((await w.bob.c('GET', `/api/admin/collections/${cid}`)).status, 404);
});

test('inviting: new people get a link, existing accounts are simply added', async () => {
  const w = await world();
  const { cid } = await annasCollection(w);
  // New person: an invite link, visible to Anna (who invited) but not to others
  let r = await w.anna.c('POST', '/api/admin/users', { name: 'Cleo', email: 'cleo@example.com', collectionIds: [cid] });
  assert.equal(r.status, 201);
  assert.equal(r.data.existing, false);
  assert.ok(r.data.user.inviteToken);
  const cleo = w.srv.client();
  assert.equal((await cleo('POST', `/api/invites/${r.data.user.inviteToken}`, { password: 'cleopassword' })).status, 200);
  assert.equal((await cleo('GET', '/api/collections')).data.collections[0].name, 'Anna stuff');
  assert.equal((await cleo('GET', '/api/me')).data.user.role, 'creator', 'invited people can make collections too');

  // Existing account: added, no new account or link; trying to set a role is ignored
  r = await w.anna.c('POST', '/api/admin/users', { name: 'Whoever', email: 'BOB@example.com', collectionIds: [cid], role: 'admin' });
  assert.equal(r.status, 200);
  assert.equal(r.data.existing, true);
  assert.equal(r.data.user.inviteToken, null);
  assert.equal((await w.bob.c('GET', '/api/me')).data.user.role, 'creator');

  // Non-admins must invite into a collection they manage
  assert.equal((await w.bob.c('POST', '/api/admin/users', { name: 'Z', email: 'z@example.com' })).status, 400);
  assert.equal((await w.bob.c('POST', '/api/admin/users', { name: 'Z', email: 'z@example.com', collectionIds: [cid] })).status, 404);
});

test('people only see users they invited or share a collection they manage with', async () => {
  const w = await world();
  const { cid } = await annasCollection(w);
  await w.anna.c('POST', '/api/admin/users', { name: 'Cleo', email: 'cleo@example.com', collectionIds: [cid] });
  const names = async (c) => (await c('GET', '/api/admin/users')).data.users.map((u) => u.name).sort();
  assert.deepEqual(await names(w.anna.c), ['Anna', 'Cleo']);
  assert.deepEqual(await names(w.bob.c), ['Bob'], 'Bob knows nobody');
  assert.deepEqual(await names(w.admin), ['Ada', 'Anna', 'Bob', 'Cleo']);
  // Only admins manage accounts
  const cleoId = (await w.anna.c('GET', '/api/admin/users')).data.users.find((u) => u.name === 'Cleo').id;
  assert.equal((await w.anna.c('PATCH', `/api/admin/users/${cleoId}`, { name: 'X' })).status, 403);
  assert.equal((await w.anna.c('DELETE', `/api/admin/users/${cleoId}`)).status, 403);
  assert.equal((await w.anna.c('POST', `/api/admin/users/${cleoId}/invite`)).status, 403);
});

test('owners have full control over their own collection', async () => {
  const w = await world();
  const { cid, item } = await annasCollection(w);
  const { data } = await w.anna.c('POST', '/api/admin/users', { name: 'Bob', email: 'bob@example.com', collectionIds: [cid] });
  assert.equal(data.existing, true);
  await w.bob.c('PUT', `/api/items/${item.id}/swipe`, { liked: true });
  let r = (await w.anna.c('GET', `/api/admin/collections/${cid}`)).data;
  assert.equal(r.access, 'owner');
  assert.deepEqual(r.choices.map((c) => c.liked), [true], 'sees who chose what');
  assert.equal(r.canDelete, true);
  assert.equal(r.canReopen, true);
  await w.anna.c('POST', `/api/admin/collections/${cid}/close`);
  r = (await w.anna.c('GET', `/api/admin/collections/${cid}`)).data;
  assert.equal(r.allocations[0].userName, 'Bob');
  // Allocation tools
  assert.equal((await w.anna.c('PATCH', `/api/admin/allocations/${r.allocations[0].id}`, { collected: true })).status, 200);
  assert.equal((await w.anna.c('POST', `/api/admin/collections/${cid}/reallocate`, { onlyFree: true })).status, 200);
  assert.equal((await w.anna.c('GET', `/api/admin/collections/${cid}/allocation/versions`)).status, 200);
  assert.equal((await w.anna.c('POST', `/api/admin/collections/${cid}/allocation/reset`)).status, 200);
  assert.equal((await w.anna.c('PUT', `/api/admin/collections/${cid}/choices`, { userId: w.bob.id, itemId: item.id, liked: false })).status, 200);
  assert.equal((await w.anna.c('POST', `/api/admin/collections/${cid}/reopen`, { expiresAt: w.srv.now() + HOUR })).status, 200);
  assert.equal((await w.anna.c('DELETE', `/api/admin/collections/${cid}`)).status, 200);
  // Strangers can't use any of it
  assert.equal((await w.bob.c('POST', `/api/admin/collections/${cid}/reallocate`, {})).status, 404);
});

test('owners can make participants co-managers, who can do everything except delete, reopen or pick co-managers', async () => {
  const w = await world();
  const { cid } = await annasCollection(w);
  // Only participants can become co-managers
  assert.equal((await w.anna.c('PUT', `/api/admin/collections/${cid}/editors`, { userIds: [w.bob.id] })).status, 400);
  await w.anna.c('POST', '/api/admin/users', { name: 'Bob', email: 'bob@example.com', collectionIds: [cid] });
  assert.equal((await w.anna.c('PUT', `/api/admin/collections/${cid}/editors`, { userIds: [w.bob.id] })).status, 200);

  const r = await w.bob.c('GET', '/api/admin/collections');
  assert.deepEqual(r.data.collections.map((c) => [c.name, c.sharedWithMe]), [['Anna stuff', true]]);
  const d = (await w.bob.c('GET', `/api/admin/collections/${cid}`)).data;
  assert.equal(d.access, 'editor');
  assert.equal(d.canDelete, false);
  assert.equal(d.canManageEditors, false);
  assert.equal(d.canReopen, false);
  assert.equal((await w.bob.c('POST', `/api/admin/collections/${cid}/items`, { title: 'From Bob' })).status, 201);
  await w.bob.c('POST', `/api/admin/collections/${cid}/close`);
  assert.equal((await w.bob.c('POST', `/api/admin/collections/${cid}/reallocate`, {})).status, 200);
  assert.equal((await w.bob.c('DELETE', `/api/admin/collections/${cid}`)).status, 403);
  assert.equal((await w.bob.c('PUT', `/api/admin/collections/${cid}/editors`, { userIds: [] })).status, 403);
  assert.equal((await w.bob.c('POST', `/api/admin/collections/${cid}/reopen`, { expiresAt: w.srv.now() + HOUR })).status, 403);
});

test('admins can block and unblock accounts', async () => {
  const w = await world();
  const bobId = w.bob.id;
  assert.equal((await w.admin('PATCH', `/api/admin/users/${bobId}`, { blocked: true })).data.user.blocked, true);
  assert.equal((await w.bob.c('GET', '/api/me')).status, 401, 'signed out everywhere');
  const again = w.srv.client();
  assert.equal((await again('POST', '/api/login', { email: 'bob@example.com', password: 'Bobpassword' })).status, 403);
  await w.admin('PATCH', `/api/admin/users/${bobId}`, { blocked: false });
  assert.equal((await again('POST', '/api/login', { email: 'bob@example.com', password: 'Bobpassword' })).status, 200);
  // Admins can't block themselves or drop their own admin role
  const me = (await w.admin('GET', '/api/me')).data.user.id;
  assert.equal((await w.admin('PATCH', `/api/admin/users/${me}`, { blocked: true })).status, 400);
  assert.equal((await w.admin('PATCH', `/api/admin/users/${me}`, { role: 'creator' })).status, 400);
  // Making someone admin
  assert.equal((await w.admin('PATCH', `/api/admin/users/${bobId}`, { role: 'admin' })).data.user.role, 'admin');
});

test('co-managers can be set to manage only, without liking', async () => {
  const w = await world();
  const { cid, item } = await annasCollection(w);
  await w.anna.c('POST', '/api/admin/users', { name: 'Bob', email: 'bob@example.com', collectionIds: [cid] });
  await w.bob.c('PUT', `/api/items/${item.id}/swipe`, { liked: true });
  assert.equal((await w.anna.c('PUT', `/api/admin/collections/${cid}/editors`, { editors: [{ id: w.bob.id, canLike: false }] })).status, 200);

  let d = (await w.anna.c('GET', `/api/admin/collections/${cid}`)).data;
  assert.deepEqual(d.editors.map((e) => [e.name, e.canLike]), [['Bob', false]]);
  assert.equal(d.members.find((m) => m.id === w.bob.id).canLike, false);
  // Bob can still manage it, but not swipe on it
  assert.equal((await w.bob.c('GET', `/api/admin/collections/${cid}`)).status, 200);
  assert.deepEqual((await w.bob.c('GET', '/api/collections')).data.collections, []);
  assert.equal((await w.bob.c('GET', `/api/collections/${cid}`)).status, 404);
  assert.equal((await w.bob.c('PUT', `/api/items/${item.id}/swipe`, { liked: true })).status, 404);
  assert.equal((await w.anna.c('PUT', `/api/admin/collections/${cid}/choices`, { userId: w.bob.id, itemId: item.id, liked: true })).status, 400);
  // His earlier like doesn't count
  await w.anna.c('POST', `/api/admin/collections/${cid}/close`);
  d = (await w.anna.c('GET', `/api/admin/collections/${cid}`)).data;
  assert.deepEqual(d.allocations, []);

  // Switched back on: he can like again; the plain userIds form keeps likes on
  await w.anna.c('PUT', `/api/admin/collections/${cid}/editors`, { userIds: [w.bob.id] });
  d = (await w.anna.c('GET', `/api/admin/collections/${cid}`)).data;
  assert.equal(d.editors[0].canLike, true);
  assert.equal((await w.anna.c('POST', `/api/admin/collections/${cid}/reallocate`, {})).status, 200);
  d = (await w.anna.c('GET', `/api/admin/collections/${cid}`)).data;
  assert.deepEqual(d.allocations.map((a) => a.userName), ['Bob']);
});
