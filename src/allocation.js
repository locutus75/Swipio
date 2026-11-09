/**
 * Decides who gets which item once a collection's timer has expired.
 *
 * - An item liked by no more people than its quantity goes to everyone who liked it.
 * - A contested item (more likers than units) is handed out fairly: likers who have
 *   received the fewest items so far go first, and remaining ties are broken by a
 *   seeded shuffle so results are reproducible.
 * - Contested items are processed from least to most contested, so that a person
 *   winning a hotly contested item does not also hoover up the easier ones.
 * - `fixed` allocations (e.g. items already picked up when an admin redoes the allocation)
 *   stay as they are: they use up units and count towards each person's total, and only
 *   the new allocations are returned.
 *
 * @param {{items: {id:number, quantity:number}[], likes: {itemId:number, userId:number}[], seed: string|number, fixed?: {itemId:number, userId:number}[]}} input
 * @returns {{itemId:number, userId:number}[]}
 */
export function allocate({ items, likes, seed, fixed = [] }) {
  const rand = mulberry32(hashString(String(seed)));
  const likersByItem = new Map();
  for (const { itemId, userId } of likes) {
    if (!likersByItem.has(itemId)) likersByItem.set(itemId, []);
    const list = likersByItem.get(itemId);
    if (!list.includes(userId)) list.push(userId);
  }

  const counts = new Map();
  const taken = new Map(); // itemId -> Set of userIds that already have one
  for (const { itemId, userId } of fixed) {
    if (!taken.has(itemId)) taken.set(itemId, new Set());
    if (taken.get(itemId).has(userId)) continue;
    taken.get(itemId).add(userId);
    counts.set(userId, (counts.get(userId) || 0) + 1);
  }
  const result = [];
  const give = (itemId, userId) => {
    result.push({ itemId, userId });
    counts.set(userId, (counts.get(userId) || 0) + 1);
  };

  const contested = [];
  for (const item of items) {
    const already = taken.get(item.id) || new Set();
    const likers = (likersByItem.get(item.id) || []).filter((u) => !already.has(u));
    const qty = Math.max(0, Math.floor(item.quantity) - already.size);
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

