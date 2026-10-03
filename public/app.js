'use strict';

/* Swipio single-page frontend. No build step, no framework. */

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const $app = document.getElementById('app');
let me = null;
let viewCleanups = [];

/** Tiny DOM builder: h('div', {class: 'x', onclick}, 'text', child) */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key in el && typeof value !== 'string') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

// Where the API lives: set in config.js (empty means the same origin as this page).
const API_URL = String((window.SWIPIO_CONFIG || {}).apiUrl || '').replace(/\/$/, '');
const TOKEN_KEY = 'swipio_token';

function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage unavailable (private mode): the session lasts until the page is closed
  }
  memoryToken = token;
}
let memoryToken = getToken();

/** Stores the session from a login-type response and returns the user. */
function signedIn(data) {
  setToken(data.token);
  me = data.user;
  return me;
}

/** Turns an API-relative path (e.g. an uploaded image) into a full URL. */
function apiAsset(path) {
  return path && path.startsWith('/api/') ? API_URL + path : path;
}

function inviteLink(token) {
  return `${location.origin}${location.pathname}#/invite/${token}`;
}

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (memoryToken) opts.headers.Authorization = `Bearer ${memoryToken}`;
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(API_URL + url, opts);
  } catch {
    throw new Error('Cannot reach the Swipio server. Check your connection and try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && memoryToken && !url.startsWith('/api/login')) setToken(null);
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function toast(message, type = 'info') {
  const el = h('div', { class: `toast ${type}` }, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), 3500);
}

/** Wraps an async handler so failures show a toast and buttons don't double-submit. */
function action(fn) {
  return async (event) => {
    if (event && event.preventDefault) event.preventDefault();
    const target = event && (event.submitter || event.currentTarget);
    if (target && 'disabled' in target) target.disabled = true;
    try {
      await fn(event);
    } catch (err) {
      if (err.status === 401) return go('#/login');
      toast(err.message, 'error');
    } finally {
      if (target && 'disabled' in target) target.disabled = false;
    }
  };
}

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function formatRemaining(ms) {
  if (ms <= 0) return 'Closed';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const hrs = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${hrs}h left`;
  if (hrs > 0) return `${hrs}h ${m}m left`;
  return `${m}m ${String(sec).padStart(2, '0')}s left`;
}

function formatDate(ms) {
  return new Date(ms).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function toLocalInput(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Live countdown badge. With reload=true the current view re-renders when it hits zero. */
function countdown(collection, { reload = false } = {}) {
  if (collection.state === 'draft') return h('span', { class: 'badge' }, 'Draft');
  if (collection.state === 'closed') return h('span', { class: 'badge closed' }, 'Closed');
  const el = h('span', { class: 'badge open', 'data-expires': collection.expiresAt });
  if (reload) el.dataset.reload = '1';
  updateCountdown(el);
  return el;
}

function updateCountdown(el) {
  const left = Number(el.dataset.expires) - Date.now();
  el.textContent = '⏱ ' + formatRemaining(left);
  el.classList.toggle('hot', left > 0 && left < 3600 * 1000);
  if (left <= 0 && el.dataset.reload && !el.dataset.fired) {
    el.dataset.fired = '1';
    setTimeout(render, 1500); // give the server a moment to finalize
  }
}

setInterval(() => document.querySelectorAll('[data-expires]').forEach(updateCountdown), 1000);

function thumb(item, cls = 'thumb', fallbackCls = cls) {
  const placeholder = () => h('div', { class: fallbackCls }, (item.title || '?').trim().charAt(0).toUpperCase());
  if (!item.image) return placeholder();
  const img = h('img', { class: cls, src: apiAsset(item.image), alt: '', loading: 'lazy', draggable: false });
  img.addEventListener('error', () => img.replaceWith(placeholder()), { once: true });
  return img;
}

/** Shrinks a photo to at most 1200px and re-encodes it as JPEG, so uploads stay small. */
async function resizeImage(file, max = 1200) {
  if (file.type === 'image/gif') return file; // keep animations
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('That file could not be read as an image.');
  }
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
}

function copy(text) {
  navigator.clipboard
    ? navigator.clipboard.writeText(text).then(() => toast('Link copied'), () => prompt('Copy this link', text))
    : prompt('Copy this link', text);
}

function topbar(...right) {
  return h(
    'header',
    { class: 'topbar' },
    h('a', { class: 'logo', href: '#/' }, h('img', { src: 'icon.svg', alt: '' }), 'Swipio'),
    h('div', { class: 'title' }),
    ...right
  );
}

function userMenu() {
  return [
    me.role === 'admin' && h('a', { class: 'btn', href: '#/admin' }, '⚙️ Admin'),
    h(
      'button',
      {
        class: 'ghost',
        title: `Signed in as ${me.email}`,
        onclick: action(async () => {
          await api('POST', '/api/logout').catch(() => {});
          setToken(null);
          me = null;
          go('#/login');
        }),
      },
      'Log out'
    ),
  ];
}

function backBar(href, title, ...right) {
  return h(
    'header',
    { class: 'topbar' },
    h('a', { class: 'btn icon-btn', href, 'aria-label': 'Back' }, '←'),
    h('div', { class: 'title' }, title),
    ...right
  );
}

function mount(...nodes) {
  $app.replaceChildren(...nodes.flat().filter((n) => n instanceof Node));
  window.scrollTo(0, 0);
}

function confirmDialog(message) {
  return Promise.resolve(window.confirm(message));
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const routes = [
  [/^#\/setup$/, viewSetup, { public: true }],
  [/^#\/login$/, viewLogin, { public: true }],
  [/^#\/invite\/([\w-]+)$/, viewInvite, { public: true }],
  [/^#\/c\/(\d+)$/, viewCollection],
  [/^#\/admin$/, viewAdmin, { admin: true }],
  [/^#\/admin\/users$/, viewAdminUsers, { admin: true }],
  [/^#\/admin\/c\/(\d+)$/, viewAdminCollection, { admin: true }],
  [/^#?\/?$/, viewHome],
];

async function render() {
  viewCleanups.forEach((fn) => fn());
  viewCleanups = [];
  const hash = location.hash || '#/';
  const match = routes.find(([re]) => re.test(hash)) || routes[routes.length - 1];
  const [re, view, opts = {}] = match;
  const params = hash.match(re)?.slice(1) || [];

  try {
    if (!opts.public && !me) {
      const { needsSetup } = await api('GET', '/api/setup');
      if (needsSetup) return go('#/setup');
      try {
        me = (await api('GET', '/api/me')).user;
      } catch {
        return go('#/login');
      }
    }
    if (opts.admin && me.role !== 'admin') return go('#/');
    await view(...params);
  } catch (err) {
    if (err.status === 401) {
      me = null;
      return go('#/login');
    }
    mount(
      topbar(),
      h('div', { class: 'empty' }, h('div', { class: 'big' }, '😕'), h('p', {}, err.message), h('a', { href: '#/' }, 'Go home'))
    );
  }
}

window.addEventListener('hashchange', render);
render();

// ---------------------------------------------------------------------------
// Auth views
// ---------------------------------------------------------------------------

function authCard(...children) {
  return h(
    'div',
    { class: 'auth' },
    h('div', { class: 'logo' }, h('img', { src: 'icon.svg', alt: '' }), 'Swipio'),
    h('div', { class: 'card stack' }, ...children)
  );
}

async function viewSetup() {
  const { needsSetup } = await api('GET', '/api/setup');
  if (!needsSetup) return go('#/login');
  mount(
    authCard(
      h('h2', {}, 'Welcome to Swipio 👋'),
      h('p', { class: 'muted' }, 'Create the first admin account to get started.'),
      h(
        'form',
        {
          class: 'stack',
          onsubmit: action(async (e) => {
            signedIn(await api('POST', '/api/setup', formData(e.target)));
            go('#/admin');
          }),
        },
        h('label', {}, 'Your name', h('input', { name: 'name', required: true, autocomplete: 'name' })),
        h('label', {}, 'Email', h('input', { name: 'email', type: 'email', required: true, autocomplete: 'email' })),
        h(
          'label',
          {},
          'Password',
          h('input', { name: 'password', type: 'password', required: true, minlength: 8, autocomplete: 'new-password' })
        ),
        h('button', { class: 'primary block', type: 'submit' }, 'Create admin account')
      )
    )
  );
}

async function viewLogin() {
  if (me) return go('#/');
  mount(
    authCard(
      h('h2', {}, 'Log in'),
      h(
        'form',
        {
          class: 'stack',
          onsubmit: action(async (e) => {
            signedIn(await api('POST', '/api/login', formData(e.target)));
            go('#/');
          }),
        },
        h('label', {}, 'Email', h('input', { name: 'email', type: 'email', required: true, autocomplete: 'email' })),
        h(
          'label',
          {},
          'Password',
          h('input', { name: 'password', type: 'password', required: true, autocomplete: 'current-password' })
        ),
        h('button', { class: 'primary block', type: 'submit' }, 'Log in')
      ),
      h('p', { class: 'muted small' }, 'No account yet? Ask an admin for an invite link.')
    )
  );
}

async function viewInvite(token) {
  let invite;
  try {
    invite = await api('GET', `/api/invites/${token}`);
  } catch (err) {
    return mount(authCard(h('h2', {}, 'Invite not valid'), h('p', { class: 'muted' }, err.message), h('a', { href: '#/login' }, 'Go to log in')));
  }
  mount(
    authCard(
      h('h2', {}, "You're invited! 🎉"),
      h('p', { class: 'muted' }, `Set a password for ${invite.email} to start swiping.`),
      h(
        'form',
        {
          class: 'stack',
          onsubmit: action(async (e) => {
            signedIn(await api('POST', `/api/invites/${token}`, formData(e.target)));
            toast(`Welcome, ${me.name}!`);
            go('#/');
          }),
        },
        h('label', {}, 'Your name', h('input', { name: 'name', value: invite.name, required: true, autocomplete: 'name' })),
        h(
          'label',
          {},
          'Choose a password',
          h('input', { name: 'password', type: 'password', required: true, minlength: 8, autocomplete: 'new-password' })
        ),
        h('button', { class: 'primary block', type: 'submit' }, 'Start swiping')
      )
    )
  );
}

// ---------------------------------------------------------------------------
// Participant views
// ---------------------------------------------------------------------------

async function viewHome() {
  const { collections } = await api('GET', '/api/collections');
  const card = (c) => {
    const pct = c.itemCount ? Math.round((c.swipedCount / c.itemCount) * 100) : 0;
    let cta;
    if (c.state === 'closed') cta = c.wonCount ? `🎁 You get ${c.wonCount} item${c.wonCount === 1 ? '' : 's'}` : 'See results';
    else if (c.itemCount === 0) cta = 'No items yet';
    else if (c.swipedCount === 0) cta = 'Start swiping →';
    else if (c.swipedCount < c.itemCount) cta = 'Continue swiping →';
    else cta = `All swiped · ${c.likedCount} liked`;
    return h(
      'a',
      { class: 'card collection-card', href: `#/c/${c.id}` },
      h('div', { class: 'row spread' }, h('h3', {}, c.name), countdown(c)),
      c.description && h('div', { class: 'muted small' }, c.description),
      c.state === 'open' && h('div', { class: 'progress' }, h('span', { style: { width: `${pct}%` } })),
      h(
        'div',
        { class: 'row spread small' },
        h('span', { class: 'muted' }, c.state === 'open' ? `${c.swipedCount}/${c.itemCount} swiped` : `Closed ${formatDate(c.expiresAt)}`),
        h('strong', {}, cta)
      )
    );
  };
  mount(
    topbar(...userMenu()),
    h('h1', {}, `Hi ${me.name.split(' ')[0]}!`),
    collections.length
      ? h('div', { class: 'list' }, collections.map(card))
      : h(
          'div',
          { class: 'empty' },
          h('div', { class: 'big' }, '🛍️'),
          h('p', {}, "You haven't been invited to any collections yet."),
          me.role === 'admin' && h('a', { class: 'btn primary', href: '#/admin' }, 'Create a collection')
        )
  );
}

