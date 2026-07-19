"""
VentureReady demo app server.
Serves the prototype (index.html) and provides two LIVE endpoints:
  - POST /api/verify-member  -> checks an email against TiE Bangalore's Zoho membership data
  - POST /api/diagnostic     -> runs the AI positioning read (uses Claude if a key is set, else a canned result)
Run:  python3 server.py    then open http://localhost:8000
"""
import json, time, os, io, base64, sqlite3, urllib.parse, urllib.request, urllib.error
import hashlib, hmac, secrets, re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))

# ---- Local database (SQLite). Proves real persistence: data survives refresh AND restart. ----
DB_PATH = os.path.join(HERE, "data.db")
def _db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn
def db_init():
    conn = _db()
    conn.execute("""CREATE TABLE IF NOT EXISTS support(
        id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT, from_name TEXT, role TEXT,
        category TEXT, subject TEXT, message TEXT, status TEXT DEFAULT 'New',
        received TEXT, created_at TEXT)""")
    # Each founder is one row. email is unique so the same person maps to one record.
    conn.execute("""CREATE TABLE IF NOT EXISTS founder(
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT UNIQUE, company TEXT,
        role TEXT, phone TEXT, city TEXT, stage TEXT, sector TEXT, linkedin TEXT,
        created_at TEXT)""")
    # Migration: older databases don't have password columns. SQLite has no
    # "ADD COLUMN IF NOT EXISTS", so we check the existing columns first.
    _cols = [r["name"] for r in conn.execute("PRAGMA table_info(founder)").fetchall()]
    if "password_hash" not in _cols:
        conn.execute("ALTER TABLE founder ADD COLUMN password_hash TEXT")
    if "password_salt" not in _cols:
        conn.execute("ALTER TABLE founder ADD COLUMN password_salt TEXT")
    # Membership snapshot columns. These CACHE Zoho's answer, refreshed at each
    # sign-in (Zoho stays the source of truth). membership_stale=1 means the last
    # refresh couldn't reach Zoho, so these values are the last CONFIRMED status.
    for _mcol, _mtype in (("is_member", "INTEGER"), ("membership_status", "TEXT"),
                          ("membership_category", "TEXT"), ("membership_name", "TEXT"),
                          ("membership_checked_at", "TEXT"), ("membership_stale", "INTEGER")):
        if _mcol not in _cols:
            conn.execute("ALTER TABLE founder ADD COLUMN %s %s" % (_mcol, _mtype))
    # google_sub = Google's stable, unique ID for the account (the "sub" claim).
    # We match on this first so a founder who later changes their Gmail address
    # still maps to the same record. Nullable: password-only accounts don't have it.
    if "google_sub" not in _cols:
        conn.execute("ALTER TABLE founder ADD COLUMN google_sub TEXT")
    # Each uploaded deck: the file lives on disk (stored_path); the DB keeps a pointer + owner.
    conn.execute("""CREATE TABLE IF NOT EXISTS deck(
        id INTEGER PRIMARY KEY AUTOINCREMENT, founder_id INTEGER, filename TEXT,
        stored_path TEXT, size INTEGER, uploaded_at TEXT)""")
    # Each AI read is saved against the founder + the deck it read.
    conn.execute("""CREATE TABLE IF NOT EXISTS diagnostic(
        id INTEGER PRIMARY KEY AUTOINCREMENT, founder_id INTEGER, deck_id INTEGER,
        live INTEGER, summary TEXT, findings_json TEXT, created_at TEXT)""")
    # Expert review rounds. round 1 = the paid review; round 2 = the ONE free
    # re-review; round 3+ = paid again. verdict: 'not_yet' | 'awarded'.
    conn.execute("""CREATE TABLE IF NOT EXISTS review(
        id INTEGER PRIMARY KEY AUTOINCREMENT, founder_id INTEGER, round INTEGER,
        verdict TEXT, gaps_json TEXT, reviewer TEXT, note TEXT, created_at TEXT)""")
    # Data room: one row per checklist item a founder has supplied a document for.
    # item_key ties the file back to the diligence checklist in the front-end.
    conn.execute("""CREATE TABLE IF NOT EXISTS dataroom_doc(
        id INTEGER PRIMARY KEY AUTOINCREMENT, founder_id INTEGER, item_key TEXT,
        filename TEXT, stored_path TEXT, size INTEGER, uploaded_at TEXT)""")
    # Who opened which data-room document — the "who's actually interested" signal.
    conn.execute("""CREATE TABLE IF NOT EXISTS dataroom_view(
        id INTEGER PRIMARY KEY AUTOINCREMENT, founder_id INTEGER, doc_id INTEGER,
        item_key TEXT, viewer TEXT, viewed_at TEXT)""")
    # Admin allow-list: who may enter the Team/Admin portal. A super-admin edits
    # this from inside the portal, so this table is the LIVE source of truth. On
    # first run it is seeded from the super-admins + ADMIN_EMAILS (.env).
    conn.execute("""CREATE TABLE IF NOT EXISTS admin_allowlist(
        email TEXT PRIMARY KEY, added_by TEXT, added_at TEXT)""")
    _admin_seed = set(ADMIN_SUPER_EMAILS)
    for _e in ENV.get("ADMIN_EMAILS", "").split(","):
        _e = _e.strip().lower()
        if _e:
            _admin_seed.add(_e)
    for _e in _admin_seed:
        conn.execute("INSERT OR IGNORE INTO admin_allowlist(email, added_by, added_at) "
                     "VALUES(?,?,datetime('now'))", (_e, "seed"))
    # Notifications: one row per important event, recorded even when email is off.
    conn.execute("""CREATE TABLE IF NOT EXISTS notification(
        id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT, recipient TEXT,
        subject TEXT, body TEXT, urgency TEXT, created_at TEXT)""")
    # Email outbox: one row per recipient. status: 'pending' | 'sent' | 'failed'.
    # In record-only mode (no SMTP configured) rows simply stay 'pending'.
    conn.execute("""CREATE TABLE IF NOT EXISTS email_outbox(
        id INTEGER PRIMARY KEY AUTOINCREMENT, notification_id INTEGER, to_email TEXT,
        subject TEXT, body TEXT, status TEXT DEFAULT 'pending', error TEXT,
        created_at TEXT, sent_at TEXT)""")
    conn.commit()
    if conn.execute("SELECT COUNT(*) c FROM support").fetchone()["c"] == 0:
        seeds = [
            ("SUP-204", "Meera Suresh", "Founder", "TiE membership verification",
             "My member email isn't recognised at the gate", "", "New", "3h ago"),
            ("SUP-203", "Narendra Bhandari", "Investor", "Login or access problem",
             "Colleague can't accept the firm invite", "", "In progress", "Yesterday"),
            ("SUP-202", "Rajan Kumar", "Reviewer", "My review status",
             "Which deck is next in my queue?", "", "Resolved", "2 days ago"),
        ]
        conn.executemany("INSERT INTO support(ref,from_name,role,category,subject,message,status,received,created_at) "
                         "VALUES(?,?,?,?,?,?,?,?,datetime('now'))", seeds)
        conn.commit()
    conn.close()
