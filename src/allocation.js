'use strict';

/**
 * Decides who gets which item once a collection's timer has expired.
 *
 * - An item liked by no more people than its quantity goes to everyone who liked it.
 * - A contested item (more likers than units) is handed out fairly: likers who have
 *   received the fewest items so far go first, and remaining ties are broken by a
 *   seeded shuffle so results are reproducible.
 * - Contested items are processed from least to most contested, so that a person
 *   winning a hotly contested item does not also hoover up the easier ones.
 *
 * @param {{items: {id:number, quantity:number}[], likes: {itemId:number, userId:number}[], seed: string|number}} input
 * @returns {{itemId:number, userId:number}[]}
 */
function allocate({ items, likes, seed }) {
  const rand = mulberry32(hashString(String(seed)));
  const likersByItem = new Map();
  for (const { itemId, userId } of likes) {
    if (!likersByItem.has(itemId)) likersByItem.set(itemId, []);
    const list = likersByItem.get(itemId);
    if (!list.includes(userId)) list.push(userId);
  }

  const counts = new Map();
  const result = [];
  const give = (itemId, userId) => {
    result.push({ itemId, userId });
    counts.set(userId, (counts.get(userId) || 0) + 1);
  };

  const contested = [];
  for (const item of items) {
    const likers = likersByItem.get(item.id) || [];
    const qty = Math.max(0, Math.floor(item.quantity));
    if (likers.length <= qty) {
      for (const userId of likers) give(item.id, userId);
    } else if (qty > 0) {
      contested.push({ item, likers, qty });
    }
  }

  contested.sort(
    (a, b) => a.likers.length / a.qty - b.likers.length / b.qty || a.item.id - b.item.id
  );

  for (const { item, likers, qty } of contested) {
    const pool = shuffle([...likers].sort((a, b) => a - b), rand);
    // Array#sort is stable, so the shuffle decides among equal counts.
    pool.sort((a, b) => (counts.get(a) || 0) - (counts.get(b) || 0));
    for (const userId of pool.slice(0, qty)) give(item.id, userId);
  }

  return result;
}

function shuffle(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = { allocate };