async function viewCollection(id, tab) {
  const data = await api('GET', `/api/collections/${id}`);
  const c = data.collection;
  const items = data.items;

  if (c.state === 'closed') return renderResults(c, items);

  const deckItems = items.filter((i) => i.swipe === null);
  const current = tab || (deckItems.length ? 'swipe' : 'choices');
  const tabs = h(
    'div',
    { class: 'tabs', role: 'tablist' },
    h('button', { class: current === 'swipe' ? 'active' : '', onclick: () => viewCollection(id, 'swipe') }, `Swipe (${deckItems.length})`),
    h(
      'button',
      { class: current === 'choices' ? 'active' : '', onclick: () => viewCollection(id, 'choices') },
      `My choices (${items.length - deckItems.length})`
    )
  );

  mount(
    backBar('#/', c.name, countdown(c, { reload: true })),
    c.description && h('p', { class: 'muted small' }, c.description),
    tabs,
    current === 'swipe' ? renderDeck(c, items) : renderChoices(c, items)
  );
}

function renderDeck(c, items) {
  const queue = items.filter((i) => i.swipe === null);
  const history = [];
  const wrap = h('div', { class: 'deck-wrap' });
  const deck = h('div', { class: 'deck' });
  const undoBtn = h('button', { class: 'small-btn', title: 'Undo', 'aria-label': 'Undo last swipe', disabled: true }, '↺');
  const nopeBtn = h('button', { class: 'big nope-btn', title: 'Pass (←)', 'aria-label': 'Pass' }, '✕');
  const likeBtn = h('button', { class: 'big like-btn', title: 'Want it (→)', 'aria-label': 'Want it' }, '♥');
  const infoBtn = h('button', { class: 'small-btn', title: 'Details', 'aria-label': 'Show details' }, 'ℹ');
  let busy = false;

  function draw() {
    deck.replaceChildren();
    if (!queue.length) {
      const liked = items.filter((i) => i.swipe === 'like').length;
      deck.replaceWith(
        h(
          'div',
          { class: 'card empty deck-done' },
          h('div', { class: 'big' }, '🎉'),
          h('h2', {}, "You're all done!"),
          h('p', {}, `You want ${liked} item${liked === 1 ? '' : 's'}. Results are in when the timer ends on ${formatDate(c.expiresAt)}.`),
          h('button', { class: 'primary', onclick: () => viewCollection(c.id, 'choices') }, 'Review my choices')
        )
      );
      actions.remove();
      hint.remove();
      return;
    }
    // Render up to three cards; the first in the queue sits on top.
    queue
      .slice(0, 3)
      .reverse()
      .forEach((item, idx, arr) => {
        const depth = arr.length - 1 - idx;
        const card = h(
          'div',
          { class: 'swipe-card', style: { transform: `translateY(${depth * 10}px) scale(${1 - depth * 0.04})`, zIndex: 10 - depth } },
          thumb(item, '', 'placeholder'),
          h('div', { class: 'stamp like' }, 'WANT'),
          h('div', { class: 'stamp nope' }, 'PASS'),
          h(
            'div',
            { class: 'info' },
            item.quantity > 1 && h('span', { class: 'badge' }, `${item.quantity} available`),
            h('h2', {}, item.title),
            item.description && h('p', {}, item.description)
          )
        );
        if (depth === 0) enableDrag(card, (liked) => commit(liked, card));
        deck.append(card);
      });
    undoBtn.disabled = !history.length;
  }

  async function commit(liked, card) {
    if (busy || !queue.length) return;
    busy = true;
    const item = queue[0];
    card = card || deck.lastElementChild;
    await flyOut(card, liked ? 1 : -1);
    queue.shift();
    item.swipe = liked ? 'like' : 'pass';
    history.push(item);
    draw();
    busy = false;
    api('PUT', `/api/items/${item.id}/swipe`, { liked }).catch((err) => {
      toast(err.message, 'error');
      if (err.status === 409) render();
    });
  }

  async function undo() {
    const item = history.pop();
    if (!item) return;
    try {
      await api('DELETE', `/api/items/${item.id}/swipe`);
      item.swipe = null;
      queue.unshift(item);
      draw();
    } catch (err) {
      history.push(item);
      toast(err.message, 'error');
    }
  }

  function showInfo() {
    const item = queue[0];
    if (!item) return;
    const dlg = h(
      'dialog',
      {},
      h('h2', {}, item.title),
      item.image && h('img', { src: apiAsset(item.image), alt: '', style: { width: '100%', borderRadius: '12px', marginBottom: '12px' } }),
      item.quantity > 1 && h('p', {}, h('span', { class: 'badge' }, `${item.quantity} available`)),
      h('p', { style: { whiteSpace: 'pre-wrap' } }, item.description || 'No description.'),
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => dlg.close() }, 'Close'))
    );
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
  }

  undoBtn.addEventListener('click', undo);
  nopeBtn.addEventListener('click', () => commit(false));
  likeBtn.addEventListener('click', () => commit(true));
  infoBtn.addEventListener('click', showInfo);

  const onKey = (e) => {
    if (document.querySelector('dialog[open]')) return;
    if (e.key === 'ArrowLeft') commit(false);
    else if (e.key === 'ArrowRight') commit(true);
    else if (e.key === 'Backspace' || (e.key === 'z' && (e.metaKey || e.ctrlKey))) undo();
  };
  document.addEventListener('keydown', onKey);
  viewCleanups.push(() => document.removeEventListener('keydown', onKey));

  const actions = h('div', { class: 'swipe-actions' }, undoBtn, nopeBtn, likeBtn, infoBtn);
  const hint = h('div', { class: 'hint' }, 'Swipe right if you want it, left to pass. Keyboard: ← →');
  wrap.append(deck, actions, hint);
  draw();
  return wrap;
}