def support_add(d):
    conn = _db()
    cur = conn.execute("INSERT INTO support(ref,from_name,role,category,subject,message,status,received,created_at) "
                       "VALUES('',?,?,?,?,?,'New','Just now',datetime('now'))",
                       (d.get("from_name", ""), d.get("role", ""), d.get("category", ""),
                        d.get("subject", ""), d.get("message", "")))
    rid = cur.lastrowid
    ref = "SUP-%d" % (204 + rid)
    conn.execute("UPDATE support SET ref=? WHERE id=?", (ref, rid))
    conn.commit()
    row = dict(conn.execute("SELECT * FROM support WHERE id=?", (rid,)).fetchone())
    conn.close()
    return row
def support_list():
    conn = _db()
    rows = [dict(r) for r in conn.execute("SELECT * FROM support ORDER BY id DESC").fetchall()]
    conn.close()
    return {"support": rows}

# ---- Founders (real per-user records) ----
DECKS_DIR = os.path.join(HERE, "decks")

# --- Password handling (PROTOTYPE-GRADE, not production security) ---
# Passwords are never stored or logged in plaintext. Each founder gets a random
# per-user salt; we store only the PBKDF2-SHA256 hash. A real deployment should
# replace this with a vetted auth service and add rate-limiting / email verify.
def _hash_pw(password, salt=None):
    if salt is None:
        salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", (password or "").encode("utf-8"),
                             salt.encode("utf-8"), 100000)
    return dk.hex(), salt

def _public_founder(row):
    """Strip secret columns so a founder's password hash never leaves the server."""
    if row is None:
        return None
    out = dict(row)
    out.pop("password_hash", None)
    out.pop("password_salt", None)
    return out

def founder_signup(d):
    """Register a founder with a password. Errors if the email already has one."""
    conn = _db()
    email = (d.get("email") or "").strip().lower()
    password = d.get("password") or ""
    if not email or not password:
        conn.close()
        return {"error": "Email and password are required."}
    existing = conn.execute("SELECT * FROM founder WHERE email=?", (email,)).fetchone()
    if existing and existing["password_hash"]:
        conn.close()
        return {"error": "That email is already registered. Please log in instead."}
    pw_hash, pw_salt = _hash_pw(password)
    fields = ("name", "company", "role", "phone", "city", "stage", "sector", "linkedin")
    vals = [d.get(f, "") for f in fields]
    if existing:
        conn.execute("UPDATE founder SET name=?,company=?,role=?,phone=?,city=?,stage=?,sector=?,linkedin=?,"
                     "password_hash=?,password_salt=? WHERE id=?",
                     tuple(vals) + (pw_hash, pw_salt, existing["id"]))
        fid = existing["id"]
    else:
        cur = conn.execute("INSERT INTO founder(name,email,company,role,phone,city,stage,sector,linkedin,"
                           "password_hash,password_salt,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,datetime('now'))",
                           (d.get("name", ""), email) + tuple(vals[1:]) + (pw_hash, pw_salt))
        fid = cur.lastrowid
    conn.commit()
    row = conn.execute("SELECT * FROM founder WHERE id=?", (fid,)).fetchone()
    conn.close()
    # Check TiE membership with Zoho as part of signing up, so the new profile
    # already shows the correct member status.
    refreshed = refresh_membership(fid)
    return {"founder": _public_founder(refreshed or row)}

def founder_login(email, password):
    """Verify credentials in constant time. Returns the public profile or an error."""
    conn = _db()
    email = (email or "").strip().lower()
    row = conn.execute("SELECT * FROM founder WHERE email=?", (email,)).fetchone()
    conn.close()
    if not row or not row["password_hash"] or not row["password_salt"]:
        return {"error": "No account found for that email, or it has no password set."}
    calc, _ = _hash_pw(password, row["password_salt"])
    if not hmac.compare_digest(calc, row["password_hash"]):
        return {"error": "Incorrect email or password."}
    # Re-check TiE membership with Zoho on every sign-in and cache the result.
    refreshed = refresh_membership(row["id"])
    return {"founder": _public_founder(refreshed or row)}

def founder_upsert(d):
    """Create or update a founder by email, then return the full row (with its id)."""
    conn = _db()
    email = (d.get("email") or "").strip().lower()
    fields = ("name", "company", "role", "phone", "city", "stage", "sector", "linkedin")
    vals = [d.get(f, "") for f in fields]
    existing = None
    if email:
        existing = conn.execute("SELECT * FROM founder WHERE email=?", (email,)).fetchone()
    if existing:
        conn.execute("UPDATE founder SET name=?,company=?,role=?,phone=?,city=?,stage=?,sector=?,linkedin=? WHERE id=?",
                     tuple(vals) + (existing["id"],))
        fid = existing["id"]
    else:
        cur = conn.execute("INSERT INTO founder(name,email,company,role,phone,city,stage,sector,linkedin,created_at) "
                           "VALUES(?,?,?,?,?,?,?,?,?,datetime('now'))",
                           (d.get("name", ""), email) + tuple(vals[1:]))
        fid = cur.lastrowid
    conn.commit()
    row = _public_founder(conn.execute("SELECT * FROM founder WHERE id=?", (fid,)).fetchone())
    conn.close()
    return row

def founder_get(fid):
    conn = _db()
    r = conn.execute("SELECT * FROM founder WHERE id=?", (fid,)).fetchone()
    out = _public_founder(r) if r else None
    if out:
        dg = conn.execute("SELECT d.*, k.filename FROM diagnostic d LEFT JOIN deck k ON k.id=d.deck_id "
                          "WHERE d.founder_id=? ORDER BY d.id DESC LIMIT 1", (fid,)).fetchone()
        if dg:
            out["latest_diagnostic"] = {
                "live": bool(dg["live"]), "summary": dg["summary"],
                "findings": json.loads(dg["findings_json"] or "[]"), "filename": dg["filename"] or "",
            }
    conn.close()
    return out

def deck_add(founder_id, filename, raw):
    """Save the uploaded deck file to disk and record a row pointing to it."""
    if not os.path.isdir(DECKS_DIR):
        os.makedirs(DECKS_DIR)
    safe = "".join(c for c in (filename or "deck.pdf") if c.isalnum() or c in "._- ")
    stored = "f%s_%d_%s" % (founder_id or 0, int(time.time()), safe)
    path = os.path.join(DECKS_DIR, stored)
    with open(path, "wb") as fh:
        fh.write(raw)
    conn = _db()
    cur = conn.execute("INSERT INTO deck(founder_id,filename,stored_path,size,uploaded_at) "
                       "VALUES(?,?,?,?,datetime('now'))", (founder_id, filename, stored, len(raw)))
    did = cur.lastrowid
    conn.commit()
    conn.close()
    return did

