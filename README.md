# Swipio

Tinder-style swiping, but for items. Anyone can sign up, put items into a **collection**, set a
deadline and invite people. Participants swipe right on what they want and left on what
they don't. When the timer runs out the items are allocated and everyone sees what they
can pick up.

## Features

**Participants**
- Mobile-first swipe deck: drag/swipe cards, or use the ✕ / ♥ buttons or ← → keys
- Undo the last swipe, and change any choice under "My choices" until the deadline
- Live countdown per collection
- When it closes: "You get N items" with the pickup status of each one

**Accounts and privacy**
- Anyone can **create an account** (*Create one* on the login page) and start making collections
  straight away. People you invite can do the same
- A collection is only visible to the person who made it, the people they picked as **co-managers**,
  and the people **invited** to swipe on it. Nobody else sees it or its people
- The maker has full control over their collection: items, deadline, participants, who chose what,
  results, hand-outs and pickups, reopening and deleting (*Settings → Delete collection*)
- **Co-managers** (Settings → *Who can manage this*, picked from the collection's participants) can
  do the same, except delete or reopen it, or change who else may manage it. Per co-manager the
  **♥ Likes** switch says whether they may also like items themselves; switched off they only manage
  (the collection isn't in their swipe list and their likes don't count in the allocation)
- Invite people by name and email. Someone who already has an account is added straight away;
  anyone else gets an invite link to copy, email or share, and sets their own password
- A collection's **People** tab lists only the people invited to that collection. Tick who may swipe;
  unticked people stay listed, and **✕** takes someone off the list (they need a new invite to come back)
- **Admins** run the platform: they see and can manage every collection, and manage all accounts
  under *Manage → People* (make someone admin, reset a password, **block** or delete an account).
  The first account is the admin. Admins never take part in collections themselves: they can't be
  ticked or invited as participants, and someone made admin is taken out of their collections
- New sign-ups are capped at `SIGNUPS_PER_HOUR` (30) per hour. An optional bot check
  (Cloudflare Turnstile) can be switched on; see [Bot check on sign-up](#bot-check-on-sign-up-optional)

**Creating collections**
- Create collections with a name, description and closing time (quick picks: 1 day, 3 days, 1 week, 2 weeks); keep them as drafts until you tap **Publish**
- Built for adding items from a phone: tap **Take photo**, type a name, tap **Save & next photo**
  and the camera opens again for the next item. Or pick several photos from the gallery and name
  them in one list. Items upload in the background while you carry on, and photos are shrunk in
  the browser first, so even big phone photos upload quickly. Items can also have a description,
  a quantity, or an image link instead of a photo
- Close a collection early. **Reopen** a closed one with a new deadline (the collection's maker and
  admins only) to add items: participants then only swipe what they haven't judged yet and can still
  change earlier choices. The allocation is saved as a version and set aside, except items already
  picked up, which stay with their person; everything else is handed out again at the new deadline

**People and results** (for whoever manages the collection)
- Per collection: what each person wants and passed on, and who wants each item
- Results page per person, with a checkbox to mark items as collected, plus a list of unclaimed items

### How items are allocated

When a collection closes:
0. Items in the same **group** count as **one product**, and nobody gets more than one of it. Set
   the group in an item's edit panel (*Max 1 per person: group*), e.g. "Dopper" for two different
   Dopper mugs; the app suggests an existing group when the name mentions it. Items without a
   group are grouped by name (ignoring capitals and extra spaces), so "Dopper" added three times is
   one product with 3 units.
1. If no more people liked an item than there are units, everyone who liked it gets one.
2. Contested items go to the people who liked them and have been allocated the **fewest
   items so far**. Remaining ties are broken by a seeded random draw, so results are fair
   and can be reproduced. The least contested items are handed out first.

**After the allocation.** On a closed collection's Results tab whoever manages it can:
- See under **Not handed out** why each leftover item wasn't given to anyone (e.g. *Wanted by Kim*,
  *Taken away from Egbert*, *Only liked by someone who no longer participates*, *Nobody wanted this*).
- **Take items away** from someone (✕ per item, or *Take all away*). The units become free, and
  that person is skipped for those items in any later allocation. *↩ Undo* reverses this.
- **Hand out**, in one of two ways:
  - *Hand out free items only*: everyone keeps what they have; free and taken-away items go to
    others who wanted them.
  - *Redo everything*: throw the allocation away and draw again. Each redo uses a new round in the
    random seed, so ties can fall differently. Items already ticked off as picked up stay with
    their person (unless you untick that option) and count towards that person's total.

Both use everyone's likes and the participant list as they are now. Take-aways only steer the next
hand-out: once items are handed out again (or the collection is re-opened) they are forgotten.

- **Duplicates warning**: if someone holds more than one item of the same product (e.g. from an
  older allocation, picked-up items, or a restored version), a warning lists it with a
  *Keep one, free the rest* button. The Items tab flags items whose name mentions a group they're
  not in (*Group Dopper?*).
- **Reset**: removes the whole allocation (who gets what, pickups and take-aways); a version is saved
  first. Afterwards use *Hand out* or reopen the collection.
- **Versions**: before every change above (and before a restore or import) the allocation is saved
  automatically; the newest 30 per collection are kept under *Versions* on the Results tab. **Restore**
  puts one back (including pickup status and take-aways). **⬇ Export** downloads the current
  allocation as a JSON file and **⬆ Import** puts such a file back; items and people are matched by
  id, or by item name and email if they were re-added, and anything that no longer exists is skipped
  and listed.
- **Change someone's likes** (People tab → tap the ♥ chip next to a participant): set ♥ or ✕ per item,
  or tap the active one again to clear it. Works after closing too; the next *Hand out* uses it.

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
invite people, and tick **Published**. Others can sign up via *Create one* on the login page.

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

- **Frontend:** set the domain under *Settings > Pages > Custom domain* (with GitHub Actions
  deploys no `CNAME` file is needed), then add it to `ALLOWED_ORIGINS` in `wrangler.toml`, the
  list of sites allowed to call the API. Without that the site shows "Cannot reach the Swipio
  server". Swipio currently runs at https://swipio.hihybi.org.
- **API:** add a custom domain to the Worker in Cloudflare, and set the repository **variable**
  `SWIPIO_API_URL` (e.g. `https://api.swipio.example`) so the site uses it.

### Bot check on sign-up (optional)

Sign-up is open to everyone. To keep bots out, switch on Cloudflare Turnstile (free):
1. In the Cloudflare dashboard go to *Turnstile > Add widget*, name it Swipio, add the hostname
   of the site (e.g. `swipio.hihybi.org`) and choose *Managed*.
2. In this repo (*Settings > Secrets and variables > Actions*) add the **secret**
   `TURNSTILE_SECRET` (the widget's secret key) and the **variable** `SWIPIO_TURNSTILE_SITE_KEY`
   (its site key).
3. Push to `main` (or re-run the deploy). The sign-up page then shows the check and the API verifies it.

Without these, sign-up works without a bot check. Admins can always block accounts under *Manage → People*.

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
