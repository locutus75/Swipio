'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { allocate } = require('../src/allocation');

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