# ---- Expert review rounds & the one-free-re-review rule ----
FREE_REREVIEW_ROUND = 2      # round 1 = paid review, round 2 = the single free re-review
REREVIEW_FEE = "₹3,000 + GST"

def review_add(founder_id, verdict, gaps, reviewer, note):
    """Record a reviewer's verdict as the next round for this founder."""
    conn = _db()
    last = conn.execute("SELECT MAX(round) m FROM review WHERE founder_id=?", (founder_id,)).fetchone()
    rnd = (last["m"] or 0) + 1
    conn.execute("INSERT INTO review(founder_id,round,verdict,gaps_json,reviewer,note,created_at) "
                 "VALUES(?,?,?,?,?,?,datetime('now'))",
                 (founder_id, rnd, verdict, json.dumps(gaps or []), reviewer or "TiE Reviewer", note or ""))
    conn.commit()
    conn.close()
    return review_state(founder_id)

def review_state(founder_id):
    """Everything the founder's screens need: history, latest verdict, and whether
    the next re-review is the free one or has to be paid for."""
    conn = _db()
    rows = [dict(r) for r in conn.execute(
        "SELECT round,verdict,gaps_json,reviewer,note,created_at FROM review "
        "WHERE founder_id=? ORDER BY round", (founder_id,)).fetchall()]
    conn.close()
    for r in rows:
        r["gaps"] = json.loads(r.pop("gaps_json") or "[]")
    latest = rows[-1] if rows else None
    rounds_done = len(rows)
    next_round = rounds_done + 1
    return {
        "rounds": rows,
        "latest": latest,
        "rounds_done": rounds_done,
        "next_round": next_round,
        # The single free re-review is round 2 and only if they haven't already earned the mark.
        "free_rereview_available": (next_round == FREE_REREVIEW_ROUND
                                    and bool(latest) and latest["verdict"] == "not_yet"),
        "free_rereview_used": rounds_done >= FREE_REREVIEW_ROUND,
        "rereview_fee": REREVIEW_FEE,
    }

# ---- Data room (diligence documents) ----
DATAROOM_DIR = os.path.join(HERE, "dataroom")

def dataroom_add(founder_id, item_key, filename, raw):
    """Save a diligence document and point the checklist item at it.
    One document per checklist item — re-uploading replaces the previous file's row."""
    if not os.path.isdir(DATAROOM_DIR):
        os.makedirs(DATAROOM_DIR)
    safe = "".join(c for c in (filename or "doc.pdf") if c.isalnum() or c in "._- ")
    stored = "f%s_%s_%d_%s" % (founder_id or 0, (item_key or "item")[:24], int(time.time()), safe)
    with open(os.path.join(DATAROOM_DIR, stored), "wb") as fh:
        fh.write(raw)
    conn = _db()
    conn.execute("DELETE FROM dataroom_doc WHERE founder_id=? AND item_key=?", (founder_id, item_key))
    cur = conn.execute("INSERT INTO dataroom_doc(founder_id,item_key,filename,stored_path,size,uploaded_at) "
                       "VALUES(?,?,?,?,?,datetime('now'))",
                       (founder_id, item_key, filename, stored, len(raw)))
    did = cur.lastrowid
    conn.commit()
    conn.close()
    return did

def dataroom_list(founder_id):
    """Everything this founder has supplied, plus who has opened what."""
    conn = _db()
    docs = [dict(r) for r in conn.execute(
        "SELECT id,item_key,filename,size,uploaded_at FROM dataroom_doc WHERE founder_id=? "
        "ORDER BY item_key", (founder_id,)).fetchall()]
    views = [dict(r) for r in conn.execute(
        "SELECT item_key,viewer,viewed_at FROM dataroom_view WHERE founder_id=? "
        "ORDER BY id DESC LIMIT 25", (founder_id,)).fetchall()]
    conn.close()
    return {"docs": docs, "views": views}

def dataroom_view_log(founder_id, doc_id, item_key, viewer):
    conn = _db()
    conn.execute("INSERT INTO dataroom_view(founder_id,doc_id,item_key,viewer,viewed_at) "
                 "VALUES(?,?,?,?,datetime('now'))", (founder_id, doc_id, item_key, viewer or "Unknown"))
    conn.commit()
    conn.close()
    return {"ok": True}

def diagnostic_find_reusable(founder_id, filename, size):
    """Return a prior AI read for the same founder + identical deck (same filename and
    byte-size) so we never pay the API twice for the same deck. None if nothing to reuse."""
    conn = _db()
    row = conn.execute(
        "SELECT dg.live, dg.summary, dg.findings_json "
        "FROM diagnostic dg JOIN deck k ON k.id = dg.deck_id "
        "WHERE dg.founder_id=? AND k.filename=? AND k.size=? "
        "ORDER BY dg.id DESC LIMIT 1", (founder_id, filename, size)).fetchone()
    conn.close()
    if not row:
        return None
    return {"live": bool(row["live"]), "summary": row["summary"],
            "findings": json.loads(row["findings_json"] or "[]"), "reused": True}

def diagnostic_save(founder_id, deck_id, result):
    conn = _db()
    conn.execute("INSERT INTO diagnostic(founder_id,deck_id,live,summary,findings_json,created_at) "
                 "VALUES(?,?,?,?,?,datetime('now'))",
                 (founder_id, deck_id, 1 if result.get("live") else 0,
                  result.get("summary", ""), json.dumps(result.get("findings", []))))
    conn.commit()
    conn.close()

# ---- load .env (private config: Zoho keys + optional Anthropic key) ----
ENV = {}
try:
    for line in open(os.path.join(HERE, ".env")):
        line = line.strip()
        if line and "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            ENV[k.strip()] = v.strip()
except FileNotFoundError:
    print("WARNING: .env not found — Zoho check will not work.")

ZOHO_CLIENT_ID = ENV.get("ZOHO_CLIENT_ID", "")
ZOHO_CLIENT_SECRET = ENV.get("ZOHO_CLIENT_SECRET", "")
ANTHROPIC_API_KEY = ENV.get("ANTHROPIC_API_KEY", "")
# Google sign-in ("Continue with Google"). This is the PUBLIC OAuth Client ID —
# safe to expose to the browser (that's how Google's button works). There is NO
# client secret here: the browser gets a signed ID token and the server only
# verifies it, so no secret is needed. Blank = feature off (button falls back to demo).
GOOGLE_CLIENT_ID = ENV.get("GOOGLE_CLIENT_ID", "")

# ---- Admin / Team-Portal access allow-list ----
# Only these Google-verified emails may enter the admin portal. Access is an
# explicit allow-list (NOT the whole @tiebangalore.org domain).
#
# SUPER-ADMINS are the trust anchor: they can add/remove admins and cannot be
# removed in-app. Set them (comma-separated) via ADMIN_SUPER_EMAILS in .env;
# default = the two TiE Bangalore owners.
# ADMIN_EMAILS from .env is only a FIRST-RUN SEED. The live allow-list lives in
# the admin_allowlist table (see db_init) so a super-admin can add/remove
# admins from inside the portal without editing files or restarting the server.
_super_raw = ENV.get("ADMIN_SUPER_EMAILS") or ENV.get("ADMIN_SUPER_EMAIL") or \
    "admin.blr@tiebangalore.org,chinmay@tiebangalore.org"
