import test from 'node:test';
import assert from 'node:assert/strict';
import { allocate } from '../src/allocation.js';

const byItem = (result) => {
  const map = {};
  for (const { itemId, userId } of result) (map[itemId] ||= []).push(userId);
  return map;
};

test('uncontested items go to everyone who liked them', () => {
  const result = allocate({
    items: [{ id: 1, quantity: 1 }, { id: 2, quantity: 3 }],
    likes: [
      { itemId: 1, userId: 10 },
      { itemId: 2, userId: 10 },
      { itemId: 2, userId: 11 },
    ],
    seed: 'x',
  });
  assert.deepEqual(byItem(result), { 1: [10], 2: [10, 11] });
});

test('never hands out more units than available', () => {
  const likes = [];
  for (let u = 1; u <= 20; u++) likes.push({ itemId: 1, userId: u }, { itemId: 2, userId: u });
  const result = allocate({ items: [{ id: 1, quantity: 3 }, { id: 2, quantity: 1 }], likes, seed: 1 });
  const map = byItem(result);
  assert.equal(map[1].length, 3);
  assert.equal(map[2].length, 1);
  assert.equal(new Set(map[1]).size, 3);
});

test('contested items favour people with fewer items', () => {
  // User 1 already gets item 1 uncontested, so item 2 should go to user 2.
  const result = allocate({
    items: [{ id: 1, quantity: 1 }, { id: 2, quantity: 1 }],
    likes: [
      { itemId: 1, userId: 1 },
      { itemId: 2, userId: 1 },
      { itemId: 2, userId: 2 },
    ],
    seed: 'any',
  });
  assert.deepEqual(byItem(result), { 1: [1], 2: [2] });
});

test('spreads contested items evenly', () => {
  const items = [1, 2, 3, 4].map((id) => ({ id, quantity: 1 }));
  const likes = [];
  for (const { id } of items) for (const u of [1, 2]) likes.push({ itemId: id, userId: u });
  const counts = {};
  for (const { userId } of allocate({ items, likes, seed: 42 })) counts[userId] = (counts[userId] || 0) + 1;
  assert.deepEqual(counts, { 1: 2, 2: 2 });
});

test('is deterministic for the same seed', () => {
  const items = [{ id: 1, quantity: 1 }];
  const likes = [1, 2, 3, 4, 5].map((u) => ({ itemId: 1, userId: u }));
  const a = allocate({ items, likes, seed: 'same' });
  const b = allocate({ items, likes, seed: 'same' });
  assert.deepEqual(a, b);
});

test('fixed allocations keep their units and count towards fairness', () => {
  const items = [{ id: 1, quantity: 1 }, { id: 2, quantity: 2 }];
  const likes = [
    { itemId: 1, userId: 1 },
    { itemId: 1, userId: 2 },
    { itemId: 2, userId: 1 },
    { itemId: 2, userId: 2 },
    { itemId: 2, userId: 3 },
  ];
  // User 1 already picked up item 1, and one unit of item 2 went to user 3.
  const fixed = [{ itemId: 1, userId: 1 }, { itemId: 2, userId: 3 }];
  const result = allocate({ items, likes, seed: 'x', fixed });
  // Item 1 has no units left. Item 2 has one left; user 2 has nothing yet, so it goes to them.
  assert.deepEqual(result, [{ itemId: 2, userId: 2 }]);
});

test('a different seed can change who wins a tie', () => {
  const items = [{ id: 1, quantity: 1 }];
  const likes = [1, 2, 3, 4, 5, 6, 7, 8].map((u) => ({ itemId: 1, userId: u }));
  const winners = new Set();
  for (let round = 0; round < 20; round++) winners.add(allocate({ items, likes, seed: `1:0:${round}` })[0].userId);
  assert.ok(winners.size > 1, 'redoing with a new round should be able to pick someone else');
});

test('nobody gets two of the same product, even when it is entered as separate items', () => {
  // Three separate "Dopper" items, one unit each. Anna likes all three; Bob likes one.
  const items = [1, 2, 3].map((id) => ({ id, quantity: 1, group: 'dopper' }));
  const likes = [
    { itemId: 1, userId: 1 },
    { itemId: 2, userId: 1 },
    { itemId: 3, userId: 1 },
    { itemId: 2, userId: 2 },
  ];
  const result = allocate({ items, likes, seed: 's' });
  const perUser = {};
  for (const { userId } of result) perUser[userId] = (perUser[userId] || 0) + 1;
  assert.deepEqual(perUser, { 1: 1, 2: 1 });
  // Bob gets the one he liked; Anna one of the others
  assert.equal(result.find((r) => r.userId === 2).itemId, 2);
  assert.notEqual(result.find((r) => r.userId === 1).itemId, 2);
});

test('a product entered as separate items is shared out over the most people', () => {
  const items = [1, 2, 3].map((id) => ({ id, quantity: 1, group: 'dopper' }));
  const likes = [];
  for (let u = 1; u <= 5; u++) for (const id of [1, 2, 3]) likes.push({ itemId: id, userId: u });
  const result = allocate({ items, likes, seed: 'x' });
  assert.equal(result.length, 3);
  assert.equal(new Set(result.map((r) => r.userId)).size, 3, 'three different people');
  assert.equal(new Set(result.map((r) => r.itemId)).size, 3, 'each item used once');
});

test('someone who already has a product (picked up) does not get a second one', () => {
  const items = [{ id: 1, quantity: 1, group: 'dopper' }, { id: 2, quantity: 1, group: 'dopper' }];
  const likes = [{ itemId: 1, userId: 1 }, { itemId: 2, userId: 1 }];
  assert.deepEqual(allocate({ items, likes, seed: 'x', fixed: [{ itemId: 1, userId: 1 }] }), []);
});
