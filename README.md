# Swipio

Tinder-style swiping, but for items. An admin puts items into a **collection**, sets a
deadline and invites people. Participants swipe right on what they want and left on what
they don't. When the timer runs out the items are allocated and everyone sees what they
can pick up.

## Features

**Participants**
- Mobile-first swipe deck: drag/swipe cards, or use the ✕ / ♥ buttons or ← → keys
- Undo the last swipe, and change any choice under "My choices" until the deadline
- Live countdown per collection
- When it closes: "You get N items" with the pickup status of each one

**Admins**
- Create collections with a name, description and closing time (quick picks: 1 day, 3 days, 1 week, 2 weeks); keep them as drafts until you tap **Publish**
- Built for adding items from a phone: tap **Take photo**, type a name, tap **Save & next photo**
  and the camera opens again for the next item. Or pick several photos from the gallery and name
  them in one list. Items upload in the background while you carry on, and photos are shrunk in
  the browser first, so even big phone photos upload quickly. Items can also have a description,
  a quantity, or an image link instead of a photo
- See how many people want or pass on each item, and how far each participant has got
- Invite people by name and email. You get an invite link to copy, email or share; the
  person sets their own password. Invite straight into a collection, or pick participants from everyone
- Close a collection early, or move the deadline later to re-open it
- Results page per person, with a checkbox to mark items as collected, plus a list of unclaimed items
- Manage people: roles, password reset (gives a new invite link), delete

### How items are allocated

When a collection closes:
1. If no more people liked an item than there are units, everyone who liked it gets one.
2. Contested items go to the people who liked them and have been allocated the **fewest
   items so far**. Remaining ties are broken by a seeded random draw, so results are fair
   and can be reproduced. The least contested items are handed out first.

See `src/allocation.js`.

## How it fits together

```
 frontend (GitHub Pages)                    API (Cloudflare Worker)            database (Cloudflare D1)
 ───────────────────────                    ───────────────────────            ────────────────────────
 public/: plain HTML/CSS/JS,      ──►   src/api.js: /api/...          ──►   users, collections, items,
 no build step. config.js says           login, swiping, admin,              swipes, allocations, photos
 where the API is.                       allocation. A cron trigger
                                         closes expired collections
                                         every minute.
```

Same setup as SysCommander: the site is static on GitHub Pages and the server part is a
Cloudflare Worker. D1's free tier is plenty. The only CPU-heavy step is hashing passwords at
sign-up (about 15 ms), which suits the **Workers Paid** plan that SysCommander's referee already
uses. On the Free plan (10 ms per request) set `PASSWORD_ITERATIONS = "50000"` in `wrangler.toml`.

## Running it locally

Requires Node.js 22.5+.

```bash
npm install
npm run dev        # http://localhost:3100
```

This runs the real Worker and a local D1 database (in `.wrangler/`) with Cloudflare's
`wrangler` tool, and serves the frontend on the same port. No Cloudflare account is needed.
On the first visit you create the admin account. Then create a collection, add items,
invite people, and tick **Published**.

```bash
npm test           # allocation unit tests + API tests (runs the Worker against an in-memory database)
```

## Deploying

The workflow in `.github/workflows/deploy.yml` tests every push. On pushes to `main` it also
deploys the API to Cloudflare and the frontend to GitHub Pages. One-time setup:

1. **Cloudflare API token.** In the Cloudflare dashboard go to *My Profile > API Tokens >
   Create Token*, use the **Edit Cloudflare Workers** template and add the permission
   *Account > D1 > Edit*. Your **Account ID** is in the dashboard sidebar (Workers & Pages).
   If you've never deployed a Worker on this account, also pick your **workers.dev subdomain**
   once: *Workers & Pages* in the dashboard, then follow the prompt (or *Settings > Subdomain*).
2. **GitHub secrets.** In this repo go to *Settings > Secrets and variables > Actions* and add
   the secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
3. **GitHub Pages.** In *Settings > Pages* set **Source** to **GitHub Actions**.
4. **Push to `main`.** The first run creates the `swipio` D1 database, sets up its tables,
   deploys the Worker (to `https://swipio.<your-subdomain>.workers.dev`) and publishes the site
   to `https://locutus75.github.io/Swipio/`.

Open the site and create the admin account. Do this straight away: until an admin exists,
whoever opens the site first can claim it.

### Custom domains

- **Frontend:** add a `public/CNAME` file containing the domain (as SysCommander does) and set
  it under *Settings > Pages*. Then add the domain to `ALLOWED_ORIGINS` in `wrangler.toml`, the
  list of sites allowed to call the API.
- **API:** add a custom domain to the Worker in Cloudflare, and set the repository **variable**
  `SWIPIO_API_URL` (e.g. `https://api.swipio.example`) so the site uses it.

### Deploying by hand

```bash
npx wrangler login
npx wrangler d1 create swipio     # once; paste the database_id into wrangler.toml
npm run deploy                    # applies migrations, deploys the Worker
```

Then set `apiUrl` in `public/config.js` to the Worker URL and publish `public/` anywhere static.

## Project layout

- `src/worker.js`: Worker entry point (HTTP and cron)
- `src/api.js`: the REST API
- `src/allocation.js`: fair allocation algorithm
- `src/auth.js`: password hashing (PBKDF2) and tokens, using Web Crypto
- `migrations/`: D1 database schema. Add a new numbered file for schema changes; the deploy applies it
- `public/`: the frontend, a single-page app in plain JavaScript with no build step
- `test/`: tests; `d1-shim.js` imitates D1 on top of `node:sqlite`

Security notes: passwords are hashed with PBKDF2 (100,000 rounds by default); sessions are random bearer
tokens, stored in the browser's localStorage and only as a SHA-256 hash in the database;
`ALLOWED_ORIGINS` limits which sites may call the API; photos must be JPEG, PNG, GIF, WebP or AVIF, max 1.5 MB.
