import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, HOUR } from './helpers.js';

/** Creates an admin plus one signed-in client per role. */
async function team() {
  const srv = setup();
  const admin = srv.client();
  await admin('POST', '/api/setup', { name: 'Ada', email: 'ada@example.com', password: 'supersecret' });
  const join = async (name, role) => {
    const { data } = await admin('POST', '/api/admin/users', { name, email: `${name.toLowerCase()}@example.com`, role });
    const client = srv.client();
    await client('POST', `/api/invites/${data.user.inviteToken}`, { password: `${name}password` });
    return { client, id: data.user.id };
  };
  return {
    srv,
    admin,
    manager: await join('Mia', 'manager'),
    creator: await join('Cas', 'creator'),
    creator2: await join('Kim', 'creator'),
    participant: await join('Pim', 'participant'),
  };
}

test('/api/me reports the role', async () => {
  const t = await team();
  assert.equal((await t.admin('GET', '/api/me')).data.user.role, 'admin');
  assert.equal((await t.manager.client('GET', '/api/me')).data.user.role, 'manager');
  assert.equal((await t.creator.client('GET', '/api/me')).data.user.role, 'creator');
  assert.equal((await t.participant.client('GET', '/api/me')).data.user.role, 'participant');
});

test('participants cannot use any management endpoint', async () => {
  const t = await team();
  const p = t.participant.client;
  assert.equal((await p('GET', '/api/admin/collections')).status, 403);
  assert.equal((await p('POST', '/api/admin/collections', { name: 'X', expiresAt: t.srv.now() + HOUR })).status, 403);
  assert.equal((await p('GET', '/api/admin/users')).status, 403);
});

test('creators run their own collections only, and cannot see who chose what', async () => {
  const t = await team();
  const cas = t.creator.client;
  let r = await cas('POST', '/api/admin/collections', { name: 'Cas stuff', expiresAt: t.srv.now() + HOUR });
  assert.equal(r.status, 201);
  const cid = r.data.collection.id;
  const item = (await cas('POST', `/api/admin/collections/${cid}/items`, { title: 'Lamp' })).data.item;
  const other = (await t.creator2.client('POST', '/api/admin/collections', { name: 'Kim stuff', expiresAt: t.srv.now() + HOUR })).data.collection;

  // Only their own collection is listed and reachable
  assert.deepEqual((await cas('GET', '/api/admin/collections')).data.collections.map((c) => c.name), ['Cas stuff']);
  assert.equal((await cas('GET', `/api/admin/collections/${other.id}`)).status, 404);
  assert.equal((await cas('PATCH', `/api/admin/collections/${other.id}`, { name: 'Mine now' })).status, 404);
  assert.equal((await cas('POST', `/api/admin/collections/${other.id}/items`, { title: 'Sneaky' })).status, 404);

  // They can pick participants from existing users, but not see invite links or invite anyone
  r = await cas('GET', '/api/admin/users');
  assert.equal(r.status, 200);
  assert.ok(r.data.users.every((u) => u.inviteToken === null));
  assert.equal((await cas('PUT', `/api/admin/collections/${cid}/members`, { userIds: [t.participant.id] })).status, 200);
  assert.equal((await cas('POST', '/api/admin/users', { name: 'New', email: 'new@example.com' })).status, 403);
  assert.equal((await cas('PATCH', `/api/admin/users/${t.participant.id}`, { role: 'creator' })).status, 403);

  // The participant swipes; the creator sees totals but not who liked what
  await cas('PATCH', `/api/admin/collections/${cid}`, { published: true });
  await t.participant.client('PUT', `/api/items/${item.id}/swipe`, { liked: true });
  r = await cas('GET', `/api/admin/collections/${cid}`);
  assert.equal(r.data.seeChoices, false);
  assert.equal(r.data.items[0].likes, 1);
  assert.deepEqual(r.data.choices, []);

  // After closing: allocation counts per item, but no per-person results or pickup ticking
  await cas('POST', `/api/admin/collections/${cid}/close`);
  r = await cas('GET', `/api/admin/collections/${cid}`);
  assert.equal(r.data.items[0].allocated, 1);
  assert.deepEqual(r.data.allocations, []);
  const alloc = (await t.manager.client('GET', `/api/admin/collections/${cid}`)).data.allocations[0];
  assert.equal((await cas('PATCH', `/api/admin/allocations/${alloc.id}`, { collected: true })).status, 403);
});