ADMIN_SUPER_EMAILS = set()
for _e in _super_raw.split(","):
    _e = _e.strip().lower()
    if _e:
        ADMIN_SUPER_EMAILS.add(_e)

def is_super_admin(email):
    return (email or "").strip().lower() in ADMIN_SUPER_EMAILS

def admin_role_for(email):
    email = (email or "").strip().lower()
    if not email:
        return None
    if is_super_admin(email):
        return "super-admin"
    conn = _db()
    row = conn.execute("SELECT email FROM admin_allowlist WHERE email=?", (email,)).fetchone()
    conn.close()
    return "admin" if row else None

def admin_list():
    # Super-admins sort to the top; everyone else alphabetically.
    conn = _db()
    rows = conn.execute(
        "SELECT email, added_by, added_at FROM admin_allowlist ORDER BY email ASC").fetchall()
    conn.close()
    mapped = [{"email": r["email"],
             "role": "super-admin" if is_super_admin(r["email"]) else "admin",
             "added_by": r["added_by"] or "",
             "added_at": r["added_at"] or ""} for r in rows]
    mapped.sort(key=lambda a: (0 if a["role"] == "super-admin" else 1, a["email"]))
    return mapped

def require_super_admin(id_token):
    # Verify a Google credential and require it to be a SUPER-admin. Guards the
    # admin-management endpoints: there are no sessions yet, so the caller proves
    # who they are by sending their Google ID token with each request.
    v = verify_google_token(id_token)
    if v.get("error"):
        return {"error": v["error"], "status": 401}
    if not is_super_admin(v["email"]):
        return {"error": "Only a super-admin can manage admin access.", "status": 403}
    return {"email": v["email"]}

def admin_add(id_token, email):
    g = require_super_admin(id_token)
    if g.get("error"):
        return g
    email = (email or "").strip().lower()
    if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
        return {"error": "Please enter a valid email address.", "status": 400}
    conn = _db()
    conn.execute("INSERT OR IGNORE INTO admin_allowlist(email, added_by, added_at) "
                 "VALUES(?,?,datetime('now'))", (email, g["email"]))
    conn.commit()
    conn.close()
    notify("admin_added", [email] + sorted(ADMIN_SUPER_EMAILS),
           "You have been added as a VentureReady admin",
           g["email"] + " added " + email +
           " to the VentureReady Team Portal admin allow-list.", "normal")
    return {"admins": admin_list()}

def admin_remove(id_token, email):
    g = require_super_admin(id_token)
    if g.get("error"):
        return g
    email = (email or "").strip().lower()
    if is_super_admin(email):
        return {"error": "A super-admin can’t be removed.", "status": 400}
    conn = _db()
    conn.execute("DELETE FROM admin_allowlist WHERE email=?", (email,))
    conn.commit()
    conn.close()
    notify("admin_removed", sorted(ADMIN_SUPER_EMAILS),
           "An admin was removed from VentureReady",
           g["email"] + " removed " + email +
           " from the VentureReady Team Portal admin allow-list.", "normal")
    return {"admins": admin_list()}

# ---- Notifications & email outbox -----------------------------------------
# Every important event is RECORDED here (a notification plus one email_outbox
# row per recipient). Whether a recorded message is actually EMAILED depends on
# MAIL_ENABLED, which is true only when a full SMTP configuration is present in
# .env. Until then the platform runs in "record-only" mode: messages are
# captured and shown on the admin Notifications screen, but nothing is sent.
# This keeps the app safe to run before a mail provider is wired up.
SMTP_HOST = ENV.get("SMTP_HOST", "").strip()
SMTP_PORT = int((ENV.get("SMTP_PORT", "") or "587").strip() or "587")
SMTP_USER = ENV.get("SMTP_USER", "").strip()
SMTP_PASS = ENV.get("SMTP_PASS", "").strip()
MAIL_FROM = ENV.get("MAIL_FROM", "").strip() or SMTP_USER
MAIL_FROM_NAME = (ENV.get("MAIL_FROM_NAME", "") or "VentureReady").strip()
MAIL_ENABLED = bool(SMTP_HOST and SMTP_USER and SMTP_PASS and MAIL_FROM)

def _admin_emails():
    conn = _db()
    rows = conn.execute("SELECT email FROM admin_allowlist ORDER BY email ASC").fetchall()
    conn.close()
    return [r["email"] for r in rows]

def _expand_recipients(recipients):
    # Accept a list of email addresses and/or the token "admins" (= everyone on
    # the allow-list). Returns a de-duplicated list with blanks removed.
    out = []
    for r in (recipients or []):
        r = (r or "").strip()
        if not r:
            continue
        if r.lower() == "admins":
            out.extend(_admin_emails())
        else:
            out.append(r)
    seen, uniq = set(), []
    for e in out:
        k = e.strip().lower()
        if k and k not in seen:
            seen.add(k)
            uniq.append(e)
    return uniq

def notify(event, recipients, subject, body, urgency="normal"):
    # Record one notification + one pending email per recipient. Actual sending
    # happens later (Stage 3) and only when MAIL_ENABLED; for now the rows simply
    # wait in the outbox. Returns how many recipients were recorded.
    conn = _db()
    n = 0
    for to in _expand_recipients(recipients):
        cur = conn.execute(
            "INSERT INTO notification(event, recipient, subject, body, urgency, created_at) "
            "VALUES(?,?,?,?,?,datetime('now'))", (event, to, subject, body, urgency))
        conn.execute(
            "INSERT INTO email_outbox(notification_id, to_email, subject, body, status, created_at) "
            "VALUES(?,?,?,?,'pending',datetime('now'))", (cur.lastrowid, to, subject, body))
        n += 1
    conn.commit()
    conn.close()
    return n

def require_admin(id_token):
    # Any admin (super-admin OR regular) may view the notifications feed.
    v = verify_google_token(id_token)
    if v.get("error"):
        return {"error": v["error"], "status": 401}
    role = admin_role_for(v["email"])
    if not role:
        return {"error": "Admin access required.", "status": 403}
    return {"email": v["email"], "role": role}

def notifications_recent(limit=100):
    conn = _db()
    rows = conn.execute(
        "SELECT n.id, n.event, n.recipient, n.subject, n.body, n.urgency, n.created_at, "
        "o.status FROM notification n LEFT JOIN email_outbox o ON o.notification_id = n.id "
        "ORDER BY n.id DESC LIMIT ?", (limit,)).fetchall()
    conn.close()
    return [{"id": r["id"], "event": r["event"], "recipient": r["recipient"],
             "subject": r["subject"], "body": r["body"],
             "urgency": r["urgency"] or "normal", "created_at": r["created_at"] or "",
             "status": r["status"] or "pending"} for r in rows]

