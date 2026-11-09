/**
 * Decides who gets which item once a collection's timer has expired.
 *
 * - Items that are the same product (same `group`, e.g. three separate "Dopper" items) are
 *   treated as one product with their quantities added up: nobody gets more than one of a
 *   product. Items without a group are each their own product.
 * - A product liked by no more people than its quantity goes to everyone who liked it.
 * - A contested product (more likers than units) is handed out fairly: likers who have
 *   received the fewest items so far go first, and remaining ties are broken by a
 *   seeded shuffle so results are reproducible.
 * - Contested products are processed from least to most contested, so that a person
 *   winning a hotly contested product does not also hoover up the easier ones.
 * - `fixed` allocations (e.g. items already picked up when an admin redoes the allocation)
 *   stay as they are: they use up units and count towards each person's total, and only
 *   the new allocations are returned.
 *
 * @param {{items: {id:number, quantity:number, group?:string}[], likes: {itemId:number, userId:number}[], seed: string|number, fixed?: {itemId:number, userId:number}[]}} input
 * @returns {{itemId:number, userId:number}[]}
 */
export function allocate({ items, likes, seed, fixed = [] }) {
  const rand = mulberry32(hashString(String(seed)));
  const itemById = new Map(items.map((i) => [i.id, i]));
  const groupOf = (item) => (item.group ? `g:${item.group}` : `i:${item.id}`);

  // One entry per product, holding its items in id order.
  const products = new Map();
  for (const item of [...items].sort((a, b) => a.id - b.id)) {
    const key = groupOf(item);
    if (!products.has(key)) products.set(key, { key, items: [], firstId: item.id });
    products.get(key).items.push(item);
  }

  const remaining = new Map(items.map((i) => [i.id, Math.max(0, Math.floor(i.quantity))]));
  const counts = new Map(); // userId -> items received
  const has = new Map(); // product key -> Set of userIds that already have one
  const hasProduct = (key) => has.get(key) || has.set(key, new Set()).get(key);
  const seen = new Set();
  for (const { itemId, userId } of fixed) {
    const item = itemById.get(itemId);
    if (!item || seen.has(`${itemId}:${userId}`)) continue;
    seen.add(`${itemId}:${userId}`);
    remaining.set(itemId, Math.max(0, remaining.get(itemId) - 1));
    hasProduct(groupOf(item)).add(userId);
    counts.set(userId, (counts.get(userId) || 0) + 1);
  }

  // Who liked which items of each product (in order of liking).
  const likedItems = new Map(); // `${key}:${userId}` -> [itemIds]
  const likersOf = new Map(); // key -> [userIds]
  for (const { itemId, userId } of likes) {
    const item = itemById.get(itemId);
    if (!item) continue;
    const key = groupOf(item);
    if (!likersOf.has(key)) likersOf.set(key, []);
    if (!likersOf.get(key).includes(userId)) likersOf.get(key).push(userId);
    const k = `${key}:${userId}`;
    if (!likedItems.has(k)) likedItems.set(k, []);
    if (!likedItems.get(k).includes(itemId)) likedItems.get(k).push(itemId);
  }

  const result = [];
  /** Gives each winner one concrete item of the product, preferring an item they liked. */
  const giveProduct = (product, winners) => {
    // People who liked fewer of the product's items choose first, so everyone can get one they liked.
    const ordered = [...winners].sort(
      (a, b) => likedItems.get(`${product.key}:${a}`).length - likedItems.get(`${product.key}:${b}`).length
    );
    for (const userId of ordered) {
      const liked = likedItems.get(`${product.key}:${userId}`);
      const item =
        product.items.find((i) => liked.includes(i.id) && remaining.get(i.id) > 0) ||
        product.items.find((i) => remaining.get(i.id) > 0);
      if (!item) continue;
      remaining.set(item.id, remaining.get(item.id) - 1);
      hasProduct(product.key).add(userId);
      counts.set(userId, (counts.get(userId) || 0) + 1);
      result.push({ itemId: item.id, userId });
    }
  };

  const contested = [];
  for (const product of products.values()) {
    const already = hasProduct(product.key);
    const likers = (likersOf.get(product.key) || []).filter((u) => !already.has(u));
    const qty = product.items.reduce((n, i) => n + remaining.get(i.id), 0);
    if (likers.length <= qty) giveProduct(product, likers);
    else if (qty > 0) contested.push({ product, likers, qty });
  }

  contested.sort(
    (a, b) => a.likers.length / a.qty - b.likers.length / b.qty || a.product.firstId - b.product.firstId
  );

  for (const { product, likers, qty } of contested) {
    const pool = shuffle([...likers].sort((a, b) => a - b), rand);
    // Array#sort is stable, so the shuffle decides among equal counts.
    pool.sort((a, b) => (counts.get(a) || 0) - (counts.get(b) || 0));
    giveProduct(product, pool.slice(0, qty));
  }

  return result;
}

/** Items count as the same product when their names match, ignoring case and extra spaces. */
export function productKey(title) {
  return String(title || '').trim().toLowerCase().replace(/\s+/g, ' ');
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