test('managers see every collection and who chose what', async () => {
  const t = await team();
  const { data } = await t.creator.client('POST', '/api/admin/collections', { name: 'Cas stuff', expiresAt: t.srv.now() + HOUR, published: true });
  const cid = data.collection.id;
  const item = (await t.creator.client('POST', `/api/admin/collections/${cid}/items`, { title: 'Lamp' })).data.item;
  await t.creator.client('PUT', `/api/admin/collections/${cid}/members`, { userIds: [t.participant.id] });
  await t.participant.client('PUT', `/api/items/${item.id}/swipe`, { liked: true });

  const mia = t.manager.client;
  let r = await mia('GET', '/api/admin/collections');
  assert.equal(r.data.collections[0].createdBy.name, 'Cas');
  r = await mia('GET', `/api/admin/collections/${cid}`);
  assert.equal(r.data.seeChoices, true);
  assert.deepEqual(r.data.choices, [{ userId: t.participant.id, itemId: item.id, liked: true }]);
  // ...and can manage it like its creator
  assert.equal((await mia('PATCH', `/api/admin/collections/${cid}`, { name: 'Renamed' })).status, 200);

  await mia('POST', `/api/admin/collections/${cid}/close`);
  r = await mia('GET', `/api/admin/collections/${cid}`);
  assert.equal(r.data.allocations[0].userName, 'Pim');
  assert.equal((await mia('PATCH', `/api/admin/allocations/${r.data.allocations[0].id}`, { collected: true })).status, 200);
});

test('managers manage users up to their own role; only admins handle admins', async () => {
  const t = await team();
  const mia = t.manager.client;
  const adminId = (await t.admin('GET', '/api/me')).data.user.id;

  let r = await mia('POST', '/api/admin/users', { name: 'Cre', email: 'cre@example.com', role: 'creator' });
  assert.equal(r.status, 201);
  assert.equal(r.data.user.role, 'creator');
  assert.ok(r.data.user.inviteToken);
  assert.equal((await mia('POST', '/api/admin/users', { name: 'Boss', email: 'boss@example.com', role: 'admin' })).status, 403);
  assert.equal((await mia('POST', '/api/admin/users', { name: 'Bad', email: 'bad@example.com', role: 'king' })).status, 400);

  assert.equal((await mia('PATCH', `/api/admin/users/${t.participant.id}`, { role: 'manager' })).status, 200);
  assert.equal((await mia('PATCH', `/api/admin/users/${t.creator.id}`, { role: 'admin' })).status, 403);
  assert.equal((await mia('PATCH', `/api/admin/users/${adminId}`, { name: 'Demoted' })).status, 403);
  assert.equal((await mia('POST', `/api/admin/users/${adminId}/invite`)).status, 403);
  assert.equal((await mia('DELETE', `/api/admin/users/${adminId}`)).status, 403);
  assert.equal((await mia('PATCH', `/api/admin/users/${t.manager.id}`, { role: 'participant' })).status, 400, 'no changing your own role');
  assert.equal((await mia('DELETE', `/api/admin/users/${t.creator2.id}`)).status, 200);

  // Admins can do all of it
  assert.equal((await t.admin('PATCH', `/api/admin/users/${t.manager.id}`, { role: 'admin' })).status, 200);
  assert.equal((await t.admin('GET', '/api/me')).data.user.role, 'admin');
});

test('the new role sticks after a password reset and login', async () => {
  const t = await team();
  const r = await t.admin('POST', `/api/admin/users/${t.creator.id}/invite`);
  const cas = t.srv.client();
  await cas('POST', `/api/invites/${r.data.user.inviteToken}`, { password: 'newpassword' });
  assert.equal((await cas('GET', '/api/me')).data.user.role, 'creator');
});