CHAPTER = "TiE Bangalore"

# ---- Zoho token cache (token lives 1 hour) ----
_token = {"value": None, "expires": 0}

def zoho_token():
    if _token["value"] and time.time() < _token["expires"] - 60:
        return _token["value"]
    q = urllib.parse.urlencode({
        "grant_type": "client_credentials",
        "client_id": ZOHO_CLIENT_ID,
        "client_secret": ZOHO_CLIENT_SECRET,
        "scope": "ZohoCreator.report.READ",
    })
    req = urllib.request.Request("https://accounts.zoho.com/oauth/v2/token?" + q, method="POST")
    d = json.loads(urllib.request.urlopen(req, timeout=20).read())
    _token["value"] = d["access_token"]
    _token["expires"] = time.time() + int(d.get("expires_in", 3600))
    return _token["value"]

def verify_member(email):
    """Ask Zoho whether this email is a current TiE Bangalore member.

    Returns a dict. Three possible shapes:
      - Found & answered:  {member: bool, name, status, category}
      - Reached, no record: {member: False, reason: "not found", status: ""}
      - COULD NOT REACH Zoho: {member: False, unreachable: True, reason: ...}

    The `unreachable` flag matters: it lets callers tell "Zoho says they are not a
    member" apart from "we simply couldn't check right now", so we can keep the
    last CONFIRMED status instead of wrongly wiping someone's membership.
    """
    email = (email or "").strip()
    if not email:
        return {"member": False, "reason": "no email"}
    params = urllib.parse.urlencode({
        "field_config": "custom",
        "fields": "Email1,Name1,Status,Chapter_Name,Membership_Category1,Mobile",
        "Original_Email": email,
        "Chapter_Name": CHAPTER,
    })
    url = "https://creator.zoho.com/api/v2.1/tie_dev/chapters/report/Member_Details_Admin_View?" + params
    try:
        # zoho_token() can itself fail if Zoho's auth server is down — keep it
        # inside the try so an auth outage counts as "unreachable", not "not found".
        req = urllib.request.Request(url, headers={"Authorization": "Zoho-oauthtoken " + zoho_token()})
        d = json.loads(urllib.request.urlopen(req, timeout=20).read())
        rec = (d.get("data") or [{}])[0]
        status = rec.get("Status", "")
        return {
            "member": status == "Active",
            "name": (rec.get("Name1") or {}).get("zc_display_value", ""),
            "status": status,
            "category": (rec.get("Membership_Category1") or {}).get("zc_display_value", ""),
        }
    except urllib.error.HTTPError as e:
        # 5xx = Zoho itself is having trouble → treat as unreachable (keep last known).
        # 4xx (incl. code 9220 = no matching record) = a real answer: not a member.
        if e.code >= 500:
            return {"member": False, "unreachable": True, "reason": "zoho error %s" % e.code}
        return {"member": False, "reason": "not found", "status": ""}
    except Exception as e:
        # Network timeout, DNS failure, auth failure, bad JSON — we couldn't get a
        # trustworthy answer, so don't overwrite what we already know.
        return {"member": False, "unreachable": True, "reason": str(e)}

def refresh_membership(founder_id):
    """Re-check a founder's TiE membership with Zoho and cache the answer.

    Called at every sign-in (login and signup). Zoho stays the source of truth;
    the founder row just caches the latest answer so the profile shows it.

    If Zoho can't be reached we KEEP the last confirmed values and only flip
    membership_stale=1, so the UI can say "showing last confirmed status". A
    successful check clears the stale flag. Returns the fresh founder row.
    """
    conn = _db()
    row = conn.execute("SELECT * FROM founder WHERE id=?", (founder_id,)).fetchone()
    if not row:
        conn.close()
        return None
    res = verify_member(row["email"])
    if res.get("unreachable"):
        # Couldn't reach Zoho — leave the cached snapshot untouched, just flag it stale.
        conn.execute("UPDATE founder SET membership_stale=1 WHERE id=?", (founder_id,))
    else:
        conn.execute(
            "UPDATE founder SET is_member=?, membership_status=?, membership_category=?, "
            "membership_name=?, membership_checked_at=datetime('now'), membership_stale=0 "
            "WHERE id=?",
            (1 if res.get("member") else 0, res.get("status", ""),
             res.get("category", ""), res.get("name", ""), founder_id))
    conn.commit()
    out = conn.execute("SELECT * FROM founder WHERE id=?", (founder_id,)).fetchone()
    conn.close()
    return out

# ---- "Continue with Google" sign-in ----
# Google proves IDENTITY (who the person is). It does NOT prove TiE membership —
# that's still Zoho's job, run right after via refresh_membership(). The two gates
# stay separate: identity first, membership second.
def verify_google_token(id_token):
    """Verify the signed ID token the browser got from Google.

    We ask Google's own tokeninfo endpoint to validate it (so we're not
    hand-rolling JWT crypto), then still check audience/issuer/verified-email
    ourselves — never trust a token that wasn't minted for THIS app.

    NOTE FOR PRODUCTION: for higher volume, verify the token locally against
    Google's public keys with a vetted library instead of the tokeninfo endpoint.
    """
    if not GOOGLE_CLIENT_ID:
        return {"error": "Google sign-in is not configured on this server."}
    if not id_token:
        return {"error": "No Google credential was provided."}
    try:
        url = "https://oauth2.googleapis.com/tokeninfo?id_token=" + urllib.parse.quote(id_token)
        d = json.loads(urllib.request.urlopen(url, timeout=20).read())
    except urllib.error.HTTPError:
        return {"error": "Google could not verify that sign-in. Please try again."}
    except Exception:
        return {"error": "Couldn't reach Google to verify the sign-in. Please try again."}
    # aud must be OUR client ID — stops a token issued for another app being replayed here.
    if d.get("aud") != GOOGLE_CLIENT_ID:
        return {"error": "That sign-in was not issued for this app."}
    # iss must be Google.
    if d.get("iss") not in ("accounts.google.com", "https://accounts.google.com"):
        return {"error": "That sign-in did not come from Google."}
    # Token must not be expired.
    try:
        if d.get("exp") and time.time() > int(d["exp"]):
            return {"error": "That Google sign-in has expired. Please try again."}
    except (TypeError, ValueError):
        pass
    # Only accept a verified email — we key TiE membership off the email address.
    if str(d.get("email_verified")).lower() != "true" or not d.get("email"):
        return {"error": "Your Google email isn't verified, so we can't use it to sign in."}
    return {"sub": d.get("sub"), "email": (d.get("email") or "").strip().lower(), "name": d.get("name", "")}

