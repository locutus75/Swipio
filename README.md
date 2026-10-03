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
- Create collections with a name, description and closing time; keep them as drafts until published
- Add items with a title, description, quantity and a photo (upload or image URL)
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

## Running it

Requires **Node.js 22.5+** (it uses the built-in `node:sqlite`, so there are no native modules to compile).

```bash
npm install
npm start          # http://localhost:3000
```

On the first visit you create the admin account. Then create a collection, add items,
invite people, and tick **Published**.

### Configuration

| Variable         | Default      | Purpose                                                          |
| ---------------- | ------------ | ---------------------------------------------------------------- |
| `PORT`           | `3000`       | HTTP port                                                        |
| `DATA_DIR`       | `./data`     | Where the SQLite database and uploaded images are stored         |
| `PUBLIC_URL`     | request host | Base URL used in invite links, e.g. `https://swipio.example.com` |
| `SECURE_COOKIES` | `false`      | Set to `true` when served over HTTPS                             |

Back up `DATA_DIR` to keep your data.

## Development

```bash
npm run dev   # restarts on file changes
npm test      # allocation unit tests + API integration tests
```

- `server.js`: entry point; also closes expired collections every 30 seconds
- `src/app.js`: Express app and REST API (`/api/...`)
- `src/db.js`: SQLite schema
- `src/allocation.js`: fair allocation algorithm
- `public/`: the frontend, a single-page app in plain JavaScript with no build step

Security notes: passwords are hashed with scrypt; sessions are random tokens in an
HttpOnly, SameSite=Lax cookie; every state-changing API call needs an
`X-Requested-With: swipio` header as CSRF protection; uploads accept image types only, up to 8 MB.