test("managers can let a creator co-manage someone else's collection", async () => {
  const t = await team();
  const cas = t.creator.client;
  const kim = t.creator2.client;
  const cid = (await cas('POST', '/api/admin/collections', { name: 'Cas stuff', expiresAt: t.srv.now() + HOUR })).data.collection.id;

  // Kim has no access yet, and creators can't hand out edit rights themselves
  assert.equal((await kim('GET', `/api/admin/collections/${cid}`)).status, 404);
  assert.equal((await cas('PUT', `/api/admin/collections/${cid}/editors`, { userIds: [t.creator2.id] })).status, 403);

  // Only creators can be editors: participants need the role first, managers already have access
  let r = await t.manager.client('PUT', `/api/admin/collections/${cid}/editors`, { userIds: [t.participant.id] });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Creator role first/);
  assert.equal((await t.manager.client('PUT', `/api/admin/collections/${cid}/editors`, { userIds: [t.manager.id] })).status, 400);

  r = await t.manager.client('PUT', `/api/admin/collections/${cid}/editors`, { userIds: [t.creator2.id] });
  assert.equal(r.status, 200);

  // Kim now sees it as shared, and can manage it...
  r = await kim('GET', '/api/admin/collections');
  assert.deepEqual(r.data.collections.map((c) => [c.name, c.sharedWithMe]), [['Cas stuff', true]]);
  r = await kim('GET', `/api/admin/collections/${cid}`);
  assert.deepEqual(r.data.editors.map((e) => e.name), ['Kim']);
  assert.equal(r.data.createdBy.name, 'Cas');
  assert.equal(r.data.canDelete, false);
  assert.equal(r.data.canManageEditors, false);
  assert.equal((await kim('POST', `/api/admin/collections/${cid}/items`, { title: 'From Kim' })).status, 201);
  assert.equal((await kim('PATCH', `/api/admin/collections/${cid}`, { name: 'Shared stuff' })).status, 200);
  assert.equal((await kim('PUT', `/api/admin/collections/${cid}/members`, { userIds: [t.participant.id] })).status, 200);
  // ...but not delete it or change who else may edit it
  assert.equal((await kim('DELETE', `/api/admin/collections/${cid}`)).status, 403);
  assert.equal((await kim('PUT', `/api/admin/collections/${cid}/editors`, { userIds: [] })).status, 403);
  assert.equal((await cas('GET', `/api/admin/collections/${cid}`)).data.canDelete, true);

  // Revoking takes access away again
  await t.admin('PUT', `/api/admin/collections/${cid}/editors`, { userIds: [] });
  assert.equal((await kim('GET', `/api/admin/collections/${cid}`)).status, 404);
  assert.deepEqual((await kim('GET', '/api/admin/collections')).data.collections, []);
});

test('an editor who is demoted to participant loses access', async () => {
  const t = await team();
  const cid = (await t.creator.client('POST', '/api/admin/collections', { name: 'C', expiresAt: t.srv.now() + HOUR })).data.collection.id;
  await t.manager.client('PUT', `/api/admin/collections/${cid}/editors`, { userIds: [t.creator2.id] });
  await t.manager.client('PATCH', `/api/admin/users/${t.creator2.id}`, { role: 'participant' });
  assert.equal((await t.creator2.client('GET', `/api/admin/collections/${cid}`)).status, 403);
});

