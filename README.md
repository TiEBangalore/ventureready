# VentureReady

A prototype of TiE Bangalore's investor-readiness platform: founders get a free
AI positioning diagnostic, submit their deck for expert review, and — once they
earn the **VentureReady** mark — become visible to screened investors.

- **Frontend:** a single file, [`index.html`](index.html) (HTML + CSS + vanilla JS).
- **Backend:** [`server.js`](server.js) — Node.js. Uses Node's built-in `http`
  and `crypto`, plus `better-sqlite3` for the database (and optional
  `pdf-parse` / `adm-zip` / `sharp` for reading uploaded decks).
- **Database:** SQLite (`data.db`), created automatically on first run.

> The original Python backend [`server.py`](server.py) is kept in the repo for
> reference. `server.js` is a 1:1 behavioural port — same routes, same JSON, same
> database and the **same password hashing**, so the existing `data.db` keeps
> working unchanged. New work should happen in `server.js`.

## Running it locally

Requires **Node.js 18 or newer** (`node --version` to check).

```bash
cd Code
cp .env.example .env      # then fill in the real keys — see below
npm install               # first time only — installs the dependencies
npm start                 # (or: node server.js)
```

Then open **http://localhost:8000** in a browser.

On macOS you can also just double-click **`Start VentureReady.command`** — it
runs `npm install` automatically the first time.

## Deploying to Render

The Node server (`server.js`) is host-ready: it binds to `PORT`/`0.0.0.0` and
reads config from **environment variables** (which override the local `.env`).
A [`render.yaml`](render.yaml) blueprint is included.

1. In Render: **New → Blueprint**, connect this (private) repo. It reads
   `render.yaml` and pre-fills build (`npm install`) and start (`npm start`).
2. Set each config value in the Render dashboard (the same keys as `.env`;
   they're marked `sync: false` so they're never committed). Do **not** upload
   `.env`.
3. Add your live URL (e.g. `https://ventureready.onrender.com`) as an
   **Authorized JavaScript origin** on the Google OAuth client, or Google
   sign-in will fall back to demo.

**Data persistence — important.** Render's **free** plan uses an ephemeral
disk, so `data.db` and uploaded `decks/` + `dataroom/` files are **wiped on
every redeploy/restart**. That's fine for previewing and wiring integrations,
but **before real founders/investors use it**:

- change `plan: free` to a paid plan, **and**
- attach a **Persistent Disk** (uncomment the `disk:` block in `render.yaml`,
  e.g. mount at `/var/data`) and set `DATA_DIR` to that mount path.

`DATA_DIR` tells the app where to keep the database and uploads; it defaults to
the app folder locally.

## Configuration (`.env`)

Copy `.env.example` to `.env` and fill in the values. The real `.env` is
git-ignored and must never be committed.

| Variable | Purpose | If missing |
|----------|---------|------------|
| `ZOHO_CLIENT_ID` / `ZOHO_CLIENT_SECRET` | TiE membership verification at login (Zoho Creator API) | Membership check disabled; rest of app works |
| `GOOGLE_CLIENT_ID` | "Continue with Google" sign-in (public OAuth Client ID from Google Cloud Console). Add your app's URL as an Authorized JavaScript origin. | Google button falls back to the demo sign-in |
| `ANTHROPIC_API_KEY` | Live AI positioning diagnostic (Claude) | Falls back to a canned sample result |
| `ANTHROPIC_MODEL` | Optional — pin a specific Claude model | Uses the default model |
| `FOUNDER_DIAGNOSTIC_CAP` / `FOUNDER_DIAGNOSTIC_WINDOW_DAYS` | Abuse control — how many **fresh** (paid) AI reads one founder may run per rolling window. Re-running the identical deck is free (cached) and never counts. | Defaults to 2 reads per 30 days; set the cap to 0 to disable |
| `TIE_MEMBERSHIP_URL` | TiE Bangalore's membership page. Membership is **not** paid for in this app — the "Join TiE Bangalore" buttons hand off to this URL, and the app then re-checks membership against Zoho. Founders pick "Associate Membership" (₹10,000 + GST/yr) there. | Join buttons are hidden; founders are told to email admin.blr@tiebangalore.org |
| `EXPERT_REVIEW_PAYMENT_URL` | Razorpay payment link for the one-time expert review (₹3,000 + GST). Payment happens **on Razorpay** — the button hands off to this link and records the intent so admins can reconcile it in the Razorpay dashboard. | Falls back to the in-app demo checkout |
| `ADMIN_EMAILS` | First-run **seed** of extra admin emails for the Team Portal (comma-separated). After first run the list is managed in-app by a super-admin. | Only the super-admins can sign in |
| `ADMIN_SUPER_EMAILS` | Super-admins (comma-separated) who can add/remove admins in-app and can't be removed | Defaults to `admin.blr@tiebangalore.org,chinmay@tiebangalore.org` |

## What's in the repo (and what isn't)

Committed: the application code only. The following are **intentionally excluded**
via [`.gitignore`](.gitignore) because they are secrets or private user data, and
are recreated locally at runtime:

- `.env`, `secrets/` — API keys and credentials
- `data.db` — the live database (real founder records + password hashes)
- `decks/`, `dataroom/` — founders' uploaded pitch decks and diligence documents
- `node_modules/` — installed dependencies (recreated by `npm install`)

## Roles

Founder · Expert Reviewer (TiE Charter Member) · Investor (screened) · TiE Admin.

## Security note

Founder passwords are stored as salted **PBKDF2-SHA256** hashes (never in plain
text). This is **prototype-grade** authentication with no rate-limiting, email
verification, or sessions — it must be replaced with a vetted auth service before
any production use.
