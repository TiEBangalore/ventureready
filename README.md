# VentureReady

A prototype of TiE Bangalore's investor-readiness platform: founders get a free
AI positioning diagnostic, submit their deck for expert review, and — once they
earn the **VentureReady** mark — become visible to screened investors.

- **Frontend:** a single file, [`index.html`](index.html) (HTML + CSS + vanilla JS).
- **Backend:** [`server.py`](server.py) — Python standard library only
  (`http.server` + `sqlite3`). **No pip packages required to run it.**
- **Database:** SQLite (`data.db`), created automatically on first run.

## Running it locally

Requires Python 3 (already on macOS / most Linux).

```bash
cd Code
cp .env.example .env      # then fill in the real keys — see below
python3 server.py
```

Then open **http://localhost:8000** in a browser.

On macOS you can also just double-click **`Start VentureReady.command`**.

## Configuration (`.env`)

Copy `.env.example` to `.env` and fill in the values. The real `.env` is
git-ignored and must never be committed.

| Variable | Purpose | If missing |
|----------|---------|------------|
| `ZOHO_CLIENT_ID` / `ZOHO_CLIENT_SECRET` | TiE membership verification at login (Zoho Creator API) | Membership check disabled; rest of app works |
| `ANTHROPIC_API_KEY` | Live AI positioning diagnostic (Claude) | Falls back to a canned sample result |
| `ANTHROPIC_MODEL` | Optional — pin a specific Claude model | Uses the default model |

## What's in the repo (and what isn't)

Committed: the application code only. The following are **intentionally excluded**
via [`.gitignore`](.gitignore) because they are secrets or private user data, and
are recreated locally at runtime:

- `.env`, `secrets/` — API keys and credentials
- `data.db` — the live database (real founder records + password hashes)
- `decks/`, `dataroom/` — founders' uploaded pitch decks and diligence documents

## Roles

Founder · Expert Reviewer (TiE Charter Member) · Investor (screened) · TiE Admin.

## Security note

Founder passwords are stored as salted **PBKDF2-SHA256** hashes (never in plain
text). This is **prototype-grade** authentication with no rate-limiting, email
verification, or sessions — it must be replaced with a vetted auth service before
any production use.