test('admins can redo an allocation; picked-up items stay put by default', async () => {
  const t = await team();
  const { data } = await t.admin('POST', '/api/admin/collections', { name: 'Redo', expiresAt: t.srv.now() + HOUR, published: true });
  const cid = data.collection.id;
  const ids = [];
  for (const title of ['A', 'B', 'C', 'D', 'E', 'F']) ids.push((await t.admin('POST', `/api/admin/collections/${cid}/items`, { title })).data.item.id);
  // Two people both want all six single items: every item is contested.
  const p2 = await (async () => {
    const { data: d } = await t.admin('POST', '/api/admin/users', { name: 'Ole', email: 'ole@example.com' });
    const c = t.srv.client();
    await c('POST', `/api/invites/${d.user.inviteToken}`, { password: 'olepassword' });
    return { client: c, id: d.user.id };
  })();
  await t.admin('PUT', `/api/admin/collections/${cid}/members`, { userIds: [t.participant.id, p2.id] });
  for (const id of ids) {
    await t.participant.client('PUT', `/api/items/${id}/swipe`, { liked: true });
    await p2.client('PUT', `/api/items/${id}/swipe`, { liked: true });
  }

  // Not possible before the collection is allocated, and only for admins
  assert.equal((await t.admin('POST', `/api/admin/collections/${cid}/reallocate`)).status, 409);
  await t.admin('POST', `/api/admin/collections/${cid}/close`);
  assert.equal((await t.manager.client('POST', `/api/admin/collections/${cid}/reallocate`)).status, 403);

  const snapshot = async () =>
    (await t.admin('GET', `/api/admin/collections/${cid}`)).data.allocations.map((a) => `${a.itemTitle}:${a.userName}`).sort();
  let r = await t.admin('GET', `/api/admin/collections/${cid}`);
  assert.equal(r.data.allocations.length, 6);
  assert.equal(r.data.allocationRound, 0);
  const picked = r.data.allocations.find((a) => a.itemTitle === 'A');
  await t.admin('PATCH', `/api/admin/allocations/${picked.id}`, { collected: true });

  // Redo until the draw changes (it's random per round, so a few rounds is plenty)
  const before = await snapshot();
  let after = before;
  for (let i = 0; i < 10 && after.join() === before.join(); i++) {
    r = await t.admin('POST', `/api/admin/collections/${cid}/reallocate`, {});
    assert.equal(r.status, 200);
    assert.equal(r.data.kept, 1);
    after = await snapshot();
  }
  assert.notDeepEqual(after, before, 'a redo produces a new draw');
  assert.equal(after.length, 6, 'still every item handed out once');
  r = await t.admin('GET', `/api/admin/collections/${cid}`);
  const a = r.data.allocations.find((x) => x.itemTitle === 'A');
  assert.equal(`${a.userName}:${a.collected}`, `${picked.userName}:true`, 'picked-up item kept its person and status');
  assert.ok(r.data.allocationRound >= 1);
  // Fair split still holds: 3 each
  const per = {};
  r.data.allocations.forEach((x) => (per[x.userName] = (per[x.userName] || 0) + 1));
  assert.deepEqual(Object.values(per).sort(), [3, 3]);

  // Redo everything, including picked-up items
  r = await t.admin('POST', `/api/admin/collections/${cid}/reallocate`, { keepCollected: false });
  assert.equal(r.data.kept, 0);
  r = await t.admin('GET', `/api/admin/collections/${cid}`);
  assert.equal(r.data.allocations.filter((x) => x.collected).length, 0);
});