function enableDrag(card, onDecision) {
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let dy = 0;
  let pointer = null;
  const like = card.querySelector('.stamp.like');
  const nope = card.querySelector('.stamp.nope');

  card.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    pointer = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    dx = dy = 0;
    card.setPointerCapture(pointer);
    card.style.transition = 'none';
  });

  card.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pointer) return;
    dx = e.clientX - startX;
    dy = e.clientY - startY;
    card.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 14}deg)`;
    const strength = Math.min(Math.abs(dx) / 100, 1);
    like.style.opacity = dx > 0 ? strength : 0;
    nope.style.opacity = dx < 0 ? strength : 0;
  });

  const end = (e) => {
    if (e.pointerId !== pointer) return;
    pointer = null;
    const threshold = Math.min(120, card.offsetWidth * 0.28);
    if (Math.abs(dx) > threshold) {
      onDecision(dx > 0);
    } else {
      card.style.transition = '';
      card.style.transform = '';
      like.style.opacity = nope.style.opacity = 0;
    }
  };
  card.addEventListener('pointerup', end);
  card.addEventListener('pointercancel', end);
}

function flyOut(card, dir) {
  return new Promise((resolve) => {
    if (!card) return resolve();
    const stamp = card.querySelector(dir > 0 ? '.stamp.like' : '.stamp.nope');
    if (stamp) stamp.style.opacity = 1;
    card.style.transition = 'transform 0.3s ease-in';
    card.style.transform = `translate(${dir * window.innerWidth}px, 40px) rotate(${dir * 30}deg)`;
    setTimeout(resolve, 280);
  });
}

function renderChoices(c, items) {
  const swiped = items.filter((i) => i.swipe !== null);
  if (!swiped.length) {
    return h('div', { class: 'empty' }, h('div', { class: 'big' }, '👆'), h('p', {}, "You haven't swiped anything yet."));
  }
  const row = (item) => {
    const toggle = (liked) =>
      action(async () => {
        await api('PUT', `/api/items/${item.id}/swipe`, { liked });
        item.swipe = liked ? 'like' : 'pass';
        el.replaceWith(row(item));
      });
    const el = h(
      'div',
      { class: 'item-row' },
      thumb(item),
      h(
        'div',
        { class: 'grow' },
        h('div', { class: 'name' }, item.title),
        item.quantity > 1 && h('div', { class: 'muted small' }, `${item.quantity} available`)
      ),
      h(
        'div',
        { class: 'choice-toggle' },
        h('button', { class: item.swipe === 'pass' ? 'on pass' : '', onclick: toggle(false), 'aria-pressed': String(item.swipe === 'pass') }, '✕ Pass'),
        h('button', { class: item.swipe === 'like' ? 'on like' : '', onclick: toggle(true), 'aria-pressed': String(item.swipe === 'like') }, '♥ Want')
      )
    );
    return el;
  };
  return h(
    'div',
    {},
    h('p', { class: 'muted small' }, 'Changed your mind? You can update your choices until the timer runs out.'),
    h('div', { class: 'card' }, swiped.map(row))
  );
}

function renderResults(c, items) {
  const won = items.filter((i) => i.won);
  const missed = items.filter((i) => i.swipe === 'like' && !i.won);
  mount(
    backBar('#/', c.name, countdown(c)),
    h(
      'div',
      { class: 'card empty' },
      h('div', { class: 'big' }, won.length ? '🎁' : '🌱'),
      h('h2', {}, won.length ? `You get ${won.length} item${won.length === 1 ? '' : 's'}!` : 'Nothing for you this time'),
      h(
        'p',
        {},
        won.length
          ? 'This collection has closed. Pick up your items below.'
          : 'This collection has closed and none of the items you liked were allocated to you.'
      )
    ),
    won.length > 0 &&
      h(
        'div',
        { class: 'section' },
        h('h3', {}, 'Your items'),
        h(
          'div',
          { class: 'card' },
          won.map((item) =>
            h(
              'div',
              { class: 'item-row' },
              thumb(item),
              h('div', { class: 'grow' }, h('div', { class: 'name' }, item.title), item.description && h('div', { class: 'muted small' }, item.description)),
              item.collected ? h('span', { class: 'badge open' }, '✓ Collected') : h('span', { class: 'badge hot' }, 'Ready to collect')
            )
          )
        )
      ),
    missed.length > 0 &&
      h(
        'div',
        { class: 'section' },
        h('h3', { class: 'muted' }, 'Went to someone else'),
        h(
          'div',
          { class: 'card' },
          missed.map((item) => h('div', { class: 'item-row', style: { opacity: 0.6 } }, thumb(item), h('div', { class: 'grow' }, h('div', { class: 'name' }, item.title))))
        )
      )
  );
}

// ---------------------------------------------------------------------------
// Admin views
// ---------------------------------------------------------------------------

function adminTabs(current) {
  return h(
    'div',
    { class: 'tabs' },
    h('button', { class: current === 'collections' ? 'active' : '', onclick: () => go('#/admin') }, 'Collections'),
    h('button', { class: current === 'users' ? 'active' : '', onclick: () => go('#/admin/users') }, 'People')
  );
}

async function viewAdmin() {
  const { collections } = await api('GET', '/api/admin/collections');
  const defaultExpiry = Date.now() + 7 * 24 * 3600 * 1000;

  const newForm = h(
    'form',
    {
      class: 'card stack',
      onsubmit: action(async (e) => {
        const f = formData(e.target);
        const { collection } = await api('POST', '/api/admin/collections', {
          name: f.name,
          description: f.description,
          expiresAt: new Date(f.expiresAt).getTime(),
        });
        go(`#/admin/c/${collection.id}`);
      }),
    },
    h('h3', {}, 'New collection'),
    h('div', { class: 'grid-2' },
      h('label', {}, 'Name', h('input', { name: 'name', required: true, placeholder: 'e.g. Office move giveaway' })),
      h('label', {}, 'Closes at', h('input', { name: 'expiresAt', type: 'datetime-local', required: true, value: toLocalInput(defaultExpiry) }))
    ),
    h('label', {}, 'Description', h('textarea', { name: 'description', placeholder: 'Pickup location, rules, …' })),
    h('button', { class: 'primary', type: 'submit' }, 'Create collection')
  );

  mount(
    topbar(h('a', { class: 'btn', href: '#/' }, '🃏 Swipe'), ...userMenu().slice(1)),
    h('h1', {}, 'Admin'),
    adminTabs('collections'),
    newForm,
    h(
      'div',
      { class: 'section list' },
      collections.length
        ? collections.map((c) =>
            h(
              'a',
              { class: 'card collection-card', href: `#/admin/c/${c.id}` },
              h('div', { class: 'row spread' }, h('h3', {}, c.name), countdown(c)),
              h('div', { class: 'muted small' }, `${c.itemCount} items · ${c.memberCount} people · closes ${formatDate(c.expiresAt)}`)
            )
          )
        : h('div', { class: 'empty' }, 'No collections yet. Create your first one above.')
    )
  );
}

