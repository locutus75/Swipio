import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, HOUR } from './helpers.js';

const DAY = 24 * HOUR;

async function world() {
  const srv = setup();
  const admin = srv.client();
  await admin('POST', '/api/setup', { name: 'Ada', email: 'ada@example.com', password: 'supersecret' });
  const anna = srv.client();
  const r = await anna('POST', '/api/signup', { name: 'Anna', email: 'anna@example.com', password: 'annapassword' });
  return { srv, admin, anna, annaId: r.data.user.id };
}

const photo = (kb) => new File([new Uint8Array(kb * 1024)], 'p.jpg', { type: 'image/jpeg' });
const withPhoto = (title, kb) => {
  const fd = new FormData();
  fd.set('title', title);
  fd.set('image', photo(kb));
  return fd;
};

test('plans start without limits; only admins can change them', async () => {
  const w = await world();
  const { plans, myLimits } = (await w.anna('GET', '/api/plans')).data;
  assert.deepEqual(plans.map((p) => p.name), ['Free', 'Plus', 'Max', 'Ultra']);
  assert.equal(myLimits.plan, 'free');
  assert.equal(myLimits.maxItems, null);
  assert.equal((await w.anna('PUT', '/api/admin/plans/free', { maxItems: 1 })).status, 403);
  assert.equal((await w.admin('PUT', '/api/admin/plans/free', { maxItems: 0 })).status, 400);
  assert.equal((await w.admin('PUT', '/api/admin/plans/free', { maxPhotoKb: 5000 })).status, 400, 'above the hard photo limit');
  const r = await w.admin('PUT', '/api/admin/plans/free', { maxItems: 2, maxPeople: '', name: 'Basic' });
  assert.deepEqual([r.data.plan.name, r.data.plan.maxItems, r.data.plan.maxPeople], ['Basic', 2, null]);
  assert.equal((await w.admin('PUT', '/api/admin/plans/nope', {})).status, 404);
});

test('limits on items, people, photo size and deadline follow the plan of whoever made the collection', async () => {
  const w = await world();
  await w.admin('PUT', '/api/admin/plans/free', { maxItems: 2, maxPeople: 1, maxPhotoKb: 10, maxSwipeDays: 7 });
  // Deadline
  assert.equal((await w.anna('POST', '/api/admin/collections', { name: 'Far', expiresAt: w.srv.now() + 8 * DAY })).status, 403);
  const cid = (await w.anna('POST', '/api/admin/collections', { name: 'Near', expiresAt: w.srv.now() + 7 * DAY })).data.collection.id;
  assert.equal((await w.anna('PATCH', `/api/admin/collections/${cid}`, { expiresAt: w.srv.now() + 30 * DAY })).status, 403);
  // Photo size
  assert.equal((await w.anna('POST', `/api/admin/collections/${cid}/items`, withPhoto('Big', 11))).status, 413);
  assert.equal((await w.anna('POST', `/api/admin/collections/${cid}/items`, withPhoto('Small', 9))).status, 201);
  // Items
  assert.equal((await w.anna('POST', `/api/admin/collections/${cid}/items`, { title: 'Two' })).status, 201);
  const full = await w.anna('POST', `/api/admin/collections/${cid}/items`, { title: 'Three' });
  assert.equal(full.status, 403);
  assert.match(full.data.error, /at most 2 items on the Free plan/);
  // People (the maker doesn't count; re-inviting someone already listed is fine)
  assert.equal((await w.anna('POST', '/api/admin/users', { name: 'Bo', email: 'bo@example.com', collectionIds: [cid] })).status, 201);
  assert.equal((await w.anna('POST', '/api/admin/users', { name: 'Bo', email: 'bo@example.com', collectionIds: [cid] })).status, 200);
  assert.equal((await w.anna('POST', '/api/admin/users', { name: 'Cy', email: 'cy@example.com', collectionIds: [cid] })).status, 403);
  // The collection view tells the managers
  const d = (await w.anna('GET', `/api/admin/collections/${cid}`)).data;
  assert.deepEqual([d.limits.planName, d.limits.maxItems, d.limits.maxPeople], ['Free', 2, 1]);

  // Moving Anna to Plus (no limits yet) lifts them; existing content is never removed
  await w.admin('PATCH', `/api/admin/users/${w.annaId}`, { plan: 'plus' });
  assert.equal((await w.anna('GET', '/api/me')).data.user.plan, 'plus');
  assert.equal((await w.anna('POST', `/api/admin/collections/${cid}/items`, { title: 'Three' })).status, 201);
  assert.equal((await w.admin('PATCH', `/api/admin/users/${w.annaId}`, { plan: 'gold' })).status, 400);
  // Back to Free: over the limit, so nothing more can be added, but nothing is lost
  await w.admin('PATCH', `/api/admin/users/${w.annaId}`, { plan: 'free' });
  assert.equal((await w.anna('POST', `/api/admin/collections/${cid}/items`, { title: 'Four' })).status, 403);
  assert.equal((await w.anna('GET', `/api/admin/collections/${cid}`)).data.items.length, 3);

  // Admins' own collections have no limits
  const aid = (await w.admin('POST', '/api/admin/collections', { name: 'Admin', expiresAt: w.srv.now() + 60 * DAY })).data.collection.id;
  for (const t of ['a', 'b', 'c']) assert.equal((await w.admin('POST', `/api/admin/collections/${aid}/items`, { title: t })).status, 201);
});

test('closed collections are deleted after the plan says so', async () => {
  const w = await world();
  const make = async (c, name) => {
    const id = (await c('POST', '/api/admin/collections', { name, expiresAt: w.srv.now() + HOUR, published: true })).data.collection.id;
    await c('POST', `/api/admin/collections/${id}/close`);
    return id;
  };
  const annas = await make(w.anna, 'Anna old');
  const admins = await make(w.admin, 'Admin old');
  const open = (await w.anna('POST', '/api/admin/collections', { name: 'Open', expiresAt: w.srv.now() + 30 * DAY, published: true })).data.collection.id;
  await w.admin('PUT', '/api/admin/plans/free', { deleteAfterDays: 3 });

  const d = (await w.anna('GET', `/api/admin/collections/${annas}`)).data;
  assert.equal(d.deletesAt, w.srv.now() + 3 * DAY);
  w.srv.advance(2 * DAY);
  assert.equal(await w.srv.api.deleteExpired(w.srv.env.DB), 0);
  w.srv.advance(1 * DAY + 1);
  await w.srv.api.scheduled({}, w.srv.env);
  assert.equal((await w.anna('GET', `/api/admin/collections/${annas}`)).status, 404, 'deleted');
  assert.equal((await w.admin('GET', `/api/admin/collections/${admins}`)).status, 200, "admins' collections stay");
  assert.equal((await w.anna('GET', `/api/admin/collections/${open}`)).status, 200, 'open collections stay');
});