test('admins can take items away from someone and hand them to others', async () => {
  const t = await team();
  const { data } = await t.admin('POST', '/api/admin/collections', { name: 'Take', expiresAt: t.srv.now() + HOUR, published: true });
  const cid = data.collection.id;
  const bike = (await t.admin('POST', `/api/admin/collections/${cid}/items`, { title: 'Bike' })).data.item;
  const lamp = (await t.admin('POST', `/api/admin/collections/${cid}/items`, { title: 'Lamp' })).data.item;
  const ole = await (async () => {
    const { data: d } = await t.admin('POST', '/api/admin/users', { name: 'Ole', email: 'ole@example.com' });
    const c = t.srv.client();
    await c('POST', `/api/invites/${d.user.inviteToken}`, { password: 'olepassword' });
    return { client: c, id: d.user.id };
  })();
  await t.admin('PUT', `/api/admin/collections/${cid}/members`, { userIds: [t.participant.id, ole.id] });
  // Pim wants both; Ole only wants the bike.
  await t.participant.client('PUT', `/api/items/${bike.id}/swipe`, { liked: true });
  await t.participant.client('PUT', `/api/items/${lamp.id}/swipe`, { liked: true });
  await ole.client('PUT', `/api/items/${bike.id}/swipe`, { liked: true });
  await t.admin('POST', `/api/admin/collections/${cid}/close`);

  const results = async () => (await t.admin('GET', `/api/admin/collections/${cid}`)).data;
  const who = (d, title) => d.allocations.filter((a) => a.itemTitle === title).map((a) => a.userName);
  let d = await results();
  // Lamp only Pim wants -> Pim. Bike contested; Ole has fewer items -> Ole.
  assert.deepEqual(who(d, 'Lamp'), ['Pim']);
  assert.deepEqual(who(d, 'Bike'), ['Ole']);

  // Only admins
  const bikeAlloc = d.allocations.find((a) => a.itemTitle === 'Bike');
  assert.equal((await t.manager.client('POST', `/api/admin/collections/${cid}/release`, { allocationIds: [bikeAlloc.id] })).status, 403);
  // Not from another collection
  const other = (await t.admin('POST', '/api/admin/collections', { name: 'Other', expiresAt: t.srv.now() + HOUR })).data.collection;
  assert.equal((await t.admin('POST', `/api/admin/collections/${other.id}/release`, { allocationIds: [bikeAlloc.id] })).status, 404);

  // Take the bike away from Ole: it's free now and Ole is listed as removed
  assert.equal((await t.admin('POST', `/api/admin/collections/${cid}/release`, { allocationIds: [bikeAlloc.id] })).status, 200);
  d = await results();
  assert.deepEqual(who(d, 'Bike'), []);
  assert.deepEqual(d.removed.map((x) => `${x.userName}:${x.itemTitle}`), ['Ole:Bike']);
  assert.equal((await ole.client('GET', `/api/collections/${cid}`)).data.items.find((i) => i.id === bike.id).won, false);

  // Hand out only free items: the bike goes to Pim (Ole is skipped), the lamp stays with Pim
  const r = await t.admin('POST', `/api/admin/collections/${cid}/reallocate`, { onlyFree: true });
  assert.equal(r.data.allocated, 1);
  d = await results();
  assert.deepEqual(who(d, 'Bike'), ['Pim']);
  assert.deepEqual(who(d, 'Lamp'), ['Pim']);

  // Once handed out again, the take-away is forgotten
  assert.deepEqual(d.removed, []);

  // Undo works before handing out: take it away again, undo, and a full redo may give it to Ole (fewest items wins)
  await t.admin('POST', `/api/admin/collections/${cid}/release`, { allocationIds: [d.allocations.find((a) => a.itemTitle === 'Bike').id] });
  assert.equal((await t.admin('POST', `/api/admin/collections/${cid}/unrelease`, { userId: t.participant.id, itemId: bike.id })).status, 200);
  await t.admin('POST', `/api/admin/collections/${cid}/reallocate`, {});
  d = await results();
  assert.deepEqual(d.removed, []);
  assert.deepEqual(who(d, 'Bike'), ['Ole']);

  // Re-opening clears take-aways
  await t.admin('POST', `/api/admin/collections/${cid}/release`, { allocationIds: [d.allocations.find((a) => a.itemTitle === 'Bike').id] });
  await t.admin('PATCH', `/api/admin/collections/${cid}`, { expiresAt: t.srv.now() + HOUR });
  assert.deepEqual((await results()).removed, []);
});

test('admins can change a participant\'s likes, also after closing', async () => {
  const t = await team();
  const { data } = await t.admin('POST', '/api/admin/collections', { name: 'Likes', expiresAt: t.srv.now() + HOUR, published: true });
  const cid = data.collection.id;
  const lamp = (await t.admin('POST', `/api/admin/collections/${cid}/items`, { title: 'Lamp' })).data.item;
  await t.admin('PUT', `/api/admin/collections/${cid}/members`, { userIds: [t.participant.id] });
  await t.admin('POST', `/api/admin/collections/${cid}/close`);
  const choices = async () => (await t.admin('GET', `/api/admin/collections/${cid}`)).data.choices;

  // Only admins, only participants, only items of this collection
  assert.equal((await t.manager.client('PUT', `/api/admin/collections/${cid}/choices`, { userId: t.participant.id, itemId: lamp.id, liked: true })).status, 403);
  assert.equal((await t.admin('PUT', `/api/admin/collections/${cid}/choices`, { userId: t.creator.id, itemId: lamp.id, liked: true })).status, 400);
  assert.equal((await t.admin('PUT', `/api/admin/collections/${cid}/choices`, { userId: t.participant.id, itemId: 9999, liked: true })).status, 404);
  assert.equal((await t.admin('PUT', `/api/admin/collections/${cid}/choices`, { userId: t.participant.id, itemId: lamp.id, liked: 'yes' })).status, 400);

  // Like it on Pim's behalf; a new hand-out uses it
  assert.equal((await t.admin('PUT', `/api/admin/collections/${cid}/choices`, { userId: t.participant.id, itemId: lamp.id, liked: true })).status, 200);
  assert.deepEqual(await choices(), [{ userId: t.participant.id, itemId: lamp.id, liked: true }]);
  await t.admin('POST', `/api/admin/collections/${cid}/reallocate`, { onlyFree: true });
  assert.equal((await t.participant.client('GET', `/api/collections/${cid}`)).data.items[0].won, true);

  // Change to pass, then clear
  await t.admin('PUT', `/api/admin/collections/${cid}/choices`, { userId: t.participant.id, itemId: lamp.id, liked: false });
  assert.equal((await choices())[0].liked, false);
  await t.admin('PUT', `/api/admin/collections/${cid}/choices`, { userId: t.participant.id, itemId: lamp.id, liked: null });
  assert.deepEqual(await choices(), []);
});