def founder_google_upsert(sub, email, name):
    """Find the founder by Google ID first, then by email, else create a new record.
    Google accounts have no password — that's fine; password columns stay null."""
    conn = _db()
    email = (email or "").strip().lower()
    row = conn.execute("SELECT * FROM founder WHERE google_sub=?", (sub,)).fetchone()
    if not row and email:
        row = conn.execute("SELECT * FROM founder WHERE email=?", (email,)).fetchone()
    if row:
        # Attach the Google ID (and fill a blank name) without disturbing anything else.
        conn.execute("UPDATE founder SET google_sub=?, name=COALESCE(NULLIF(name,''), ?) WHERE id=?",
                     (sub, name or "", row["id"]))
        fid = row["id"]
    else:
        cur = conn.execute(
            "INSERT INTO founder(name,email,google_sub,created_at) VALUES(?,?,?,datetime('now'))",
            (name or "New Founder", email, sub))
        fid = cur.lastrowid
    conn.commit()
    conn.close()
    return fid

def founder_google_login(id_token):
    """Full flow: verify identity with Google → find/create the founder → re-check
    TiE membership with Zoho → return the public profile."""
    v = verify_google_token(id_token)
    if v.get("error"):
        return {"error": v["error"]}
    fid = founder_google_upsert(v["sub"], v["email"], v["name"])
    refreshed = refresh_membership(fid)
    if refreshed is None:
        conn = _db()
        refreshed = conn.execute("SELECT * FROM founder WHERE id=?", (fid,)).fetchone()
        conn.close()
    # Decide the role from the admin allow-list. Everyone else is a "founder".
    role = admin_role_for(v["email"]) or "founder"
    return {"founder": _public_founder(refreshed), "role": role}

# ---- Deck text extraction (reads the founder's actual uploaded deck) ----
# How many slide pictures we'll send the AI, and how big each may be.
# Vision costs more than text, so this path is a FALLBACK for image-only decks
# and is capped to keep a runaway deck from burning the budget.
MAX_DECK_IMAGES = 20
MAX_IMAGE_PX = 1400

def _shrink_to_jpeg(data, max_px=MAX_IMAGE_PX):
    """Normalise any embedded picture to a modest JPEG the API will accept."""
    from PIL import Image
    im = Image.open(io.BytesIO(data))
    if im.mode not in ("RGB", "L"):
        im = im.convert("RGB")
    w, h = im.size
    if max(w, h) > max_px:
        scale = max_px / float(max(w, h))
        im = im.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=80, optimize=True)
    return buf.getvalue()

def extract_deck_images(filename, raw, max_images=MAX_DECK_IMAGES):
    """For image-only decks: pull the picture of each slide so the AI can LOOK at it.
    Takes the largest image per page/slide (that's the slide render), shrinks it,
    and returns base64 JPEGs ready for the API. Empty list if nothing usable."""
    name = (filename or "").lower()
    pics = []
    try:
        if name.endswith(".pdf"):
            from pypdf import PdfReader
            reader = PdfReader(io.BytesIO(raw))
            for page in reader.pages[:max_images]:
                try:
                    imgs = list(page.images)
                except Exception:
                    imgs = []
                if not imgs:
                    continue
                biggest = max(imgs, key=lambda i: len(i.data))   # the slide render
                pics.append(biggest.data)
        elif name.endswith(".pptx"):
            from pptx import Presentation
            prs = Presentation(io.BytesIO(raw))
            for slide in prs.slides:
                if len(pics) >= max_images:
                    break
                blobs = []
                for shape in slide.shapes:
                    try:
                        if getattr(shape, "image", None) is not None:
                            blobs.append(shape.image.blob)
                    except Exception:
                        pass
                if blobs:
                    pics.append(max(blobs, key=len))
    except Exception as e:
        print("deck image extraction failed:", e)
        return []

    out = []
    for data in pics:
        try:
            out.append({"media_type": "image/jpeg",
                        "b64": base64.b64encode(_shrink_to_jpeg(data)).decode()})
        except Exception as e:
            print("image convert skipped:", e)
    return out

def extract_deck_text(filename, raw):
    """Pull plain text out of an uploaded PDF or PPTX so the AI reads the real deck."""
    name = (filename or "").lower()
    try:
        if name.endswith(".pdf"):
            from pypdf import PdfReader
            reader = PdfReader(io.BytesIO(raw))
            return "\n".join((page.extract_text() or "") for page in reader.pages).strip()
        if name.endswith(".pptx") or name.endswith(".ppt"):
            from pptx import Presentation
            prs = Presentation(io.BytesIO(raw))
            out = []
            for slide in prs.slides:
                for shape in slide.shapes:
                    if shape.has_text_frame:
                        out.append(shape.text_frame.text)
            return "\n".join(out).strip()
    except Exception as e:
        print("deck extraction failed:", e)
        return ""
    # Unknown type: try decoding as plain text.
    try:
        return raw.decode("utf-8", "ignore").strip()
    except Exception:
        return ""


# ---- AI diagnostic ----
ANTI_PATTERNS = (
    "TAM inflation, vague ICP with no firmographic qualifier, no buyer trigger event, missing 'why now', "
    "feature-parity-as-moat, vanity metrics, wishful GTM, solution looking for a problem, internal "
    "contradictions, projection overconfidence, regulatory blindspots, and US-playbook assumptions in the Indian market"
)

# ---- Model auto-discovery ----
# Nobody has to know or maintain the AI model name. The app asks Anthropic which
# models the account can use and picks the strongest one, preferring Opus, then
# Sonnet. A manual override (ANTHROPIC_MODEL in .env) wins if ever needed.
_model_cache = {"value": None}

def get_model():
    if _model_cache["value"]:
        return _model_cache["value"]
    override = ENV.get("ANTHROPIC_MODEL", "").strip()
    if override:
        _model_cache["value"] = override
        return override
    fallback = "claude-sonnet-4-5"  # safe default if discovery ever fails
    try:
        req = urllib.request.Request(
            "https://api.anthropic.com/v1/models?limit=100", method="GET",
            headers={"x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01"},
        )
        data = json.loads(urllib.request.urlopen(req, timeout=20).read()).get("data", [])
        ids = [m["id"] for m in data if "id" in m]
        # API returns newest first; keep that order and prefer Sonnet (best value for
        # this diagnostic), then fall back to Opus, then whatever's newest.
        chosen = (next((i for i in ids if "sonnet" in i), None)
                  or next((i for i in ids if "opus" in i), None)
                  or (ids[0] if ids else fallback))
        _model_cache["value"] = chosen
        print("AI model auto-selected:", chosen)
        return chosen
    except Exception as e:
        print("model discovery failed (%s) — using fallback %s" % (e, fallback))
        _model_cache["value"] = fallback
        return fallback


# How much deck text we send to the AI. ~25k characters covers virtually every real
# pitch deck (appendix and all) while capping cost on a runaway file. Anything longer
# is flagged to the founder rather than silently dropped.
DECK_CHAR_LIMIT = 25000

