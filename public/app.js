'use strict';

/* Swipio single-page frontend. No build step, no framework. */

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const $app = document.getElementById('app');
let me = null;

// participant < creator < manager < admin: each role can do everything the roles below it can.
const ROLES = ['participant', 'creator', 'manager', 'admin'];
const ROLE_LABELS = { participant: 'Participant', creator: 'Creator', manager: 'Manager', admin: 'Admin' };
const ROLE_HINTS = {
  participant: 'Swipes on collections they are invited to',
  creator: 'Also creates and runs their own collections',
  manager: 'Also sees all collections, who chose what, and manages people',
  admin: 'Can do everything, including managing admins',
};
const roleRank = (role) => ROLES.indexOf(role);
/** True if the signed-in user has at least this role. */
const can = (role) => !!me && roleRank(me.role) >= roleRank(role);
/** Roles the signed-in user may hand out: up to their own. */
const grantableRoles = () => ROLES.filter((r) => roleRank(r) <= roleRank(me.role));
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

/**
 * fetch() that retries when the network fails outright (no response at all), which happens on
 * flaky mobile connections. POSTs aren't retried because they could create something twice.
 */
async function fetchWithRetry(url, opts) {
  const retries = opts.method === 'POST' ? 0 : 2;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, opts);
    } catch (cause) {
      if (attempt >= retries) {
        console.error('Swipio API unreachable:', opts.method, url, cause);
        const err = new Error('Cannot reach the Swipio server. Check your connection and try again.');
        err.network = true;
        err.detail = `${opts.method} ${new URL(url, location.href).pathname}: ${cause.message || cause}`;
        throw err;
      }
      await new Promise((r) => setTimeout(r, attempt ? 1500 : 500));
    }
  }
}

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (memoryToken) opts.headers.Authorization = `Bearer ${memoryToken}`;
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetchWithRetry(API_URL + url, opts);
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
  const image = await loadImage(file);
  const w = image.naturalWidth || image.width;
  const hgt = image.naturalHeight || image.height;
  const scale = Math.min(1, max / Math.max(w, hgt));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(hgt * scale);
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  image.close?.();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
  if (!blob) throw new Error('That photo could not be processed.');
  return blob;
}