test('allocation versions: saved before changes, restorable, exportable and importable', async () => {
  const t = await team();
  const { data } = await t.admin('POST', '/api/admin/collections', { name: 'Versions', expiresAt: t.srv.now() + HOUR, published: true });
  const cid = data.collection.id;
  const bike = (await t.admin('POST', `/api/admin/collections/${cid}/items`, { title: 'Bike' })).data.item;
  const lamp = (await t.admin('POST', `/api/admin/collections/${cid}/items`, { title: 'Lamp' })).data.item;
  await t.admin('PUT', `/api/admin/collections/${cid}/members`, { userIds: [t.participant.id] });
  for (const it of [bike, lamp]) await t.participant.client('PUT', `/api/items/${it.id}/swipe`, { liked: true });

  // Nothing to export before the collection is allocated
  assert.equal((await t.admin('GET', `/api/admin/collections/${cid}/allocation`)).status, 409);
  await t.admin('POST', `/api/admin/collections/${cid}/close`);
  const titles = async () => (await t.admin('GET', `/api/admin/collections/${cid}`)).data.allocations.map((a) => a.itemTitle).sort();

  // Mark the bike as picked up, then export
  let d = (await t.admin('GET', `/api/admin/collections/${cid}`)).data;
  await t.admin('PATCH', `/api/admin/allocations/${d.allocations.find((a) => a.itemTitle === 'Bike').id}`, { collected: true });
  const exported = (await t.admin('GET', `/api/admin/collections/${cid}/allocation`)).data;
  assert.equal(exported.format, 'swipio-allocation');
  assert.deepEqual(exported.allocations.map((a) => a.itemTitle).sort(), ['Bike', 'Lamp']);
  assert.ok(exported.allocations.find((a) => a.itemTitle === 'Bike').collectedAt);

  // Only admins
  assert.equal((await t.manager.client('GET', `/api/admin/collections/${cid}/allocation`)).status, 403);
  assert.equal((await t.manager.client('GET', `/api/admin/collections/${cid}/allocation/versions`)).status, 403);

  // Taking everything away saves a version first
  d = (await t.admin('GET', `/api/admin/collections/${cid}`)).data;
  await t.admin('POST', `/api/admin/collections/${cid}/release`, { allocationIds: d.allocations.map((a) => a.id) });
  assert.deepEqual(await titles(), []);
  let versions = (await t.admin('GET', `/api/admin/collections/${cid}/allocation/versions`)).data.versions;
  assert.equal(versions.length, 1);
  assert.equal(versions[0].label, 'Before taking 2 items away');
  assert.equal(versions[0].items, 2);
  assert.equal(versions[0].by, 'Ada');

  // Restore it: both items back, pickup status too, and the take-aways are gone
  let r = await t.admin('POST', `/api/admin/collections/${cid}/allocation/versions/${versions[0].id}/restore`);
  assert.equal(r.status, 200);
  assert.equal(r.data.restored, 2);
  d = (await t.admin('GET', `/api/admin/collections/${cid}`)).data;
  assert.deepEqual(d.allocations.map((a) => a.itemTitle).sort(), ['Bike', 'Lamp']);
  assert.equal(d.allocations.find((a) => a.itemTitle === 'Bike').collected, true);
  assert.deepEqual(d.removed, []);
  versions = (await t.admin('GET', `/api/admin/collections/${cid}/allocation/versions`)).data.versions;
  assert.equal(versions[0].label, 'Before restoring a version', 'restoring is itself undoable');
  assert.equal(versions[0].items, 0);

  // Download a version
  const v = (await t.admin('GET', `/api/admin/collections/${cid}/allocation/versions/${versions[1].id}`)).data;
  assert.equal(v.allocations.length, 2);

  // Import: empty the allocation, then import the exported file
  await t.admin('POST', `/api/admin/collections/${cid}/allocation/import`, { ...exported, allocations: [] });
  assert.deepEqual(await titles(), []);
  r = await t.admin('POST', `/api/admin/collections/${cid}/allocation/import`, exported);
  assert.equal(r.data.restored, 2);
  assert.deepEqual(await titles(), ['Bike', 'Lamp']);

  // Items that no longer exist are skipped and reported
  await t.admin('DELETE', `/api/admin/items/${lamp.id}`);
  r = await t.admin('POST', `/api/admin/collections/${cid}/allocation/import`, exported);
  assert.equal(r.data.restored, 1);
  assert.deepEqual(r.data.skipped.map((s) => `${s.itemTitle}: ${s.reason}`), ['Lamp: item no longer exists']);

  // Wrong files are refused and change nothing
  const before = (await t.admin('GET', `/api/admin/collections/${cid}/allocation/versions`)).data.versions.length;
  assert.equal((await t.admin('POST', `/api/admin/collections/${cid}/allocation/import`, { hello: 'world' })).status, 400);
  r = await t.admin('POST', `/api/admin/collections/${cid}/allocation/import`, { ...exported, collection: { id: 999, name: 'Other' } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /another collection/);
  assert.equal((await t.admin('GET', `/api/admin/collections/${cid}/allocation/versions`)).data.versions.length, before);
});

test('only the newest 30 versions are kept', async () => {
  const t = await team();
  const { data } = await t.admin('POST', '/api/admin/collections', { name: 'Many', expiresAt: t.srv.now() + HOUR, published: true });
  const cid = data.collection.id;
  await t.admin('POST', `/api/admin/collections/${cid}/items`, { title: 'X' });
  await t.admin('POST', `/api/admin/collections/${cid}/close`);
  for (let i = 0; i < 32; i++) await t.admin('POST', `/api/admin/collections/${cid}/reallocate`, { onlyFree: true });
  assert.equal((await t.admin('GET', `/api/admin/collections/${cid}/allocation/versions`)).data.versions.length, 30);
});

test('reopening: only admins and the maker, keeps picked-up items, new items get swiped', async () => {
  const t = await team();
  const cas = t.creator.client;
  const cid = (await cas('POST', '/api/admin/collections', { name: 'Cas stuff', expiresAt: t.srv.now() + HOUR, published: true })).data.collection.id;
  const bike = (await cas('POST', `/api/admin/collections/${cid}/items`, { title: 'Bike' })).data.item;
  const lamp = (await cas('POST', `/api/admin/collections/${cid}/items`, { title: 'Lamp' })).data.item;
  await cas('PUT', `/api/admin/collections/${cid}/members`, { userIds: [t.participant.id] });
  await t.participant.client('PUT', `/api/items/${bike.id}/swipe`, { liked: true });
  await t.participant.client('PUT', `/api/items/${lamp.id}/swipe`, { liked: true });
  await cas('POST', `/api/admin/collections/${cid}/close`);
  // Pim picked up the bike
  const d = (await t.admin('GET', `/api/admin/collections/${cid}`)).data;
  await t.admin('PATCH', `/api/admin/allocations/${d.allocations.find((a) => a.itemTitle === 'Bike').id}`, { collected: true });

  const later = t.srv.now() + 2 * HOUR;
  // A co-editor and a manager who didn't make it may not reopen (also not via the deadline)
  await t.manager.client('PUT', `/api/admin/collections/${cid}/editors`, { userIds: [t.creator2.id] });
  assert.equal((await t.creator2.client('POST', `/api/admin/collections/${cid}/reopen`, { expiresAt: later })).status, 403);
  assert.equal((await t.manager.client('POST', `/api/admin/collections/${cid}/reopen`, { expiresAt: later })).status, 403);
  assert.equal((await t.manager.client('PATCH', `/api/admin/collections/${cid}`, { expiresAt: later })).status, 403);
  assert.equal((await t.manager.client('GET', `/api/admin/collections/${cid}`)).data.canReopen, false);
  assert.equal((await cas('GET', `/api/admin/collections/${cid}`)).data.canReopen, true);
  // A deadline in the past is refused
  assert.equal((await cas('POST', `/api/admin/collections/${cid}/reopen`, { expiresAt: t.srv.now() - 1 })).status, 400);

  // The maker reopens; a version is saved, the bike stays with Pim, the lamp is up for grabs again
  let r = await cas('POST', `/api/admin/collections/${cid}/reopen`, { expiresAt: later });
  assert.equal(r.status, 200);
  assert.equal(r.data.collection.state, 'open');
  const versions = (await t.admin('GET', `/api/admin/collections/${cid}/allocation/versions`)).data.versions;
  assert.equal(versions[0].label, 'Before reopening');
  let view = (await t.participant.client('GET', `/api/collections/${cid}`)).data;
  assert.deepEqual(view.items.filter((i) => i.won).map((i) => i.title), ['Bike']);
  assert.equal(view.items.find((i) => i.title === 'Bike').available, 0);

  // New item: only it needs swiping; earlier choices are kept and can still be changed
  const vase = (await cas('POST', `/api/admin/collections/${cid}/items`, { title: 'Vase' })).data.item;
  view = (await t.participant.client('GET', `/api/collections/${cid}`)).data;
  assert.deepEqual(view.items.filter((i) => i.swipe === null).map((i) => i.title), ['Vase']);
  assert.equal((await t.participant.client('PUT', `/api/items/${lamp.id}/swipe`, { liked: false })).status, 200);
  await t.participant.client('PUT', `/api/items/${vase.id}/swipe`, { liked: true });

  // At the new deadline: bike stays (picked up), lamp no longer wanted, vase goes to Pim
  t.srv.advance(3 * HOUR);
  view = (await t.participant.client('GET', `/api/collections/${cid}`)).data;
  assert.equal(view.collection.state, 'closed');
  assert.deepEqual(view.items.filter((i) => i.won).map((i) => i.title).sort(), ['Bike', 'Vase']);
  r = (await t.admin('GET', `/api/admin/collections/${cid}`)).data;
  assert.equal(r.allocations.find((a) => a.itemTitle === 'Bike').collected, true);

  // Admins can reopen any collection
  assert.equal((await t.admin('POST', `/api/admin/collections/${cid}/reopen`, { expiresAt: t.srv.now() + HOUR })).status, 200);
});

test('admins can reset an allocation completely, and undo it', async () => {
  const t = await team();
  const { data } = await t.admin('POST', '/api/admin/collections', { name: 'Reset', expiresAt: t.srv.now() + HOUR, published: true });
  const cid = data.collection.id;
  const bike = (await t.admin('POST', `/api/admin/collections/${cid}/items`, { title: 'Bike' })).data.item;
  await t.admin('PUT', `/api/admin/collections/${cid}/members`, { userIds: [t.participant.id] });
  await t.participant.client('PUT', `/api/items/${bike.id}/swipe`, { liked: true });
  assert.equal((await t.admin('POST', `/api/admin/collections/${cid}/allocation/reset`)).status, 409, 'not allocated yet');
  await t.admin('POST', `/api/admin/collections/${cid}/close`);
  let d = (await t.admin('GET', `/api/admin/collections/${cid}`)).data;
  await t.admin('PATCH', `/api/admin/allocations/${d.allocations[0].id}`, { collected: true });

  assert.equal((await t.manager.client('POST', `/api/admin/collections/${cid}/allocation/reset`)).status, 403);
  const r = await t.admin('POST', `/api/admin/collections/${cid}/allocation/reset`);
  assert.equal(r.data.removed, 1);
  d = (await t.admin('GET', `/api/admin/collections/${cid}`)).data;
  assert.deepEqual(d.allocations, []);
  assert.equal(d.collection.state, 'closed', 'stays closed');
  assert.equal((await t.participant.client('GET', `/api/collections/${cid}`)).data.items[0].won, false);

  // Undo via the saved version
  const v = (await t.admin('GET', `/api/admin/collections/${cid}/allocation/versions`)).data.versions[0];
  assert.equal(v.label, 'Before reset');
  await t.admin('POST', `/api/admin/collections/${cid}/allocation/versions/${v.id}/restore`);
  d = (await t.admin('GET', `/api/admin/collections/${cid}`)).data;
  assert.equal(d.allocations.length, 1);
  assert.equal(d.allocations[0].collected, true);
});