def ai_diagnostic(deck_text, icp="", pitch="", images=None):
    if not ANTHROPIC_API_KEY:
        # No key yet -> realistic canned result so the demo flows.
        return {
            "live": False,
            "summary": "Sample result — your real AI key isn't set yet, so this shows the kind of read the engine produces. Add the key and it runs live on the uploaded deck.",
            "findings": [
                {"dim": "Positioning Clarity", "note": "Opening leads with the product, not the customer problem — the 'why now' is missing.", "fixes": [
                    "Open on the customer's painful trigger, then position your product as the answer.",
                    "Add a 'why now' — the market, tech or regulatory shift that makes this the moment.",
                    "Cut feature language from the first slide; lead with the outcome the buyer gets."]},
                {"dim": "ICP Specificity", "note": "Target is described as 'SMEs' with no firmographic or trigger-event qualifier.", "fixes": [
                    "Name the company size and the buyer's exact role (e.g. 'VP Sales at a 50–200-person SaaS').",
                    "State the trigger event that makes them ready to buy right now.",
                    "Name two or three real example companies that fit the profile."]},
                {"dim": "Messaging Hierarchy", "note": "The edge is framed as 'faster and cheaper' — a feature claim, buried among equally-weighted points.", "fixes": [
                    "Lead with the single message that matters most and make everything else support it.",
                    "Replace 'faster and cheaper' with a structural advantage a rival can't copy by trying harder.",
                    "Back the hero claim with one concrete proof point, not three vague ones."]},
                {"dim": "GTM Sequencing", "note": "Acquisition relies on 'word of mouth and partnerships'; there's no first-10-customers plan.", "fixes": [
                    "Spell out exactly how the first ten customers get reached and closed.",
                    "State your motion (self-serve, inside sales, or founder-led) and the CAC you expect.",
                    "Sequence the channels — which one you prove first before layering the next."]},
            ],
        }
    context = ""
    if icp or pitch:
        context = (
            "\n\nThe founder also gave two quick inputs at the free step:\n"
            "WHO IT'S FOR (their stated ICP): " + (icp or "(not given)") + "\n"
            "ONE-LINE PITCH: " + (pitch or "(not given)") + "\n"
            "Use these to judge whether the deck actually delivers on what they claim."
        )
    prompt = (
        "You are a senior TiE Bangalore investment reviewer running a FREE positioning diagnostic. "
        "This free read sits IN FRONT OF a paid expert review, so it must be genuinely useful but must NOT do the "
        "founder's rewriting for them — its job is to make them see WHAT is weak and WHICH DIRECTION to move, while "
        "leaving the actual rework, prioritisation and judgement to the paid expert. "
        "This is AI pattern analysis, NOT a statistical benchmark. Read the founder's pitch deck text below and "
        "identify the most important issue under each of the four positioning dimensions: Positioning Clarity, ICP Specificity, "
        "Messaging Hierarchy, and GTM Sequencing. "
        "For each dimension, the 'note' should be one sharp sentence naming the problem AND why it costs them with investors. "
        "Then give two or three DIRECTIONAL pointers in 'fixes' — short nudges that name the type of fix and why it matters, "
        "phrased as 'rethink / sharpen / pick / separate' guidance. "
        "CRITICAL — do NOT do the work for them: do NOT write the replacement headline or any ready-to-paste copy, "
        "do NOT compute or restate the corrected number, do NOT enumerate the specific certifications, regulations or named "
        "example customers, and do NOT hand over a finished slide. Point the direction only (e.g. 'Pick one beachhead "
        "application and lead the deck with it' — NOT the exact new headline; 'Your cost-reduction claim is mathematically "
        "impossible as stated — restate it as a real from/to figure' — NOT the corrected figure itself). "
        "Watch for these known anti-patterns: " + ANTI_PATTERNS + ". "
        "End 'summary' with one sentence noting that a TiE expert reviewer would help them prioritise which of these fixes "
        "matters most for their specific raise and rework it for the investors they're about to meet. "
        "Respond ONLY as JSON: {\"summary\": str, \"findings\": [{\"dim\": str, \"note\": str, \"fixes\": [str, str, ...]}, ...]}."
        + context + "\n\n"
        + ("The deck is image-based, so its slides are attached as pictures above rather than as text. "
           "Read the slides directly — including any charts, tables and infographics — and diagnose from what you see."
           if images else "DECK TEXT:\n" + deck_text[:DECK_CHAR_LIMIT])
    )
    # Image-only decks: send the slide pictures and let the model read them.
    # Beats OCR — it understands layout, charts and infographics, not just glyphs.
    if images:
        content = [{"type": "image",
                    "source": {"type": "base64", "media_type": im["media_type"], "data": im["b64"]}}
                   for im in images]
        content.append({"type": "text", "text": prompt})
    else:
        content = prompt
    body = json.dumps({
        "model": get_model(),
        # Enough room for a full four-dimension read on a rich, multi-slide deck.
        # Too small and the reply gets cut off mid-JSON and can't be parsed.
        "max_tokens": 4096,
        "messages": [{"role": "user", "content": content}],
    }).encode()
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages", data=body, method="POST",
        headers={"x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json"},
    )
    d = json.loads(urllib.request.urlopen(req, timeout=90).read())
    # Read every text block (newer models can prepend non-text blocks); don't assume
    # the first block is the text — that would crash with a KeyError on those models.
    text = "".join(b.get("text", "") for b in d.get("content", [])
                   if isinstance(b, dict) and b.get("type") == "text")
    start, end = text.find("{"), text.rfind("}")
    try:
        parsed = json.loads(text[start:end + 1])
    except Exception as e:
        # The model's reply wasn't clean JSON (e.g. truncated or wrapped in prose).
        # Fail gracefully with a readable message instead of crashing the request.
        print("AI JSON parse failed (%s); stop_reason=%s" % (e, d.get("stop_reason")))
        return {
            "live": True,
            "partial": True,
            "summary": (
                "The AI read your deck but its detailed reply didn't come back in a "
                "form we could lay out cleanly this time. Please run the diagnostic "
                "again — it usually succeeds on a retry."
            ),
            "findings": [],
        }
    parsed["live"] = True
    return parsed


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        payload = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        path = "/index.html" if self.path in ("/", "") else self.path.split("?")[0]
        if path == "/api/config":
            # Public front-end config. Only non-secret values belong here. The
            # Google Client ID is designed to be public (the browser needs it).
            return self._send(200, {"googleClientId": GOOGLE_CLIENT_ID})
        if path == "/api/support":
            return self._send(200, support_list())
        if path == "/api/review":
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            fid = (qs.get("founder_id") or [""])[0]
            return self._send(200, review_state(fid) if fid else {"rounds": [], "latest": None})
        if path == "/api/dataroom":
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            fid = (qs.get("founder_id") or [""])[0]
            return self._send(200, dataroom_list(fid) if fid else {"docs": [], "views": []})
        if path == "/api/founder":
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            fid = (qs.get("id") or [""])[0]
            rec = founder_get(fid) if fid else None
            return self._send(200, rec or {"error": "not found"})
        fp = os.path.join(HERE, path.lstrip("/"))
        if os.path.isfile(fp) and os.path.abspath(fp).startswith(HERE):
            ctype = "text/html" if fp.endswith(".html") else "application/octet-stream"
            data = open(fp, "rb").read()
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw or b"{}")
        except Exception:
            data = {}
        try:
            if self.path == "/api/verify-member":
                self._send(200, verify_member(data.get("email", "")))
            elif self.path == "/api/founder":
                self._send(200, founder_upsert(data))
            elif self.path == "/api/signup":
                out = founder_signup(data)
                self._send(400 if out.get("error") else 200, out)
            elif self.path == "/api/login":
                out = founder_login(data.get("email", ""), data.get("password", ""))
                self._send(401 if out.get("error") else 200, out)
            elif self.path == "/api/auth/google":
                # "Continue with Google": verify the Google credential, find/create
                # the founder, refresh their TiE membership, and return the profile.
                out = founder_google_login(data.get("credential", ""))
                self._send(401 if out.get("error") else 200, out)
            elif self.path == "/api/admin/list":
                # Super-admin only: read the admin allow-list.
                g = require_super_admin(data.get("credential", ""))
                if g.get("error"):
                    self._send(g["status"], {"error": g["error"]})
                else:
                    self._send(200, {"admins": admin_list()})
            elif self.path == "/api/admin/add":
                # Super-admin only: add an approved admin email.
                out = admin_add(data.get("credential", ""), data.get("email", ""))
                if out.get("error"):
                    self._send(out.get("status", 400), {"error": out["error"]})
                else:
                    self._send(200, out)
            elif self.path == "/api/admin/remove":
                # Super-admin only: remove an admin email (super-admin can't be removed).
                out = admin_remove(data.get("credential", ""), data.get("email", ""))
                if out.get("error"):
                    self._send(out.get("status", 400), {"error": out["error"]})
                else:
                    self._send(200, out)
            elif self.path == "/api/admin/notifications":
                # Any admin: view the recorded notifications feed / email outbox.
                g = require_admin(data.get("credential", ""))
                if g.get("error"):
                    self._send(g["status"], {"error": g["error"]})
                else:
                    self._send(200, {"notifications": notifications_recent(),
                                     "mail_enabled": MAIL_ENABLED})
            elif self.path == "/api/review":
                # A reviewer submits a verdict — this is what the founder then sees.
                fid = data.get("founder_id")
                verdict = data.get("verdict", "")
                if not fid or verdict not in ("not_yet", "awarded"):
                    self._send(400, {"error": "founder_id and verdict ('not_yet'|'awarded') are required"})
                else:
                    self._send(200, review_add(fid, verdict, data.get("gaps"),
                                               data.get("reviewer", ""), data.get("note", "")))
            elif self.path == "/api/dataroom":
                # Upload one diligence document against a checklist item.
                fid = data.get("founder_id")
                key = data.get("item_key", "")
                fname = data.get("filename", "")
                b64 = data.get("file_b64", "")
                if not (fid and key and b64):
                    self._send(400, {"error": "founder_id, item_key and file_b64 are required"})
                else:
                    raw = base64.b64decode(b64.split(",")[-1])
                    did = dataroom_add(fid, key, fname, raw)
                    out = dataroom_list(fid)
                    out["doc_id"] = did
                    self._send(200, out)
            elif self.path == "/api/dataroom/view":
                self._send(200, dataroom_view_log(data.get("founder_id"), data.get("doc_id"),
                                                  data.get("item_key", ""), data.get("viewer", "")))
            elif self.path == "/api/diagnostic":
                deck_text = data.get("deck_text", "")
                fileb64 = data.get("file_b64", "")
                fname = data.get("filename", "")
                founder_id = data.get("founder_id")
                had_file = bool(fileb64)
                deck_id = None
                if fileb64:
                    raw = base64.b64decode(fileb64.split(",")[-1])
                    deck_text = extract_deck_text(fname, raw)
                    # Store the actual deck file + a DB row pointing to it.
                    deck_id = deck_add(founder_id, fname, raw)
                # No usable text? The deck is probably image-based (each slide is a
                # picture). Before giving up, try to LOOK at the slides instead.
                deck_images = None
                if had_file and len((deck_text or "").strip()) < 120:
                    deck_images = extract_deck_images(fname, raw)
                    if deck_images:
                        print("image-based deck: reading %d slide picture(s) with vision" % len(deck_images))

                # Only truly unreadable if there's neither text nor a picture to look at.
                if had_file and len((deck_text or "").strip()) < 120 and not deck_images:
                    self._send(200, {
                        "live": False,
                        "unreadable": True,
                        "summary": (
                            "We couldn't read “%s.” There's no text inside it and we "
                            "couldn't pull out readable slide images either. Please export your "
                            "deck as a PDF or PowerPoint and upload it again — or paste your "
                            "pitch below and we'll read that instead."
                        ) % (fname or "your file"),
                        "findings": [],
                    })
                else:
                    result = None
                    # Reuse a prior read for the same founder + identical deck instead of
                    # paying the API again (no double-charging for a re-run).
                    if founder_id and had_file:
                        result = diagnostic_find_reusable(founder_id, fname, len(raw))
                    if result is None:
                        result = ai_diagnostic(deck_text, data.get("icp", ""), data.get("pitch", ""),
                                               images=deck_images)
                        if deck_images:
                            # Be transparent that this read came from looking at the slides.
                            result["read_from_images"] = True
                            result["summary"] = (
                                "Note: this deck has no text inside it, so we read the slides as images. "
                            ) + (result.get("summary") or "")
                        # Persist the read against this founder + deck so every screen and a
                        # later visit can pull it back up (survives refresh and restart).
                        if founder_id:
                            diagnostic_save(founder_id, deck_id, result)
                    # Long-deck honesty flag: if the deck ran past what we read in full,
                    # tell the founder rather than silently analysing only the first part.
                    if had_file and len(deck_text or "") > DECK_CHAR_LIMIT:
                        result["long_deck"] = True
                        result["summary"] = (
                            "Heads-up: this deck is longer than we read in full — only the first "
                            "~25,000 characters were analysed, so the tail end wasn't seen. Consider "
                            "trimming or splitting it for a complete read. "
                        ) + (result.get("summary") or "")
                    result["deck_id"] = deck_id
                    self._send(200, result)
            elif self.path == "/api/support":
                self._send(200, support_add(data))
            else:
                self._send(404, {"error": "unknown endpoint"})
        except Exception as e:
            self._send(500, {"error": str(e)})

    def log_message(self, *args):
        pass  # quiet console


if __name__ == "__main__":
    port = 8000
    db_init()
    print("VentureReady demo running.  Open this in your browser:  http://localhost:%d" % port)
    print("Zoho member check: %s | AI key: %s" % (
        "ready" if ZOHO_CLIENT_ID else "MISSING",
        "set (live AI)" if ANTHROPIC_API_KEY else "not set (sample result)"))
    print("Press Ctrl+C here to stop the app.")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