function inviteDialog(user) {
  const url = inviteLink(user.inviteToken);
  const dlg = h(
    'dialog',
    {},
    h('h2', {}, `Invite ${user.name}`),
    h('p', { class: 'muted' }, `Send this link to ${user.email}. It lets them set a password and expires ${formatDate(user.inviteExpiresAt)}.`),
    h('div', { class: 'invite-link' }, url),
    h(
      'div',
      { class: 'row', style: { marginTop: '16px' } },
      h('button', { class: 'primary', onclick: () => copy(url) }, 'Copy link'),
      h(
        'a',
        {
          class: 'btn',
          href: `mailto:${encodeURIComponent(user.email)}?subject=${encodeURIComponent("You're invited to Swipio")}&body=${encodeURIComponent(
            `Hi ${user.name},\n\nYou've been invited to swipe on items in Swipio. Set your password here:\n${url}\n`
          )}`,
        },
        'Email it'
      ),
      navigator.share && h('button', { onclick: () => navigator.share({ title: 'Swipio invite', url: url }).catch(() => {}) }, 'Share'),
      h('button', { class: 'ghost', onclick: () => dlg.close() }, 'Done')
    )
  );
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

function inviteForm({ collectionId, onCreated }) {
  return h(
    'form',
    {
      class: 'card stack',
      onsubmit: action(async (e) => {
        const f = formData(e.target);
        const { user } = await api('POST', '/api/admin/users', {
          name: f.name,
          email: f.email,
          role: f.role,
          collectionIds: collectionId ? [Number(collectionId)] : [],
        });
        e.target.reset();
        inviteDialog(user);
        onCreated(user);
      }),
    },
    h('h3', {}, collectionId ? 'Invite someone new to this collection' : 'Invite someone'),
    h('div', { class: 'grid-2' },
      h('label', {}, 'Name', h('input', { name: 'name', required: true })),
      h('label', {}, 'Email', h('input', { name: 'email', type: 'email', required: true }))
    ),
    !collectionId &&
      h('label', {}, 'Role', h('select', { name: 'role' }, h('option', { value: 'user' }, 'Participant'), h('option', { value: 'admin' }, 'Admin'))),
    h('button', { class: 'primary', type: 'submit' }, 'Create invite')
  );
}

async function viewAdminUsers() {
  const { users } = await api('GET', '/api/admin/users');
  const row = (u) =>
    h(
      'div',
      { class: 'item-row' },
      h('div', { class: 'thumb' }, u.name.charAt(0).toUpperCase()),
      h(
        'div',
        { class: 'grow' },
        h('div', { class: 'name' }, u.name, ' ', u.role === 'admin' && h('span', { class: 'badge' }, 'Admin')),
        h('div', { class: 'muted small' }, u.email)
      ),
      u.status === 'invited'
        ? h('button', { onclick: () => inviteDialog(u) }, '✉️ Invite link')
        : h('span', { class: 'badge open' }, 'Active'),
      u.id !== me.id &&
        h(
          'select',
          {
            style: { width: 'auto' },
            'aria-label': 'Role',
            onchange: action(async (e) => {
              await api('PATCH', `/api/admin/users/${u.id}`, { role: e.target.value });
              toast('Role updated');
            }),
          },
          h('option', { value: 'user', selected: u.role === 'user' }, 'Participant'),
          h('option', { value: 'admin', selected: u.role === 'admin' }, 'Admin')
        ),
      u.id !== me.id &&
        u.status === 'active' &&
        h(
          'button',
          {
            class: 'ghost',
            title: 'Reset password',
            onclick: action(async () => {
              if (!(await confirmDialog(`Reset ${u.name}'s password? They will get a new invite link.`))) return;
              const { user } = await api('POST', `/api/admin/users/${u.id}/invite`);
              inviteDialog(user);
              render();
            }),
          },
          '🔑'
        ),
      u.id !== me.id &&
        h(
          'button',
          {
            class: 'ghost',
            title: 'Delete',
            onclick: action(async () => {
              if (!(await confirmDialog(`Delete ${u.name}? Their swipes and items will be removed.`))) return;
              await api('DELETE', `/api/admin/users/${u.id}`);
              render();
            }),
          },
          '🗑'
        )
    );

  mount(
    topbar(h('a', { class: 'btn', href: '#/' }, '🃏 Swipe'), ...userMenu().slice(1)),
    h('h1', {}, 'Admin'),
    adminTabs('users'),
    inviteForm({ onCreated: () => render() }),
    h('div', { class: 'section card' }, users.map(row))
  );
}