/** Decodes a photo, honouring its rotation. Falls back to <img> where createImageBitmap is limited. */
async function loadImage(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } catch {
      throw new Error('That file could not be read as an image.');
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }
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
    can('creator') && h('a', { class: 'btn', href: '#/admin' }, '⚙️ Manage'),
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
  [/^#\/admin$/, viewAdmin, { role: 'creator' }],
  [/^#\/admin\/users$/, viewAdminUsers, { role: 'manager' }],
  [/^#\/admin\/c\/(\d+)(?:\/(items|people|results|settings))?$/, viewAdminCollection, { role: 'creator' }],
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
    if (opts.role && !can(opts.role)) return go('#/');
    await view(...params);
  } catch (err) {
    if (err.status === 401) {
      me = null;
      return go('#/login');
    }
    mount(
      topbar(),
      h(
        'div',
        { class: 'empty' },
        h('div', { class: 'big' }, '😕'),
        h('p', {}, err.message),
        h('div', { class: 'row', style: { justifyContent: 'center' } },
          h('button', { class: 'primary', onclick: () => render() }, 'Try again'),
          h('a', { class: 'btn', href: '#/' }, 'Go home')
        ),
        err.detail && h('p', { class: 'small muted' }, err.detail)
      )
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
          can('creator') && h('a', { class: 'btn primary', href: '#/admin' }, 'Create a collection')
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
    can('manager') && h('button', { class: current === 'users' ? 'active' : '', onclick: () => go('#/admin/users') }, 'People')
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
    !collectionId && h('label', {}, 'Role', roleSelect('participant')),
    h('button', { class: 'primary', type: 'submit' }, 'Create invite')
  );
}

/** Role picker with a one-line explanation of the chosen role underneath. */
function roleSelect(value, attrs = {}) {
  const hint = h('div', { class: 'muted small', style: { marginTop: '6px', fontWeight: 'normal' } }, ROLE_HINTS[value]);
  const select = h(
    'select',
    { name: 'role', ...attrs },
    grantableRoles().map((r) => h('option', { value: r, selected: r === value }, ROLE_LABELS[r]))
  );
  select.addEventListener('change', () => (hint.textContent = ROLE_HINTS[select.value]));
  return h('div', {}, select, hint);
}

function roleBadge(role) {
  return role && role !== 'participant' ? h('span', { class: `badge role-${role}` }, ROLE_LABELS[role]) : null;
}

/** Everything you can do with one person: role, invite link / password reset, delete. */
function openUserSheet(u, onChange) {
  const self = u.id === me.id;
  const manageable = !self && roleRank(u.role) <= roleRank(me.role);
  const badge = () => roleBadge(u.role) || h('span', { class: 'badge' }, 'Participant');
  let currentBadge = badge();
  const body = h(
    'div',
    { class: 'stack' },
    h('div', {}, h('div', { class: 'name' }, u.name), h('div', { class: 'muted small' }, u.email)),
    h('div', { class: 'row' }, currentBadge, u.status === 'invited' ? h('span', { class: 'badge' }, 'Invited') : h('span', { class: 'badge open' }, 'Active')),
    self && h('p', { class: 'muted small' }, "This is you. Someone else has to change your role."),
    !self && !manageable && h('p', { class: 'muted small' }, `Only an admin can change ${ROLE_LABELS[u.role]} accounts.`),
    manageable &&
      h('label', {}, 'Role', roleSelect(u.role, {
        onchange: action(async (e) => {
          await api('PATCH', `/api/admin/users/${u.id}`, { role: e.target.value });
          u.role = e.target.value;
          const next = badge();
          currentBadge.replaceWith(next);
          currentBadge = next;
          toast(`${u.name} is now ${ROLE_LABELS[u.role]}`);
          onChange();
        }),
      })),
    u.status === 'invited' && u.inviteToken && h('button', { onclick: () => inviteDialog(u) }, '✉️ Show invite link'),
    manageable &&
      u.status === 'active' &&
      h('button', {
        onclick: action(async () => {
          if (!(await confirmDialog(`Reset ${u.name}'s password? They will get a new invite link.`))) return;
          const { user } = await api('POST', `/api/admin/users/${u.id}/invite`);
          dlg.close();
          inviteDialog(user);
          onChange();
        }),
      }, '🔑 Reset password'),
    manageable &&
      h('button', {
        class: 'danger',
        onclick: action(async () => {
          if (!(await confirmDialog(`Delete ${u.name}? Their swipes and items will be removed.`))) return;
          await api('DELETE', `/api/admin/users/${u.id}`);
          dlg.close();
          onChange();
        }),
      }, 'Delete')
  );
  const dlg = openSheet('Person', body);
}

async function viewAdminUsers() {
  const { users } = await api('GET', '/api/admin/users');
  const row = (u) =>
    h(
      'button',
      { class: 'item-row item-button', onclick: () => openUserSheet(u, () => render()) },
      h('div', { class: 'thumb' }, u.name.charAt(0).toUpperCase()),
      h('div', { class: 'grow' }, h('div', { class: 'name' }, u.name, ' ', roleBadge(u.role)), h('div', { class: 'muted small' }, u.email)),
      u.status === 'invited' && h('span', { class: 'badge' }, 'Invited'),
      h('span', { class: 'chev', 'aria-hidden': 'true' }, '›')
    );

  mount(
    topbar(h('a', { class: 'btn', href: '#/' }, '🃏 Swipe'), ...userMenu().slice(1)),
    h('h1', {}, 'Manage'),
    adminTabs('users'),
    inviteForm({ onCreated: () => render() }),
    h('div', { class: 'section card' }, users.map(row))
  );
}

async function viewAdmin() {
  const { collections } = await api('GET', '/api/admin/collections');
  mount(
    topbar(h('a', { class: 'btn', href: '#/' }, '🃏 Swipe'), ...userMenu().slice(1)),
    h('h1', {}, 'Manage'),
    adminTabs('collections'),
    h('button', { class: 'primary block big-btn', onclick: openNewCollectionSheet }, '＋ New collection'),
    h(
      'div',
      { class: 'section list' },
      collections.length
        ? collections.map((c) =>
            h(
              'a',
              { class: 'card collection-card', href: `#/admin/c/${c.id}` },
              h('div', { class: 'row spread' }, h('h3', {}, c.name), countdown(c)),
              h('div', { class: 'muted small' }, `${plural(c.itemCount, 'item')} · ${plural(c.memberCount, 'person', 'people')} · closes ${formatDate(c.expiresAt)}`),
              can('manager') && c.createdBy && c.createdBy.id !== me.id && h('div', { class: 'muted small' }, `by ${c.createdBy.name}`)
            )
          )
        : h('div', { class: 'empty' }, h('div', { class: 'big' }, '📦'), h('p', {}, can('manager') ? 'No collections yet. Create one, then snap photos of the items.' : "You haven't created any collections yet. Create one, then snap photos of the items."))
    )
  );
}

function plural(n, one, many = one + 's') {
  return `${n} ${n === 1 ? one : many}`;
}

const DAY = 24 * 3600 * 1000;

/** A deadline `days` from now, rounded up to the next whole hour. */
function deadlineIn(days) {
  const d = new Date(Date.now() + days * DAY);
  if (d.getMinutes() || d.getSeconds()) d.setHours(d.getHours() + 1, 0, 0, 0);
  return d.getTime();
}

/** Quick-pick buttons (1 day, 3 days, …) plus a date field that shows and fine-tunes the choice. */
function deadlinePicker(initial) {
  const input = h('input', { name: 'expiresAt', type: 'datetime-local', required: true, value: toLocalInput(initial) });
  const options = [['1 day', 1], ['3 days', 3], ['1 week', 7], ['2 weeks', 14]];
  const chips = options.map(([label, days]) =>
    h('button', {
      type: 'button',
      class: 'chip',
      onclick: () => {
        input.value = toLocalInput(deadlineIn(days));
        chips.forEach((c) => c.classList.toggle('on', c === chipFor(days)));
      },
    }, label)
  );
  const chipFor = (days) => chips[options.findIndex(([, d]) => d === days)];
  input.addEventListener('input', () => chips.forEach((c) => c.classList.remove('on')));
  return h('div', { class: 'stack' }, h('div', { class: 'chips' }, chips), input);
}

function openNewCollectionSheet() {
  const name = h('input', { name: 'name', required: true, maxlength: 120, placeholder: 'e.g. Office move giveaway', autocapitalize: 'sentences' });
  const form = h(
    'form',
    {
      class: 'stack',
      onsubmit: action(async (e) => {
        const f = formData(e.target);
        const { collection } = await api('POST', '/api/admin/collections', {
          name: f.name,
          description: f.description,
          expiresAt: new Date(f.expiresAt).getTime(),
        });
        dlg.close();
        go(`#/admin/c/${collection.id}/items`);
      }),
    },
    h('label', {}, 'Name', name),
    h('label', {}, 'Swiping closes', deadlinePicker(deadlineIn(7))),
    h('label', {}, 'Description', h('textarea', { name: 'description', rows: 2, placeholder: 'Pickup location, rules… (optional)' })),
    h('button', { class: 'primary block big-btn', type: 'submit' }, 'Create & add items')
  );
  const dlg = openSheet('New collection', form);
  name.focus();
}

// ---------------------------------------------------------------------------
// Sheets, photo picking and background uploads (used by the admin screens)
// ---------------------------------------------------------------------------

/** A dialog that slides up from the bottom on phones and is centred on bigger screens. */
function openSheet(title, content, { onClose } = {}) {
  const dlg = h(
    'dialog',
    { class: 'sheet' },
    h('div', { class: 'sheet-head' }, h('h2', {}, title), h('button', { class: 'ghost icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => dlg.close() }, '✕')),
    content
  );
  dlg.addEventListener('close', () => {
    dlg.remove();
    onClose?.();
  });
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

/**
 * Opens the camera or the photo library and resolves with the chosen files ([] if cancelled).
 * Must be called straight from a tap: browsers only open pickers in response to one.
 */
function pickPhotos({ camera = false, multiple = false } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
    if (camera) input.setAttribute('capture', 'environment');
    input.multiple = multiple;
    const done = (files) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => done([...input.files]));
    input.addEventListener('cancel', () => done([]));
    document.body.append(input);
    input.click();
  });
}

function stepper(name, value = 1) {
  const input = h('input', { name, type: 'number', min: 1, max: 10000, value, inputmode: 'numeric', 'aria-label': 'Quantity' });
  const bump = (d) => {
    input.value = Math.max(1, (parseInt(input.value, 10) || 1) + d);
  };
  return h(
    'div',
    { class: 'stepper' },
    h('button', { type: 'button', 'aria-label': 'One less', onclick: () => bump(-1) }, '−'),
    input,
    h('button', { type: 'button', 'aria-label': 'One more', onclick: () => bump(1) }, '+')
  );
}

/**
 * New items are uploaded one after another in the background, so an admin can keep taking
 * photos without waiting. Each entry shows in the item list until it's saved (or fails).
 */
const uploads = { entries: [], chain: Promise.resolve(), listener: null };

function queueItemUpload(collectionId, item) {
  const entry = {
    collectionId: Number(collectionId),
    title: item.title,
    quantity: item.quantity,
    description: item.description || '',
    file: item.file || null,
    preview: item.file ? URL.createObjectURL(item.file) : null,
    status: 'queued',
  };
  uploads.entries.push(entry);
  runUpload(entry);
}

function runUpload(entry) {
  entry.status = 'queued';
  notifyUploads(entry, false);
  uploads.chain = uploads.chain.then(async () => {
    if (!uploads.entries.includes(entry)) return; // removed while waiting
    entry.status = 'uploading';
    notifyUploads(entry, false);
    try {
      const fd = new FormData();
      fd.set('title', entry.title);
      fd.set('quantity', String(entry.quantity));
      fd.set('description', entry.description);
      if (entry.file) fd.set('image', await resizeImage(entry.file), 'photo.jpg');
      await api('POST', `/api/admin/collections/${entry.collectionId}/items`, fd);
      uploads.entries = uploads.entries.filter((e) => e !== entry);
      if (entry.preview) URL.revokeObjectURL(entry.preview);
      notifyUploads(entry, true);
    } catch (err) {
      entry.status = 'failed';
      entry.error = err.message;
      notifyUploads(entry, false);
    }
  });
}

function removeUpload(entry) {
  uploads.entries = uploads.entries.filter((e) => e !== entry);
  if (entry.preview) URL.revokeObjectURL(entry.preview);
  notifyUploads(entry, false);
}

function notifyUploads(entry, saved) {
  renderUploadPill();
  uploads.listener?.(entry, saved);
}

/** Small floating status, visible on every screen while uploads are running or have failed. */
function renderUploadPill() {
  let pill = document.getElementById('upload-pill');
  const active = uploads.entries.filter((e) => e.status !== 'failed').length;
  const failed = uploads.entries.length - active;
  if (!uploads.entries.length) return pill?.remove();
  if (!pill) {
    pill = h('a', { id: 'upload-pill' });
    document.body.append(pill);
  }
  pill.href = `#/admin/c/${uploads.entries[0].collectionId}/items`;
  pill.classList.toggle('failed', !active);
  pill.textContent = active
    ? `⬆ Uploading ${plural(active, 'item')}…`
    : `⚠ ${plural(failed, 'item')} not uploaded. Tap to retry`;
}

window.addEventListener('beforeunload', (e) => {
  if (uploads.entries.some((x) => x.status !== 'failed')) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ---------------------------------------------------------------------------
// Admin: one collection
// ---------------------------------------------------------------------------

async function viewAdminCollection(id, tab) {
  const [data, { users }] = await Promise.all([api('GET', `/api/admin/collections/${id}`), api('GET', '/api/admin/users')]);
  const c = data.collection;
  const canAddItems = c.state !== 'closed';
  const tabs = [
    ['items', () => `Items (${data.items.length})`],
    ['people', () => `People (${data.members.length})`],
    c.state === 'closed' && ['results', () => 'Results'],
    ['settings', () => 'Settings'],
  ].filter(Boolean);
  let current = tabs.some(([k]) => k === tab) ? tab : c.state === 'closed' ? 'results' : 'items';
  const reopen = (t = current) => viewAdminCollection(id, t);

  async function reloadItems() {
    const fresh = await api('GET', `/api/admin/collections/${id}`);
    data.items = fresh.items;
    drawItems();
    drawCounts();
  }

  // --- status + main action ---
  const counts = h('div', { class: 'muted small' });
  const drawCounts = () => {
    counts.textContent = `${plural(data.items.length, 'item')} · ${plural(data.members.length, 'person', 'people')}`;
    tabBar.querySelectorAll('button').forEach((b, i) => (b.textContent = tabs[i][1]()));
  };

  const publish = action(async () => {
    const problems = [];
    if (!data.items.length) problems.push('there are no items yet');
    if (!data.members.length) problems.push('nobody has been invited yet');
    if (problems.length && !(await confirmDialog(`Publish anyway? Note that ${problems.join(' and ')}.`))) return;
    await api('PATCH', `/api/admin/collections/${id}`, { published: true });
    toast('Published! Invited people can start swiping.');
    reopen();
  });

  const closeNow = action(async () => {
    if (!(await confirmDialog('Close this collection now and allocate the items?'))) return;
    await api('POST', `/api/admin/collections/${id}/close`);
    reopen('results');
  });

  const statusCard = h(
    'div',
    { class: 'card status-card' },
    h('div', { class: 'grow' }, h('div', { class: 'row' }, countdown(c, { reload: true })), counts),
    c.state === 'draft' && h('button', { class: 'primary', onclick: publish }, '🚀 Publish'),
    c.state === 'open' && h('button', { onclick: closeNow }, '⏹ Close now')
  );

  // --- items ---
  const itemsList = h('div', {});

  function drawItems() {
    const pending = uploads.entries.filter((e) => e.collectionId === Number(id));
    const pendingRow = (e) =>
      h(
        'div',
        { class: 'item-row' },
        e.preview ? h('img', { class: 'thumb', src: e.preview, alt: '' }) : thumb(e),
        h(
          'div',
          { class: 'grow' },
          h('div', { class: 'name' }, e.title),
          h('div', { class: e.status === 'failed' ? 'small error-text' : 'muted small' },
            e.status === 'failed' ? `Not uploaded: ${e.error}` : e.status === 'uploading' ? 'Uploading…' : 'Waiting to upload…')
        ),
        e.status === 'failed'
          ? [h('button', { onclick: () => runUpload(e) }, 'Retry'), h('button', { class: 'ghost icon-btn', 'aria-label': 'Discard', onclick: () => removeUpload(e) }, '✕')]
          : h('span', { class: 'spinner', 'aria-hidden': 'true' })
      );
    const itemRow = (item) =>
      h(
        'button',
        { class: 'item-row item-button', onclick: () => openItemSheet({ item }) },
        thumb(item),
        h(
          'div',
          { class: 'grow' },
          h('div', { class: 'name' }, item.title),
          h('div', { class: 'muted small' }, `${item.quantity} available · ♥ ${item.likes} · ✕ ${item.passes}`)
        ),
        h('span', { class: 'chev', 'aria-hidden': 'true' }, '›')
      );
    const rows = [...pending.map(pendingRow), ...[...data.items].reverse().map(itemRow)];
    itemsList.replaceChildren(
      rows.length
        ? h('div', { class: 'card' }, rows)
        : h(
            'div',
            { class: 'empty' },
            h('div', { class: 'big' }, '📸'),
            h('p', {}, canAddItems ? 'No items yet. Tap "Take photo" below, give it a name, and keep going.' : 'This collection has no items.')
          )
    );
  }

  let refreshTimer;
  uploads.listener = (entry, saved) => {
    if (entry.collectionId !== Number(id)) return;
    drawItems();
    if (saved) {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => reloadItems().catch(() => {}), 300);
    }
  };
  viewCleanups.push(() => {
    uploads.listener = null;
    clearTimeout(refreshTimer);
  });

  /** Add or edit one item. `source` remembers camera vs gallery for "Save & next". */
  function openItemSheet({ item = null, file = null, source = null } = {}) {
    let photo = file;
    let removeImage = false;
    let previewUrl = null;

    const preview = h('div', { class: 'photo-box' });
    const drawPreview = () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = photo ? URL.createObjectURL(photo) : null;
      const src = previewUrl || (!removeImage && item?.image ? apiAsset(item.image) : null);
      const content = src
        ? [
            h('img', { src, alt: '' }),
            h(
              'div',
              { class: 'photo-actions' },
              h('button', { type: 'button', onclick: () => choose(true) }, '📷 Retake'),
              h('button', { type: 'button', onclick: () => choose(false) }, '🖼 Change'),
              h('button', { type: 'button', 'aria-label': 'Remove photo', onclick: () => ((photo = null), (removeImage = true), drawPreview()) }, '✕')
            ),
          ]
        : [
            h(
              'div',
              { class: 'photo-empty' },
              h('button', { type: 'button', class: 'primary', onclick: () => choose(true) }, '📷 Take photo'),
              h('button', { type: 'button', onclick: () => choose(false) }, '🖼 Choose photo')
            ),
          ];
      preview.replaceChildren(...content);
    };
    const choose = (camera) => {
      source = camera ? 'camera' : 'gallery';
      pickPhotos({ camera }).then((files) => {
        if (!files[0]) return;
        photo = files[0];
        removeImage = false;
        drawPreview();
        if (!title.value) title.focus();
      });
    };

    const title = h('input', {
      name: 'title',
      required: true,
      maxlength: 120,
      placeholder: 'What is it?',
      value: item?.title || '',
      autocomplete: 'off',
      autocapitalize: 'sentences',
      enterkeyhint: item ? 'done' : 'next',
    });
    const qty = stepper('quantity', item?.quantity || 1);
    const desc = h('textarea', { name: 'description', rows: 2, placeholder: 'Condition, size, colour… (optional)' }, item?.description || '');
    const imageUrl = h('input', { name: 'imageUrl', type: 'url', placeholder: 'https://…', value: item?.image?.startsWith('http') ? item.image : '' });

    const reset = () => {
      photo = null;
      removeImage = false;
      form.reset();
      title.value = '';
      qty.querySelector('input').value = 1;
      desc.value = '';
      drawPreview();
    };

    async function saveEdit() {
      const fd = new FormData();
      fd.set('title', title.value);
      fd.set('quantity', qty.querySelector('input').value);
      fd.set('description', desc.value);
      if (photo) fd.set('image', await resizeImage(photo), 'photo.jpg');
      else if (removeImage) fd.set('removeImage', 'true');
      else if (imageUrl.value && imageUrl.value !== item.image) fd.set('imageUrl', imageUrl.value);
      await api('PATCH', `/api/admin/items/${item.id}`, fd);
      toast('Item updated');
      dlg.close();
      await reloadItems();
    }

    const form = h(
      'form',
      {
        class: 'stack',
        onsubmit: (e) => {
          e.preventDefault();
          if (item) return action(saveEdit)(e);
          // New item: hand it to the background uploader and move on immediately.
          queueItemUpload(id, {
            title: title.value.trim(),
            quantity: Number(qty.querySelector('input').value) || 1,
            description: desc.value.trim(),
            file: photo || null,
          });
          const next = (e.submitter?.value || 'next') === 'next';
          if (!next) return dlg.close();
          const again = source;
          reset();
          // Still inside the tap, so the browser lets us open the camera again right away.
          if (again) choose(again === 'camera');
          else title.focus();
        },
      },
      preview,
      h('label', {}, 'Name', title),
      h('div', { class: 'row spread' }, h('span', { class: 'label' }, 'How many?'), qty),
      h('label', {}, 'Description', desc),
      item && data.seeChoices &&
        h('p', { class: 'small muted' }, likersOf(item.id).length ? `♥ Wanted by ${likersOf(item.id).join(', ')}` : '♥ Nobody wants this yet'),
      item &&
        h('details', {}, h('summary', { class: 'muted small' }, 'Use an image link instead'), h('label', { class: 'small' }, 'Image URL', imageUrl)),
      item
        ? h(
            'div',
            { class: 'row spread' },
            h('button', { class: 'primary grow-btn', type: 'submit' }, 'Save'),
            h(
              'button',
              {
                type: 'button',
                class: 'danger',
                onclick: action(async () => {
                  if (!(await confirmDialog(`Delete "${item.title}"?`))) return;
                  await api('DELETE', `/api/admin/items/${item.id}`);
                  dlg.close();
                  await reloadItems();
                }),
              },
              'Delete'
            )
          )
        : h(
            'div',
            { class: 'sheet-actions' },
            h('button', { class: 'primary', type: 'submit', name: 'mode', value: 'next' }, source ? 'Save & next photo' : 'Save & add another'),
            h('button', { type: 'submit', name: 'mode', value: 'done' }, 'Save & close')
          )
    );

    drawPreview();
    const dlg = openSheet(item ? 'Edit item' : 'New item', form, {
      onClose: () => previewUrl && URL.revokeObjectURL(previewUrl),
    });
    if (!item) title.focus();
  }

  /** Several photos from the gallery: name them all in one list, then upload together. */
  function openBulkSheet(files) {
    const rows = files.map((file) => {
      const url = URL.createObjectURL(file);
      const row = h(
        'div',
        { class: 'bulk-row' },
        h('img', { class: 'thumb', src: url, alt: '' }),
        h('div', { class: 'grow stack-sm' },
          h('input', { name: 'title', required: true, maxlength: 120, placeholder: 'What is it?', autocapitalize: 'sentences', enterkeyhint: 'next' }),
          stepper('quantity', 1)
        ),
        h('button', { type: 'button', class: 'ghost icon-btn', 'aria-label': 'Skip this photo', onclick: () => { row.remove(); URL.revokeObjectURL(url); updateButton(); } }, '✕')
      );
      row.file = file;
      row.url = url;
      return row;
    });
    const list = h('div', { class: 'bulk-list' }, rows);
    const submit = h('button', { class: 'primary block big-btn', type: 'submit' });
    const updateButton = () => {
      const n = list.children.length;
      submit.textContent = `Add ${plural(n, 'item')}`;
      submit.disabled = !n;
    };
    const form = h(
      'form',
      {
        class: 'stack',
        onsubmit: (e) => {
          e.preventDefault();
          for (const row of list.children) {
            queueItemUpload(id, {
              title: row.querySelector('[name=title]').value.trim(),
              quantity: Number(row.querySelector('[name=quantity]').value) || 1,
              file: row.file,
            });
          }
          dlg.close();
        },
      },
      h('p', { class: 'muted small' }, 'Give each photo a name. They upload in the background.'),
      list,
      submit
    );
    updateButton();
    const dlg = openSheet(`${plural(files.length, 'photo')}`, form, {
      onClose: () => rows.forEach((r) => URL.revokeObjectURL(r.url)),
    });
    list.querySelector('input')?.focus();
  }

  const takePhoto = () =>
    pickPhotos({ camera: true }).then((files) => files[0] && openItemSheet({ file: files[0], source: 'camera' }));
  const fromGallery = () =>
    pickPhotos({ multiple: true }).then((files) => {
      if (files.length === 1) openItemSheet({ file: files[0], source: 'gallery' });
      else if (files.length) openBulkSheet(files);
    });

  const actionBar = h(
    'div',
    { class: 'action-bar' },
    h('button', { class: 'primary', onclick: takePhoto }, '📷 Take photo'),
    h('button', { onclick: fromGallery }, '🖼 Gallery'),
    h('button', { class: 'icon-btn', title: 'Add without a photo', 'aria-label': 'Add without a photo', onclick: () => openItemSheet() }, '✎')
  );

  // --- people ---
  // Managers+: who liked/passed what, per person and per item.
  const choicesOf = (userId) => data.choices.filter((c) => c.userId === userId);
  const likersOf = (itemId) =>
    data.choices.filter((c) => c.itemId === itemId && c.liked).map((c) => data.members.find((m) => m.id === c.userId)?.name).filter(Boolean);

  function openChoicesSheet(member) {
    const mine = choicesOf(member.id);
    const itemById = new Map(data.items.map((i) => [i.id, i]));
    const list = (liked) =>
      mine
        .filter((c) => c.liked === liked && itemById.has(c.itemId))
        .map((c) => itemById.get(c.itemId))
        .map((item) => h('div', { class: 'item-row' }, thumb(item), h('div', { class: 'grow name' }, item.title)));
    const wants = list(true);
    const passes = list(false);
    const open = data.items.length - mine.length;
    openSheet(
      `${member.name}'s choices`,
      h(
        'div',
        { class: 'stack' },
        h('p', { class: 'muted small' }, `${plural(wants.length, 'item')} wanted · ${passes.length} passed · ${open} not swiped yet`),
        h('h3', {}, '♥ Wants'),
        wants.length ? h('div', { class: 'card' }, wants) : h('p', { class: 'muted' }, 'Nothing yet.'),
        passes.length > 0 && h('details', {}, h('summary', { class: 'muted' }, `✕ Passed (${passes.length})`), h('div', { class: 'card' }, passes))
      )
    );
  }

  const renderPeople = () => {
    const memberIds = new Set(data.members.map((m) => m.id));
    const swipedBy = new Map(data.members.map((m) => [m.id, m.swiped]));
    return h(
      'div',
      {},
      h(
        'form',
        {
          class: 'card',
          onsubmit: action(async (e) => {
            const ids = [...e.target.querySelectorAll('input[name=member]:checked')].map((el) => Number(el.value));
            await api('PUT', `/api/admin/collections/${id}/members`, { userIds: ids });
            toast('Participants saved');
            reopen('people');
          }),
        },
        h('p', { class: 'muted small', style: { marginTop: 0 } }, 'Tick who can swipe on this collection.'),
        users.length
          ? users.map((u) =>
              h(
                'label',
                { class: 'item-row check' },
                h('input', { type: 'checkbox', name: 'member', value: u.id, checked: memberIds.has(u.id) }),
                h('div', { class: 'grow' }, h('div', { class: 'name' }, u.name, u.status === 'invited' ? ' (invited)' : ''), h('div', { class: 'muted small' }, u.email)),
                memberIds.has(u.id) && !data.seeChoices && h('span', { class: 'muted small' }, `${swipedBy.get(u.id)}/${data.items.length}`),
                memberIds.has(u.id) && data.seeChoices &&
                  h('button', {
                    type: 'button',
                    class: 'chip',
                    title: 'See what they chose',
                    onclick: (e) => { e.preventDefault(); openChoicesSheet(data.members.find((m) => m.id === u.id)); },
                  }, `♥ ${choicesOf(u.id).filter((c) => c.liked).length} · ${swipedBy.get(u.id)}/${data.items.length}`),
                u.status === 'invited' && u.inviteToken && h('button', { type: 'button', 'aria-label': 'Invite link', onclick: (e) => { e.preventDefault(); inviteDialog(u); } }, '✉️')
              )
            )
          : h('p', { class: 'muted' }, can('manager') ? 'No people yet. Invite someone below.' : 'No people yet.'),
        h('div', { class: 'row', style: { marginTop: '12px' } }, h('button', { class: 'primary', type: 'submit' }, 'Save participants'))
      ),
      can('manager')
        ? h('div', { class: 'section' }, inviteForm({ collectionId: id, onCreated: () => reopen('people') }))
        : h('p', { class: 'muted small section' }, 'Someone new? Ask a manager to invite them, then tick them here.')
    );
  };

  // --- settings ---
  const renderSettings = () =>
    h(
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
          reopen('settings');
        }),
      },
      h('label', {}, 'Name', h('input', { name: 'name', required: true, value: c.name })),
      h('label', {}, 'Swiping closes', deadlinePicker(c.expiresAt)),
      h('label', {}, 'Description', h('textarea', { name: 'description', rows: 3 }, c.description)),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'published', checked: c.published }), 'Published: invited people can see and swipe this collection'),
      h('button', { class: 'primary', type: 'submit' }, 'Save'),
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
        'Delete collection'
      )
    );

  // --- results ---
  const renderResults = () => (data.seeChoices ? renderResultsByPerson() : renderResultTotals());

  // Creators: how many of each item were handed out, without who got what.
  const renderResultTotals = () => {
    const units = data.items.reduce((n, i) => n + i.quantity, 0);
    const given = data.items.reduce((n, i) => n + Math.min(i.allocated, i.quantity), 0);
    return h(
      'div',
      {},
      h('p', { class: 'muted' }, `${given} of ${plural(units, 'unit')} handed out. A manager can see who gets what and track pickups.`),
      h(
        'div',
        { class: 'card' },
        data.items.map((i) =>
          h('div', { class: 'item-row' }, thumb(i), h('div', { class: 'grow name' }, i.title),
            h('span', { class: i.allocated ? 'badge open' : 'badge' }, i.allocated ? `${i.allocated}/${i.quantity} taken` : 'Unclaimed'))
        )
      )
    );
  };

  const renderResultsByPerson = () => {
    const byUser = new Map();
    for (const a of data.allocations) {
      if (!byUser.has(a.userId)) byUser.set(a.userId, { name: a.userName, list: [] });
      byUser.get(a.userId).list.push(a);
    }
    const allocatedCount = new Map();
    data.allocations.forEach((a) => allocatedCount.set(a.itemId, (allocatedCount.get(a.itemId) || 0) + 1));
    const leftovers = data.items.map((i) => ({ ...i, left: i.quantity - (allocatedCount.get(i.id) || 0) })).filter((i) => i.left > 0);
    const collected = data.allocations.filter((a) => a.collected).length;
    return h(
      'div',
      {},
      h('p', { class: 'muted' }, `${plural(data.allocations.length, 'item')} allocated · ${collected} collected. Tick items off as people pick them up.`),
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
                        a.collected = e.target.checked;
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
  };

  // --- tabs ---
  const renderers = {
    items: () => h('div', {}, itemsList),
    people: renderPeople,
    settings: renderSettings,
    results: renderResults,
  };
  const body = h('div', {});
  const tabBar = h(
    'div',
    { class: 'tabs', role: 'tablist' },
    tabs.map(([key]) => h('button', { role: 'tab', 'data-tab': key, onclick: () => show(key) }))
  );
  function show(key) {
    current = key;
    history.replaceState(null, '', `#/admin/c/${id}/${key}`);
    tabBar.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.tab === key));
    body.replaceChildren(renderers[key]());
    const withBar = key === 'items' && canAddItems;
    actionBar.hidden = !withBar;
    $app.classList.toggle('has-action-bar', withBar);
  }
  viewCleanups.push(() => $app.classList.remove('has-action-bar'));

  drawItems();
  mount(
    backBar('#/admin', c.name),
    statusCard,
    c.state === 'draft' && data.items.length === 0 &&
      h('p', { class: 'muted small' }, '📝 Draft: add items and invite people, then tap Publish so they can start swiping.'),
    tabBar,
    body,
    actionBar
  );
  drawCounts();
  show(current);
}