async function viewAdminCollection(id) {
  const [data, { users }] = await Promise.all([api('GET', `/api/admin/collections/${id}`), api('GET', '/api/admin/users')]);
  const c = data.collection;
  const refresh = () => viewAdminCollection(id);

  // --- details ---
  const details = h(
    'form',
    {
      class: 'card stack',
      onsubmit: action(async (e) => {
        const f = formData(e.target);
        const expiresAt = new Date(f.expiresAt).getTime();
        if (c.state === 'closed' && expiresAt > Date.now()) {
          if (!(await confirmDialog('Re-open this collection? Current results and pickup status will be discarded.'))) return;
        }
        await api('PATCH', `/api/admin/collections/${id}`, {
          name: f.name,
          description: f.description,
          expiresAt,
          published: f.published === 'on',
        });
        toast('Saved');
        refresh();
      }),
    },
    h('div', { class: 'grid-2' },
      h('label', {}, 'Name', h('input', { name: 'name', required: true, value: c.name })),
      h('label', {}, 'Closes at', h('input', { name: 'expiresAt', type: 'datetime-local', required: true, value: toLocalInput(c.expiresAt) }))
    ),
    h('label', {}, 'Description', h('textarea', { name: 'description' }, c.description)),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'published', checked: c.published }), 'Published — invited people can see and swipe this collection'),
    h(
      'div',
      { class: 'row' },
      h('button', { class: 'primary', type: 'submit' }, 'Save'),
      c.state === 'open' &&
        h(
          'button',
          {
            type: 'button',
            onclick: action(async () => {
              if (!(await confirmDialog('Close this collection now and allocate the items?'))) return;
              await api('POST', `/api/admin/collections/${id}/close`);
              refresh();
            }),
          },
          '⏹ Close now'
        ),
      h(
        'button',
        {
          type: 'button',
          class: 'danger',
          onclick: action(async () => {
            if (!(await confirmDialog(`Delete "${c.name}" with all its items and results?`))) return;
            await api('DELETE', `/api/admin/collections/${id}`);
            go('#/admin');
          }),
        },
        'Delete'
      )
    )
  );

  // --- items ---
  const itemForm = (item) =>
    h(
      'form',
      {
        class: 'stack',
        onsubmit: action(async (e) => {
          const fd = new FormData(e.target);
          const file = fd.get('image');
          fd.delete('image');
          if (file && file.size) fd.set('image', await resizeImage(file), 'photo.jpg');
          if (item) await api('PATCH', `/api/admin/items/${item.id}`, fd);
          else await api('POST', `/api/admin/collections/${id}/items`, fd);
          e.target.closest('dialog')?.close();
          toast(item ? 'Item updated' : 'Item added');
          refresh();
        }),
      },
      h('div', { class: 'grid-2' },
        h('label', {}, 'Title', h('input', { name: 'title', required: true, value: item?.title || '' })),
        h('label', {}, 'Quantity', h('input', { name: 'quantity', type: 'number', min: 1, value: item?.quantity || 1 }))
      ),
      h('label', {}, 'Description', h('textarea', { name: 'description' }, item?.description || '')),
      h('div', { class: 'grid-2' },
        h('label', {}, 'Photo', h('input', { name: 'image', type: 'file', accept: 'image/*' })),
        h('label', {}, '…or image URL', h('input', { name: 'imageUrl', type: 'url', placeholder: 'https://', value: item?.image?.startsWith('http') ? item.image : '' }))
      ),
      item?.image && h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'removeImage', value: 'true' }), 'Remove current image'),
      h('div', { class: 'row' }, h('button', { class: 'primary', type: 'submit' }, item ? 'Save item' : 'Add item'))
    );

  const editItem = (item) => {
    const dlg = h('dialog', {}, h('div', { class: 'row spread' }, h('h2', {}, 'Edit item'), h('button', { class: 'ghost icon-btn', onclick: () => dlg.close(), 'aria-label': 'Close' }, '✕')), itemForm(item));
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
  };

  const itemTile = (item) =>
    h(
      'div',
      { class: 'item-tile' },
      thumb(item, 'img'),
      h(
        'div',
        { class: 'body' },
        h('strong', {}, item.title),
        h('div', { class: 'stat' }, '♥ ', h('b', {}, item.likes), ' want · ✕ ', h('b', {}, item.passes), ' pass · ', h('b', {}, item.quantity), ' available'),
        h(
          'div',
          { class: 'row', style: { marginTop: 'auto' } },
          h('button', { onclick: () => editItem(item) }, 'Edit'),
          h(
            'button',
            {
              class: 'ghost',
              onclick: action(async () => {
                if (!(await confirmDialog(`Delete "${item.title}"?`))) return;
                await api('DELETE', `/api/admin/items/${item.id}`);
                refresh();
              }),
            },
            '🗑'
          )
        )
      )
    );

  // --- members ---
  const memberIds = new Set(data.members.map((m) => m.id));
  const swipedBy = new Map(data.members.map((m) => [m.id, m.swiped]));
  const membersCard = h(
    'form',
    {
      class: 'card',
      onsubmit: action(async (e) => {
        const ids = [...e.target.querySelectorAll('input[name=member]:checked')].map((el) => Number(el.value));
        await api('PUT', `/api/admin/collections/${id}/members`, { userIds: ids });
        toast('Participants saved');
        refresh();
      }),
    },
    users.length
      ? users.map((u) =>
          h(
            'label',
            { class: 'item-row check' },
            h('input', { type: 'checkbox', name: 'member', value: u.id, checked: memberIds.has(u.id) }),
            h(
              'div',
              { class: 'grow' },
              h('div', { class: 'name' }, u.name, u.status === 'invited' ? ' (invited)' : ''),
              h('div', { class: 'muted small' }, u.email)
            ),
            memberIds.has(u.id) && h('span', { class: 'muted small' }, `${swipedBy.get(u.id)}/${data.items.length} swiped`),
            u.status === 'invited' && h('button', { type: 'button', onclick: (e) => { e.preventDefault(); inviteDialog(u); } }, '✉️')
          )
        )
      : h('p', { class: 'muted' }, 'No people yet.'),
    h('div', { class: 'row', style: { marginTop: '12px' } }, h('button', { class: 'primary', type: 'submit' }, 'Save participants'))
  );

  // --- results ---
  let results = null;
  if (c.state === 'closed') {
    const byUser = new Map();
    for (const a of data.allocations) {
      if (!byUser.has(a.userId)) byUser.set(a.userId, { name: a.userName, list: [] });
      byUser.get(a.userId).list.push(a);
    }
    const allocatedCount = new Map();
    data.allocations.forEach((a) => allocatedCount.set(a.itemId, (allocatedCount.get(a.itemId) || 0) + 1));
    const leftovers = data.items
      .map((i) => ({ ...i, left: i.quantity - (allocatedCount.get(i.id) || 0) }))
      .filter((i) => i.left > 0);
    const collected = data.allocations.filter((a) => a.collected).length;

    results = h(
      'div',
      { class: 'section' },
      h('h2', {}, 'Results'),
      h('p', { class: 'muted' }, `${data.allocations.length} items allocated · ${collected} collected. Tick items off as people pick them up.`),
      byUser.size
        ? h(
            'div',
            { class: 'list' },
            [...byUser.values()].map((group) =>
              h(
                'div',
                { class: 'card' },
                h('h3', {}, `${group.name} · ${group.list.length}`),
                group.list.map((a) =>
                  h(
                    'label',
                    { class: 'item-row check' },
                    h('input', {
                      type: 'checkbox',
                      checked: a.collected,
                      onchange: action(async (e) => {
                        await api('PATCH', `/api/admin/allocations/${a.id}`, { collected: e.target.checked });
                      }),
                    }),
                    h('span', { class: 'grow' }, a.itemTitle)
                  )
                )
              )
            )
          )
        : h('div', { class: 'card empty' }, 'Nobody wanted anything in this collection.'),
      leftovers.length > 0 &&
        h(
          'div',
          { class: 'section' },
          h('h3', {}, 'Unclaimed'),
          h('div', { class: 'card' }, leftovers.map((i) => h('div', { class: 'item-row' }, thumb(i), h('div', { class: 'grow name' }, i.title), h('span', { class: 'muted small' }, `${i.left} left`))))
        )
    );
  }

  mount(
    backBar('#/admin', c.name, countdown(c, { reload: true })),
    c.state === 'draft' && h('p', { class: 'card small' }, '📝 This collection is a draft. Add items and people, then tick "Published" so participants can start swiping.'),
    results,
    h('div', { class: 'section' }, h('h2', {}, 'Details'), details),
    h(
      'div',
      { class: 'section' },
      h('h2', {}, `Items (${data.items.length})`),
      h('div', { class: 'card' }, h('h3', {}, 'Add an item'), itemForm(null)),
      data.items.length > 0 && h('div', { class: 'items-grid section' }, data.items.map(itemTile))
    ),
    h(
      'div',
      { class: 'section' },
      h('h2', {}, `Participants (${data.members.length})`),
      membersCard,
      h('div', { class: 'section' }, inviteForm({ collectionId: id, onCreated: refresh }))
    )
  );
}
