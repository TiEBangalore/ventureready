/*
 * VentureReady demo app server (Node.js port of server.py).
 * Serves the prototype (index.html) and provides the same LIVE endpoints:
 *   - POST /api/verify-member  -> checks an email against TiE Bangalore's Zoho membership data
 *   - POST /api/diagnostic     -> runs the AI positioning read (uses Claude if a key is set, else a canned result)
 * Run:  npm install   then   npm start     then open http://localhost:8000
 *
 * This is a 1:1 behavioural port of server.py. The database, routes, JSON shapes,
 * password hashing and status codes are identical, so the existing data.db (and the
 * front-end index.html) keep working unchanged.
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const HERE = __dirname;

// ---- Local database (SQLite). Proves real persistence: data survives refresh AND restart. ----
const DB_PATH = path.join(HERE, "data.db");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

function now() {
  // Mirror SQLite's datetime('now') so timestamps look identical to the Python app.
  return db.prepare("SELECT datetime('now') AS t").get().t;
}

function db_init() {
  db.exec(`CREATE TABLE IF NOT EXISTS support(
      id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT, from_name TEXT, role TEXT,
      category TEXT, subject TEXT, message TEXT, status TEXT DEFAULT 'New',
      received TEXT, created_at TEXT)`);
  // Each founder is one row. email is unique so the same person maps to one record.
  db.exec(`CREATE TABLE IF NOT EXISTS founder(
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT UNIQUE, company TEXT,
      role TEXT, phone TEXT, city TEXT, stage TEXT, sector TEXT, linkedin TEXT,
      created_at TEXT)`);
  // Migration: older databases don't have password columns. SQLite has no
  // "ADD COLUMN IF NOT EXISTS", so we check the existing columns first.
  const cols = db.prepare("PRAGMA table_info(founder)").all().map((r) => r.name);
  if (!cols.includes("password_hash")) {
    db.exec("ALTER TABLE founder ADD COLUMN password_hash TEXT");
  }
  if (!cols.includes("password_salt")) {
    db.exec("ALTER TABLE founder ADD COLUMN password_salt TEXT");
  }
  // Membership snapshot columns. These CACHE Zoho's answer, refreshed at each
  // sign-in (Zoho stays the source of truth). membership_stale=1 means the last
  // refresh couldn't reach Zoho, so these values are the last CONFIRMED status.
  const memCols = [
    ["is_member", "INTEGER"], ["membership_status", "TEXT"],
    ["membership_category", "TEXT"], ["membership_name", "TEXT"],
    ["membership_checked_at", "TEXT"], ["membership_stale", "INTEGER"],
  ];
  for (const [mcol, mtype] of memCols) {
    if (!cols.includes(mcol)) {
      db.exec(`ALTER TABLE founder ADD COLUMN ${mcol} ${mtype}`);
    }
  }
  // google_sub = Google's stable, unique ID for the account (the "sub" claim).
  // We match on this first so a founder who later changes their Gmail address
  // still maps to the same record. Nullable: password-only accounts don't have it.
  if (!cols.includes("google_sub")) {
    db.exec("ALTER TABLE founder ADD COLUMN google_sub TEXT");
  }
  // Each uploaded deck: the file lives on disk (stored_path); the DB keeps a pointer + owner.
  db.exec(`CREATE TABLE IF NOT EXISTS deck(
      id INTEGER PRIMARY KEY AUTOINCREMENT, founder_id INTEGER, filename TEXT,
      stored_path TEXT, size INTEGER, uploaded_at TEXT)`);
  // Each AI read is saved against the founder + the deck it read.
  db.exec(`CREATE TABLE IF NOT EXISTS diagnostic(
      id INTEGER PRIMARY KEY AUTOINCREMENT, founder_id INTEGER, deck_id INTEGER,
      live INTEGER, summary TEXT, findings_json TEXT, created_at TEXT)`);
  // Expert review rounds. round 1 = the paid review; round 2 = the ONE free
  // re-review; round 3+ = paid again. verdict: 'not_yet' | 'awarded'.
  db.exec(`CREATE TABLE IF NOT EXISTS review(
      id INTEGER PRIMARY KEY AUTOINCREMENT, founder_id INTEGER, round INTEGER,
      verdict TEXT, gaps_json TEXT, reviewer TEXT, note TEXT, created_at TEXT)`);
  // Data room: one row per checklist item a founder has supplied a document for.
  // item_key ties the file back to the diligence checklist in the front-end.
  db.exec(`CREATE TABLE IF NOT EXISTS dataroom_doc(
      id INTEGER PRIMARY KEY AUTOINCREMENT, founder_id INTEGER, item_key TEXT,
      filename TEXT, stored_path TEXT, size INTEGER, uploaded_at TEXT)`);
  // Who opened which data-room document — the "who's actually interested" signal.
  db.exec(`CREATE TABLE IF NOT EXISTS dataroom_view(
      id INTEGER PRIMARY KEY AUTOINCREMENT, founder_id INTEGER, doc_id INTEGER,
      item_key TEXT, viewer TEXT, viewed_at TEXT)`);
  // Admin allow-list: who may enter the Team/Admin portal. The super-admin edits
  // this from inside the portal, so this table is the LIVE source of truth. On
  // first run it is seeded from the super-admins + ADMIN_EMAILS (.env).
  db.exec(`CREATE TABLE IF NOT EXISTS admin_allowlist(
      email TEXT PRIMARY KEY, added_by TEXT, added_at TEXT)`);
  const _adminSeed = new Set(ADMIN_SUPER_EMAILS);
  (ENV.ADMIN_EMAILS || "").split(",").forEach((e) => {
    e = (e || "").trim().toLowerCase();
    if (e) _adminSeed.add(e);
  });
  const _insAdmin = db.prepare(
    "INSERT OR IGNORE INTO admin_allowlist(email, added_by, added_at) VALUES(?,?,datetime('now'))");
  _adminSeed.forEach((e) => _insAdmin.run(e, "seed"));
  // Notifications: one row per important event, recorded even when email is off.
  db.exec(`CREATE TABLE IF NOT EXISTS notification(
      id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT, recipient TEXT,
      subject TEXT, body TEXT, urgency TEXT, created_at TEXT)`);
  // Email outbox: one row per recipient. status: 'pending' | 'sent' | 'failed'.
  // In record-only mode (no SMTP configured) rows simply stay 'pending'.
  db.exec(`CREATE TABLE IF NOT EXISTS email_outbox(
      id INTEGER PRIMARY KEY AUTOINCREMENT, notification_id INTEGER, to_email TEXT,
      subject TEXT, body TEXT, status TEXT DEFAULT 'pending', error TEXT,
      created_at TEXT, sent_at TEXT)`);
  // Payments: a real row every time a founder/investor pays for something
  // (membership, expert review, deal-flow access). No card data is stored —
  // this is the prototype record that drives the receipt notification.
  db.exec(`CREATE TABLE IF NOT EXISTS payment(
      id INTEGER PRIMARY KEY AUTOINCREMENT, payer_email TEXT, payer_name TEXT,
      founder_id INTEGER, item TEXT, amount TEXT, period TEXT,
      status TEXT DEFAULT 'paid', created_at TEXT)`);
  // Review assignment: which reviewer is responsible for a founder's review,
  // who assigned it, and the SLA target. One row per assignment/reassignment.
  db.exec(`CREATE TABLE IF NOT EXISTS review_assignment(
      id INTEGER PRIMARY KEY AUTOINCREMENT, founder_id INTEGER, founder_name TEXT,
      reviewer_email TEXT, reviewer_name TEXT, assigned_by TEXT,
      status TEXT DEFAULT 'assigned', sla_due TEXT, created_at TEXT)`);
  // Investors: real screened-access records. A primary applicant is a row with
  // parent_investor_id = NULL; each firm team-mate they invite is a row that
  // points back to the primary via parent_investor_id. status walks:
  // 'pending' -> 'approved' | 'rejected'; invited team-mates start 'invited'.
  db.exec(`CREATE TABLE IF NOT EXISTS investor(
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT UNIQUE, firm TEXT,
      tie_status TEXT, cheque_size TEXT, focus TEXT, track_record TEXT,
      recent_investments TEXT, status TEXT DEFAULT 'pending', parent_investor_id INTEGER,
      decided_by TEXT, decided_at TEXT, created_at TEXT)`);
  // Meeting requests: an investor asks TiE to introduce them to a founder.
  // TiE facilitates every intro (no direct messaging). status walks:
  // 'requested' -> 'intro_sent' -> 'held' | 'declined'.
  db.exec(`CREATE TABLE IF NOT EXISTS meeting(
      id INTEGER PRIMARY KEY AUTOINCREMENT, founder_id INTEGER, founder_name TEXT,
      startup TEXT, investor_id INTEGER, investor_name TEXT, investor_email TEXT,
      status TEXT DEFAULT 'requested', requested_at TEXT, intro_sent_at TEXT)`);
  // Deals: one founder<->investor relationship tracked from introduction to
  // outcome. This is the substrate for TiE's impact reporting. stage walks:
  // 'introduced' -> 'met' -> 'diligence' -> 'term_sheet' -> 'closed' | 'passed'.
  // amount_inr is optional (a deal can be 'closed' with amount undisclosed).
  // founder_confirmed / investor_confirmed record TWO-SIDED attestation of the
  // current stage; tie_verified is TiE's own spot-check. *_consent_public gate
  // whether the deal may EVER feed public/anonymised impact figures.
  db.exec(`CREATE TABLE IF NOT EXISTS deal(
      id INTEGER PRIMARY KEY AUTOINCREMENT, founder_id INTEGER, founder_name TEXT,
      startup TEXT, investor_id INTEGER, investor_name TEXT, investor_email TEXT, firm TEXT,
      stage TEXT DEFAULT 'introduced', amount_inr INTEGER, amount_disclosed INTEGER DEFAULT 0,
      founder_consent_public INTEGER DEFAULT 0, investor_consent_public INTEGER DEFAULT 0,
      founder_confirmed INTEGER DEFAULT 0, investor_confirmed INTEGER DEFAULT 0,
      tie_verified INTEGER DEFAULT 0, source TEXT, meeting_id INTEGER, note TEXT,
      created_at TEXT, updated_at TEXT, closed_at TEXT)`);
  if (db.prepare("SELECT COUNT(*) c FROM support").get().c === 0) {
    const seeds = [
      ["SUP-204", "Meera Suresh", "Founder", "TiE membership verification",
        "My member email isn't recognised at the gate", "", "New", "3h ago"],
      ["SUP-203", "Narendra Bhandari", "Investor", "Login or access problem",
        "Colleague can't accept the firm invite", "", "In progress", "Yesterday"],
      ["SUP-202", "Rajan Kumar", "Reviewer", "My review status",
        "Which deck is next in my queue?", "", "Resolved", "2 days ago"],
    ];
    const ins = db.prepare(
      "INSERT INTO support(ref,from_name,role,category,subject,message,status,received,created_at) " +
      "VALUES(?,?,?,?,?,?,?,?,datetime('now'))");
    const tx = db.transaction((rows) => rows.forEach((r) => ins.run(...r)));
    tx(seeds);
  }
}

function support_add(d) {
  const cur = db.prepare(
    "INSERT INTO support(ref,from_name,role,category,subject,message,status,received,created_at) " +
    "VALUES('',?,?,?,?,?,'New','Just now',datetime('now'))").run(
    d.from_name || "", d.role || "", d.category || "", d.subject || "", d.message || "");
  const rid = Number(cur.lastInsertRowid);
  const ref = "SUP-" + (204 + rid);
  db.prepare("UPDATE support SET ref=? WHERE id=?").run(ref, rid);
  const row = db.prepare("SELECT * FROM support WHERE id=?").get(rid);
  notify("support_request", ["admins"],
    "New support request: " + (d.subject || "(no subject)"),
    (d.from_name || "Someone") + " (" + (d.role || "user") +
    ") submitted a support request. " + (d.message || ""), "normal");
  return row;
}

function support_list() {
  const rows = db.prepare("SELECT * FROM support ORDER BY id DESC").all();
  return { support: rows };
}

// ---- Founders (real per-user records) ----
const DECKS_DIR = path.join(HERE, "decks");

// --- Password handling (PROTOTYPE-GRADE, not production security) ---
// Passwords are never stored or logged in plaintext. Each founder gets a random
// per-user salt; we store only the PBKDF2-SHA256 hash. A real deployment should
// replace this with a vetted auth service and add rate-limiting / email verify.
// NOTE: parameters (100000 iterations, sha256, 32-byte key, hex salt) match the
// Python app EXACTLY, so existing data.db password hashes still validate.
function hash_pw(password, salt) {
  if (salt == null) salt = crypto.randomBytes(16).toString("hex");
  const dk = crypto.pbkdf2Sync(String(password || ""), salt, 100000, 32, "sha256");
  return [dk.toString("hex"), salt];
}

function timing_safe_equal(a, b) {
  // Constant-time compare of two hex strings; guard against length mismatch first.
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function public_founder(row) {
  // Strip secret columns so a founder's password hash never leaves the server.
  if (!row) return null;
  const out = { ...row };
  delete out.password_hash;
  delete out.password_salt;
  return out;
}

async function founder_signup(d) {
  // Register a founder with a password. Errors if the email already has one.
  const email = (d.email || "").trim().toLowerCase();
  const password = d.password || "";
  if (!email || !password) {
    return { error: "Email and password are required." };
  }
  const existing = db.prepare("SELECT * FROM founder WHERE email=?").get(email);
  if (existing && existing.password_hash) {
    return { error: "That email is already registered. Please log in instead." };
  }
  const [pw_hash, pw_salt] = hash_pw(password);
  const fields = ["name", "company", "role", "phone", "city", "stage", "sector", "linkedin"];
  const vals = fields.map((f) => d[f] || "");
  let fid;
  if (existing) {
    db.prepare("UPDATE founder SET name=?,company=?,role=?,phone=?,city=?,stage=?,sector=?,linkedin=?," +
      "password_hash=?,password_salt=? WHERE id=?").run(...vals, pw_hash, pw_salt, existing.id);
    fid = existing.id;
  } else {
    const cur = db.prepare(
      "INSERT INTO founder(name,email,company,role,phone,city,stage,sector,linkedin," +
      "password_hash,password_salt,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,datetime('now'))").run(
      d.name || "", email, ...vals.slice(1), pw_hash, pw_salt);
    fid = Number(cur.lastInsertRowid);
  }
  const row = db.prepare("SELECT * FROM founder WHERE id=?").get(fid);
  // Check TiE membership with Zoho as part of signing up, so the new profile
  // already shows the correct member status.
  const refreshed = await refresh_membership(fid);
  const pub = public_founder(refreshed || row) || {};
  notify("founder_welcome", [email],
    "Welcome to VentureReady",
    "Thanks for creating your VentureReady account, " + (pub.name || "founder") +
    ". You can now run the free positioning diagnostic and submit your deck for expert review.",
    "normal");
  return { founder: pub };
}

async function founder_login(email, password) {
  // Verify credentials in constant time. Returns the public profile or an error.
  email = (email || "").trim().toLowerCase();
  const row = db.prepare("SELECT * FROM founder WHERE email=?").get(email);
  if (!row || !row.password_hash || !row.password_salt) {
    return { error: "No account found for that email, or it has no password set." };
  }
  const [calc] = hash_pw(password, row.password_salt);
  if (!timing_safe_equal(calc, row.password_hash)) {
    return { error: "Incorrect email or password." };
  }
  // Re-check TiE membership with Zoho on every sign-in and cache the result.
  const refreshed = await refresh_membership(row.id);
  return { founder: public_founder(refreshed || row) };
}

function founder_upsert(d) {
  // Create or update a founder by email, then return the full row (with its id).
  const email = (d.email || "").trim().toLowerCase();
  const fields = ["name", "company", "role", "phone", "city", "stage", "sector", "linkedin"];
  const vals = fields.map((f) => d[f] || "");
  let existing = null;
  if (email) existing = db.prepare("SELECT * FROM founder WHERE email=?").get(email);
  let fid;
  if (existing) {
    db.prepare("UPDATE founder SET name=?,company=?,role=?,phone=?,city=?,stage=?,sector=?,linkedin=? WHERE id=?")
      .run(...vals, existing.id);
    fid = existing.id;
  } else {
    const cur = db.prepare(
      "INSERT INTO founder(name,email,company,role,phone,city,stage,sector,linkedin,created_at) " +
      "VALUES(?,?,?,?,?,?,?,?,?,datetime('now'))").run(d.name || "", email, ...vals.slice(1));
    fid = Number(cur.lastInsertRowid);
  }
  return public_founder(db.prepare("SELECT * FROM founder WHERE id=?").get(fid));
}

function founder_get(fid) {
  const r = db.prepare("SELECT * FROM founder WHERE id=?").get(fid);
  const out = r ? public_founder(r) : null;
  if (out) {
    const dg = db.prepare(
      "SELECT d.*, k.filename FROM diagnostic d LEFT JOIN deck k ON k.id=d.deck_id " +
      "WHERE d.founder_id=? ORDER BY d.id DESC LIMIT 1").get(fid);
    if (dg) {
      out.latest_diagnostic = {
        live: Boolean(dg.live), summary: dg.summary,
        findings: JSON.parse(dg.findings_json || "[]"), filename: dg.filename || "",
      };
    }
  }
  return out;
}

function deck_add(founder_id, filename, raw) {
  // Save the uploaded deck file to disk and record a row pointing to it.
  if (!fs.existsSync(DECKS_DIR)) fs.mkdirSync(DECKS_DIR);
  const safe = Array.from(filename || "deck.pdf")
    .filter((c) => /[A-Za-z0-9]/.test(c) || "._- ".includes(c)).join("");
  const stored = `f${founder_id || 0}_${Math.floor(Date.now() / 1000)}_${safe}`;
  fs.writeFileSync(path.join(DECKS_DIR, stored), raw);
  const cur = db.prepare("INSERT INTO deck(founder_id,filename,stored_path,size,uploaded_at) " +
    "VALUES(?,?,?,?,datetime('now'))").run(founder_id, filename, stored, raw.length);
  const fb = _founder_brief(founder_id);
  notify("deck_submitted", ["admins"],
    "New deck submitted for review",
    (fb.name || "A founder") + (fb.company ? (" (" + fb.company + ")") : "") +
    " uploaded a pitch deck: " + (filename || "deck") + ".", "normal");
  return Number(cur.lastInsertRowid);
}

// ---- Expert review rounds & the one-free-re-review rule ----
const FREE_REREVIEW_ROUND = 2; // round 1 = paid review, round 2 = the single free re-review
const REREVIEW_FEE = "₹3,000 + GST";

function review_add(founder_id, verdict, gaps, reviewer, note) {
  // Record a reviewer's verdict as the next round for this founder.
  const last = db.prepare("SELECT MAX(round) m FROM review WHERE founder_id=?").get(founder_id);
  const rnd = (last.m || 0) + 1;
  db.prepare("INSERT INTO review(founder_id,round,verdict,gaps_json,reviewer,note,created_at) " +
    "VALUES(?,?,?,?,?,?,datetime('now'))").run(
    founder_id, rnd, verdict, JSON.stringify(gaps || []), reviewer || "TiE Reviewer", note || "");
  const fb = _founder_brief(founder_id);
  if (verdict === "awarded") {
    if (fb.email) {
      notify("mark_awarded", [fb.email],
        "You have earned the VentureReady mark",
        "Congratulations " + (fb.name || "") +
        " — your venture has been awarded the VentureReady mark. Screened investors can now discover your profile.",
        "high");
    }
    notify("mark_awarded_admin", ["admins"],
      "VentureReady mark awarded",
      "The VentureReady mark was awarded to " +
      (fb.name || ("founder #" + founder_id)) + ".", "normal");
  } else {
    if (fb.email) {
      notify("review_feedback", [fb.email],
        "Your VentureReady review feedback is ready",
        "Your expert review is complete, with feedback to act on before the next round. " +
        "Sign in to VentureReady to see the details.", "normal");
    }
    notify("verdict_recorded", ["admins"],
      "A reviewer verdict was recorded",
      (reviewer || "A reviewer") + " recorded a 'not yet' verdict for " +
      (fb.name || ("founder #" + founder_id)) + ".", "normal");
  }
  return review_state(founder_id);
}

function review_state(founder_id) {
  // Everything the founder's screens need: history, latest verdict, and whether
  // the next re-review is the free one or has to be paid for.
  const rows = db.prepare(
    "SELECT round,verdict,gaps_json,reviewer,note,created_at FROM review " +
    "WHERE founder_id=? ORDER BY round").all(founder_id);
  for (const r of rows) {
    r.gaps = JSON.parse(r.gaps_json || "[]");
    delete r.gaps_json;
  }
  const latest = rows.length ? rows[rows.length - 1] : null;
  const rounds_done = rows.length;
  const next_round = rounds_done + 1;
  return {
    rounds: rows,
    latest: latest,
    rounds_done: rounds_done,
    next_round: next_round,
    // The single free re-review is round 2 and only if they haven't already earned the mark.
    free_rereview_available: (next_round === FREE_REREVIEW_ROUND &&
      Boolean(latest) && latest.verdict === "not_yet"),
    free_rereview_used: rounds_done >= FREE_REREVIEW_ROUND,
    rereview_fee: REREVIEW_FEE,
  };
}

// ---- Data room (diligence documents) ----
const DATAROOM_DIR = path.join(HERE, "dataroom");

function dataroom_add(founder_id, item_key, filename, raw) {
  // Save a diligence document and point the checklist item at it.
  // One document per checklist item — re-uploading replaces the previous file's row.
  if (!fs.existsSync(DATAROOM_DIR)) fs.mkdirSync(DATAROOM_DIR);
  const safe = Array.from(filename || "doc.pdf")
    .filter((c) => /[A-Za-z0-9]/.test(c) || "._- ".includes(c)).join("");
  const stored = `f${founder_id || 0}_${(item_key || "item").slice(0, 24)}_${Math.floor(Date.now() / 1000)}_${safe}`;
  fs.writeFileSync(path.join(DATAROOM_DIR, stored), raw);
  db.prepare("DELETE FROM dataroom_doc WHERE founder_id=? AND item_key=?").run(founder_id, item_key);
  const cur = db.prepare("INSERT INTO dataroom_doc(founder_id,item_key,filename,stored_path,size,uploaded_at) " +
    "VALUES(?,?,?,?,?,datetime('now'))").run(founder_id, item_key, filename, stored, raw.length);
  return Number(cur.lastInsertRowid);
}

function dataroom_list(founder_id) {
  // Everything this founder has supplied, plus who has opened what.
  const docs = db.prepare(
    "SELECT id,item_key,filename,size,uploaded_at FROM dataroom_doc WHERE founder_id=? " +
    "ORDER BY item_key").all(founder_id);
  const views = db.prepare(
    "SELECT item_key,viewer,viewed_at FROM dataroom_view WHERE founder_id=? " +
    "ORDER BY id DESC LIMIT 25").all(founder_id);
  return { docs: docs, views: views };
}

function dataroom_view_log(founder_id, doc_id, item_key, viewer) {
  db.prepare("INSERT INTO dataroom_view(founder_id,doc_id,item_key,viewer,viewed_at) " +
    "VALUES(?,?,?,?,datetime('now'))").run(founder_id, doc_id, item_key, viewer || "Unknown");
  return { ok: true };
}

function diagnostic_find_reusable(founder_id, filename, size) {
  // Return a prior AI read for the same founder + identical deck (same filename and
  // byte-size) so we never pay the API twice for the same deck. null if nothing to reuse.
  const row = db.prepare(
    "SELECT dg.live, dg.summary, dg.findings_json " +
    "FROM diagnostic dg JOIN deck k ON k.id = dg.deck_id " +
    "WHERE dg.founder_id=? AND k.filename=? AND k.size=? " +
    "ORDER BY dg.id DESC LIMIT 1").get(founder_id, filename, size);
  if (!row) return null;
  return {
    live: Boolean(row.live), summary: row.summary,
    findings: JSON.parse(row.findings_json || "[]"), reused: true,
  };
}

function diagnostic_save(founder_id, deck_id, result) {
  db.prepare("INSERT INTO diagnostic(founder_id,deck_id,live,summary,findings_json,created_at) " +
    "VALUES(?,?,?,?,?,datetime('now'))").run(
    founder_id, deck_id, result.live ? 1 : 0,
    result.summary || "", JSON.stringify(result.findings || []));
}

// ---- load .env (private config: Zoho keys + optional Anthropic key) ----
const ENV = {};
try {
  const text = fs.readFileSync(path.join(HERE, ".env"), "utf-8");
  for (let line of text.split("\n")) {
    line = line.trim();
    if (line && line.includes("=") && !line.startsWith("#")) {
      const idx = line.indexOf("=");
      ENV[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
} catch (e) {
  console.log("WARNING: .env not found — Zoho check will not work.");
}

const ZOHO_CLIENT_ID = ENV.ZOHO_CLIENT_ID || "";
const ZOHO_CLIENT_SECRET = ENV.ZOHO_CLIENT_SECRET || "";
const ANTHROPIC_API_KEY = ENV.ANTHROPIC_API_KEY || "";
// Google sign-in ("Continue with Google"). This is the PUBLIC OAuth Client ID —
// it is safe to expose to the browser (that's how Google's button works). There
// is NO client secret here: the browser gets a signed ID token and the server
// only verifies it, so no secret is needed for this flow. Blank = feature off
// (the button falls back to the demo sign-in).
const GOOGLE_CLIENT_ID = ENV.GOOGLE_CLIENT_ID || "";

// Where founders go to actually BUY a TiE Bangalore membership. Membership money
// is not taken in this app — Zoho owns the membership record, so we hand off to
// it and then re-check the result. Set TIE_MEMBERSHIP_URL in .env; if it's blank
// the front-end hides the join buttons rather than showing a broken link.
const TIE_MEMBERSHIP_URL = (ENV.TIE_MEMBERSHIP_URL || "").trim();

// ---- Admin / Team-Portal access allow-list ----
// Only these Google-verified emails may enter the admin portal. Access is an
// explicit allow-list (NOT the whole @tiebangalore.org domain).
//
// SUPER-ADMINS are the trust anchor: they can add/remove admins and cannot be
// removed in-app. Set them (comma-separated) via ADMIN_SUPER_EMAILS in .env;
// default = the two TiE Bangalore owners.
const ADMIN_SUPER_EMAILS = (function () {
  const raw = ENV.ADMIN_SUPER_EMAILS || ENV.ADMIN_SUPER_EMAIL ||
    "admin.blr@tiebangalore.org,chinmay@tiebangalore.org";
  const set = new Set();
  raw.split(",").forEach((e) => { e = (e || "").trim().toLowerCase(); if (e) set.add(e); });
  return set;
})();
function is_super_admin(email) {
  return ADMIN_SUPER_EMAILS.has((email || "").trim().toLowerCase());
}
// ADMIN_EMAILS from .env is only a FIRST-RUN SEED. The live allow-list lives in
// the admin_allowlist table (see db_init) so a super-admin can add/remove
// admins from inside the portal without editing files or restarting the server.
function admin_role_for(email) {
  email = (email || "").trim().toLowerCase();
  if (!email) return null;
  if (is_super_admin(email)) return "super-admin";
  const row = db.prepare("SELECT email FROM admin_allowlist WHERE email=?").get(email);
  return row ? "admin" : null;
}
function admin_list() {
  // Super-admins sort to the top; everyone else alphabetically.
  const rows = db.prepare(
    "SELECT email, added_by, added_at FROM admin_allowlist ORDER BY email ASC"
  ).all();
  const mapped = rows.map((r) => ({
    email: r.email,
    role: is_super_admin(r.email) ? "super-admin" : "admin",
    added_by: r.added_by || "",
    added_at: r.added_at || "",
  }));
  mapped.sort((a, b) => {
    const sa = a.role === "super-admin" ? 0 : 1;
    const sb = b.role === "super-admin" ? 0 : 1;
    return sa - sb || a.email.localeCompare(b.email);
  });
  return mapped;
}
// Verify a Google credential and require it to be a SUPER-admin. This guards the
// admin-management endpoints: there are no browser sessions yet, so the caller
// proves who they are by sending their Google ID token with each request.
async function require_super_admin(idToken) {
  const v = await verify_google_token(idToken);
  if (v.error) return { error: v.error, status: 401 };
  if (!is_super_admin(v.email)) {
    return { error: "Only a super-admin can manage admin access.", status: 403 };
  }
  return { email: v.email };
}

// ---- Notifications & email outbox ----
// Every important event is RECORDED here (a notification plus one email_outbox
// row per recipient). Whether a recorded message is actually EMAILED depends on
// MAIL_ENABLED, which is true only when a full SMTP configuration is present in
// .env. Until then the platform runs in "record-only" mode: messages are
// captured and shown on the admin Notifications screen, but nothing is sent.
// This keeps the app safe to run before a mail provider is wired up.
const SMTP_HOST = (ENV.SMTP_HOST || "").trim();
const SMTP_PORT = parseInt((ENV.SMTP_PORT || "587").trim() || "587", 10);
const SMTP_USER = (ENV.SMTP_USER || "").trim();
const SMTP_PASS = (ENV.SMTP_PASS || "").trim();
const MAIL_FROM = (ENV.MAIL_FROM || "").trim() || SMTP_USER;
const MAIL_FROM_NAME = (ENV.MAIL_FROM_NAME || "VentureReady").trim();
const MAIL_ENABLED = !!(SMTP_HOST && SMTP_USER && SMTP_PASS && MAIL_FROM);

function _admin_emails() {
  return db.prepare("SELECT email FROM admin_allowlist ORDER BY email ASC")
    .all().map((r) => r.email);
}

function _founder_brief(founder_id) {
  // Name/email/company for composing a notification about a founder.
  const row = db.prepare("SELECT name, email, company FROM founder WHERE id=?").get(founder_id);
  if (!row) return { name: "", email: "", company: "" };
  return { name: row.name || "", email: row.email || "", company: row.company || "" };
}

function _expand_recipients(recipients) {
  // Accept a list of email addresses and/or the token "admins" (= everyone on
  // the allow-list). Returns a de-duplicated list with blanks removed.
  const out = [];
  (recipients || []).forEach((r) => {
    r = (r || "").trim();
    if (!r) return;
    if (r.toLowerCase() === "admins") out.push(..._admin_emails());
    else out.push(r);
  });
  const seen = new Set();
  const uniq = [];
  out.forEach((e) => {
    const k = e.trim().toLowerCase();
    if (k && !seen.has(k)) { seen.add(k); uniq.push(e); }
  });
  return uniq;
}

function notify(event, recipients, subject, body, urgency) {
  // Record one notification + one pending email per recipient. Actual sending
  // happens later (Stage 3) and only when MAIL_ENABLED; for now the rows simply
  // wait in the outbox. Returns how many recipients were recorded.
  urgency = urgency || "normal";
  const insN = db.prepare(
    "INSERT INTO notification(event, recipient, subject, body, urgency, created_at) " +
    "VALUES(?,?,?,?,?,datetime('now'))");
  const insO = db.prepare(
    "INSERT INTO email_outbox(notification_id, to_email, subject, body, status, created_at) " +
    "VALUES(?,?,?,?,'pending',datetime('now'))");
  let n = 0;
  _expand_recipients(recipients).forEach((to) => {
    const info = insN.run(event, to, subject, body, urgency);
    insO.run(info.lastInsertRowid, to, subject, body);
    n += 1;
  });
  return n;
}

async function require_admin(idToken) {
  // Any admin (super-admin OR regular) may view the notifications feed.
  const v = await verify_google_token(idToken);
  if (v.error) return { error: v.error, status: 401 };
  const role = admin_role_for(v.email);
  if (!role) return { error: "Admin access required.", status: 403 };
  return { email: v.email, role: role };
}

function notifications_recent(limit) {
  const rows = db.prepare(
    "SELECT n.id, n.event, n.recipient, n.subject, n.body, n.urgency, n.created_at, " +
    "o.status FROM notification n LEFT JOIN email_outbox o ON o.notification_id = n.id " +
    "ORDER BY n.id DESC LIMIT ?").all(limit || 100);
  return rows.map((r) => ({
    id: r.id, event: r.event, recipient: r.recipient, subject: r.subject,
    body: r.body, urgency: r.urgency || "normal", created_at: r.created_at || "",
    status: r.status || "pending",
  }));
}

// ---- Payments (real records + receipt notification) -----------------------
function payment_record(d) {
  // Record a payment. No card details are ever stored — only what was bought.
  // Fires a receipt to the payer and a heads-up to admins.
  let payer_email = (d.payer_email || "").trim().toLowerCase();
  let payer_name = (d.payer_name || "").trim();
  const founder_id = d.founder_id;
  const item = (d.item || "").trim();
  const amount = (d.amount || "").trim();
  const period = (d.period || "").trim();
  // Fall back to the logged-in founder's email if the caller didn't send one.
  if (!payer_email && founder_id) {
    const fb = _founder_brief(founder_id);
    payer_email = (fb.email || "").trim().toLowerCase();
    payer_name = payer_name || fb.name || "";
  }
  // Don't record an empty shell of a payment — we need at least what was
  // bought, or someone to attribute it to.
  if (!item && !payer_email) {
    return { error: "A payment needs at least an item or a payer.", status: 400 };
  }
  const cur = db.prepare(
    "INSERT INTO payment(payer_email, payer_name, founder_id, item, amount, period, " +
    "status, created_at) VALUES(?,?,?,?,?,?, 'paid', datetime('now'))"
  ).run(payer_email, payer_name, founder_id, item, amount, period);
  const pid = cur.lastInsertRowid;
  const row = db.prepare("SELECT * FROM payment WHERE id=?").get(pid);
  const amt_str = (amount + (period ? " " + period : "")).trim();
  if (payer_email) {
    notify("payment_receipt", [payer_email],
      "Your VentureReady payment receipt",
      "We've received your payment of " + (amt_str || "your fee") + " for " +
      (item || "VentureReady access") + ". Thank you — your access is now active.",
      "normal");
  }
  notify("payment_received", ["admins"],
    "Payment received: " + (item || "VentureReady access"),
    (payer_name || payer_email || "A user") + " paid " + (amt_str || "a fee") +
    " for " + (item || "VentureReady access") + ".", "normal");
  return { payment: row };
}

// ---- Reviewer assignment (real records + reviewer notification) -----------
function review_queue() {
  // Founders who have submitted at least one deck are candidates for review.
  // For each, show their most recent reviewer assignment (if any).
  const rows = db.prepare(
    "SELECT f.id, f.name, f.company, f.stage, f.sector, " +
    "  (SELECT MAX(uploaded_at) FROM deck d WHERE d.founder_id=f.id) AS last_deck, " +
    "  (SELECT COUNT(*) FROM deck d WHERE d.founder_id=f.id) AS deck_count " +
    "FROM founder f " +
    "WHERE (SELECT COUNT(*) FROM deck d WHERE d.founder_id=f.id) > 0 " +
    "ORDER BY last_deck DESC").all();
  const aStmt = db.prepare(
    "SELECT reviewer_email, reviewer_name, status, created_at FROM review_assignment " +
    "WHERE founder_id=? ORDER BY id DESC LIMIT 1");
  return rows.map((r) => {
    const a = aStmt.get(r.id);
    return {
      founder_id: r.id, name: r.name || "", company: r.company || "",
      stage: r.stage || "", sector: r.sector || "",
      last_deck: r.last_deck || "", deck_count: r.deck_count || 0,
      reviewer_email: a ? a.reviewer_email : "", reviewer_name: a ? a.reviewer_name : "",
      assignment_status: a ? a.status : "",
    };
  });
}

async function review_assign(idToken, founder_id, reviewer_email, reviewer_name) {
  const g = await require_admin(idToken);
  if (g.error) return g;
  reviewer_email = (reviewer_email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(reviewer_email)) {
    return { error: "Please enter a valid reviewer email address.", status: 400 };
  }
  const fb = _founder_brief(founder_id);
  if (!fb.email && !fb.name) return { error: "Unknown founder.", status: 404 };
  reviewer_name = (reviewer_name || "").trim() || reviewer_email.split("@")[0];
  const prior = db.prepare("SELECT COUNT(*) c FROM review_assignment WHERE founder_id=?").get(founder_id).c;
  const status = prior ? "reassigned" : "assigned";
  db.prepare(
    "INSERT INTO review_assignment(founder_id, founder_name, reviewer_email, reviewer_name, " +
    "assigned_by, status, sla_due, created_at) VALUES(?,?,?,?,?,?, date('now','+5 day'), datetime('now'))"
  ).run(founder_id, fb.name || "", reviewer_email, reviewer_name, g.email, status);
  const startup = fb.company || fb.name || "a founder";
  notify("review_assigned", [reviewer_email],
    "You've been assigned a VentureReady review",
    "TiE Bangalore has assigned you to review " + startup + "'s submission. " +
    "Target turnaround is 3–5 business days. Please open the Team Portal to begin.", "normal");
  notify("review_assigned_admin", ["admins"],
    "Review assigned: " + startup,
    g.email + " assigned " + startup + "'s review to " + reviewer_name +
    " (" + reviewer_email + ").", "normal");
  return { ok: true, queue: review_queue() };
}

// ---- Investors (real screened-access records) -----------------------------
function _investor_row(r) {
  if (!r) return null;
  return {
    id: r.id, name: r.name || "", email: r.email || "", firm: r.firm || "",
    tie_status: r.tie_status || "", cheque_size: r.cheque_size || "",
    focus: r.focus || "", track_record: r.track_record || "",
    recent_investments: r.recent_investments || "", status: r.status || "pending",
    parent_investor_id: r.parent_investor_id,
    decided_by: r.decided_by || "", decided_at: r.decided_at || "",
    created_at: r.created_at || "",
  };
}

function investor_apply(d) {
  // A screened-access application from the public investor form. Creates (or
  // refreshes) a 'pending' investor record and tells the admins to review it.
  const email = (d.email || "").trim().toLowerCase();
  const name = (d.name || "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { error: "Please enter a valid email address.", status: 400 };
  }
  if (!name) return { error: "Please enter your full name.", status: 400 };
  const f = {
    firm: (d.firm || "").trim(), tie_status: (d.tie_status || "").trim(),
    cheque_size: (d.cheque_size || "").trim(), focus: (d.focus || "").trim(),
    track_record: (d.track_record || "").trim(),
    recent_investments: (d.recent_investments || "").trim(),
  };
  const existing = db.prepare("SELECT * FROM investor WHERE email=?").get(email);
  if (existing && (existing.status || "") === "approved") {
    return { error: "That email already has approved investor access. Please sign in instead.", status: 400 };
  }
  let iid;
  if (existing) {
    db.prepare(
      "UPDATE investor SET name=?, firm=?, tie_status=?, cheque_size=?, focus=?, " +
      "track_record=?, recent_investments=?, status='pending' WHERE id=?"
    ).run(name, f.firm, f.tie_status, f.cheque_size, f.focus, f.track_record,
      f.recent_investments, existing.id);
    iid = existing.id;
  } else {
    const cur = db.prepare(
      "INSERT INTO investor(name, email, firm, tie_status, cheque_size, focus, track_record, " +
      "recent_investments, status, created_at) VALUES(?,?,?,?,?,?,?,?, 'pending', datetime('now'))"
    ).run(name, email, f.firm, f.tie_status, f.cheque_size, f.focus, f.track_record, f.recent_investments);
    iid = cur.lastInsertRowid;
  }
  const row = db.prepare("SELECT * FROM investor WHERE id=?").get(iid);
  notify("investor_application", ["admins"],
    "New investor application: " + (f.firm || name),
    name + " (" + email + ")" + (f.firm ? " from " + f.firm : "") +
    " applied for screened deal-flow access. TiE status: " +
    (f.tie_status || "not stated") + ". Review them in the Team Portal.", "normal");
  return { investor: _investor_row(row) };
}

async function investor_list(idToken) {
  const g = await require_admin(idToken);
  if (g.error) return g;
  const rows = db.prepare("SELECT * FROM investor ORDER BY id DESC").all();
  return { investors: rows.map(_investor_row) };
}

async function investor_decision(idToken, investor_id, decision, reason) {
  // Admin approves or rejects a screened-access application; the investor is told.
  const g = await require_admin(idToken);
  if (g.error) return g;
  if (!["approved", "rejected"].includes(decision)) {
    return { error: "decision must be 'approved' or 'rejected'.", status: 400 };
  }
  const row = db.prepare("SELECT * FROM investor WHERE id=?").get(investor_id);
  if (!row) return { error: "Unknown investor.", status: 404 };
  db.prepare("UPDATE investor SET status=?, decided_by=?, decided_at=datetime('now') WHERE id=?")
    .run(decision, g.email, investor_id);
  const who = row.name || row.email;
  if (decision === "approved") {
    notify("investor_approved", [row.email],
      "Your VentureReady investor access is approved",
      "Good news — TiE Bangalore has approved your application for screened deal-flow " +
      "access. The next step is to sign your NDA, after which you can view " +
      "VentureReady-marked founders.", "normal");
  } else {
    notify("investor_rejected", [row.email],
      "About your VentureReady investor application",
      "Thank you for applying for screened deal-flow access. After review, TiE Bangalore " +
      "is not able to approve your application at this time." +
      (reason ? " Note: " + reason : ""), "normal");
  }
  notify("investor_decision_admin", ["admins"],
    "Investor " + decision + ": " + who,
    g.email + " " + decision + " " + who + " (" + row.email + ").", "normal");
  const listed = await investor_list(idToken);
  return { ok: true, investors: listed.investors || [] };
}

const INVESTOR_TEAM_SEATS = 3;

function investor_invite(d) {
  // An approved investor adds up to 3 colleagues from their firm. Each becomes
  // its own 'invited' investor row (each must sign their own NDA), and each is
  // notified individually — the inviter's signature does NOT cover them.
  const inviter_email = (d.inviter_email || "").trim().toLowerCase();
  const users = d.users || [];
  const inviter = db.prepare("SELECT * FROM investor WHERE email=?").get(inviter_email);
  if (!inviter) {
    return { error: "We couldn't find your investor record. Please apply first.", status: 404 };
  }
  if ((inviter.status || "") !== "approved") {
    return { error: "Your investor access isn't approved yet, so you can't add team members.", status: 403 };
  }
  const parent_id = inviter.parent_investor_id || inviter.id;
  const used = db.prepare("SELECT COUNT(*) c FROM investor WHERE parent_investor_id=?").get(parent_id).c;
  const added = [], skipped = [];
  const insTeam = db.prepare(
    "INSERT INTO investor(name, email, firm, tie_status, status, parent_investor_id, created_at) " +
    "VALUES(?,?,?,?, 'invited', ?, datetime('now'))");
  users.forEach((u) => {
    const email = ((u || {}).email || "").trim().toLowerCase();
    const name = ((u || {}).name || "").trim();
    if (!email) return;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      skipped.push({ email: email, why: "not a valid email address" });
      return;
    }
    if (used + added.length >= INVESTOR_TEAM_SEATS) {
      skipped.push({ email: email, why: "no team seats left (limit " + INVESTOR_TEAM_SEATS + ")" });
      return;
    }
    if (db.prepare("SELECT 1 FROM investor WHERE email=?").get(email)) {
      skipped.push({ email: email, why: "already has a VentureReady investor record" });
      return;
    }
    insTeam.run(name || email.split("@")[0], email, inviter.firm || "", inviter.tie_status || "", parent_id);
    added.push({ email: email, name: name || email.split("@")[0] });
  });
  const firm = inviter.firm || "your firm";
  added.forEach((a) => {
    notify("investor_user_invited", [a.email],
      "You've been invited to VentureReady deal flow",
      (inviter.name || inviter_email) + " has added you to " + firm +
      "'s VentureReady deal-flow access. You must verify your email and sign your own " +
      "NDA before you can view any founder material — their signature does not cover you.",
      "normal");
  });
  if (added.length) {
    const emails = added.map((a) => a.email).join(", ");
    notify("investor_users_added", [inviter_email],
      "Your firm's team invitations were sent",
      "You added " + added.length + " colleague(s) to " + firm +
      "'s VentureReady access: " + emails + ". Each must sign their own NDA.", "normal");
    notify("investor_users_added_admin", ["admins"],
      "Investor team seats used: " + firm,
      (inviter.name || inviter_email) + " added " + added.length +
      " team member(s) to " + firm + ": " + emails + ".", "normal");
  }
  return { added: added, skipped: skipped,
    seats_left: Math.max(0, INVESTOR_TEAM_SEATS - (used + added.length)) };
}

// ---- Membership hand-off (money is taken in Zoho, never in this app) -------
function membership_handoff(d) {
  // Records that a founder was sent to Zoho to join, so admins can follow up
  // on people who start but never finish. This is NOT a payment record — the
  // app never sees the money and never claims they paid.
  const founder_id = d.founder_id;
  const fb = founder_id ? _founder_brief(founder_id) : {};
  const email = (d.email || fb.email || "").trim().toLowerCase();
  const name = (d.name || fb.name || "").trim();
  const tier = (d.tier || "Associate Member").trim();
  // Only tell admins when we know WHO set out to join — an alert naming nobody
  // can't be followed up on, so it would just be noise in the feed.
  if (!email && !name) return { ok: true, recorded: false };
  notify("membership_handoff", ["admins"],
    "Founder started joining TiE: " + (name || email),
    (name || email) + " opened the TiE Bangalore membership form to join as " + tier +
    ". They're recognised as a member as soon as they finish; the app re-checks when they " +
    "come back, so follow up if it never appears.", "normal");
  return { ok: true, recorded: true };
}

async function membership_recheck(d) {
  // After the founder says they've joined, ask Zoho again and cache the answer.
  // Zoho stays the source of truth; the app never marks anyone a member itself.
  const founder_id = d.founder_id;
  if (!founder_id) {
    return { error: "Please sign in first so we know whose membership to check.", status: 400 };
  }
  const row = await refresh_membership(founder_id);
  if (!row) return { error: "We couldn't find your account.", status: 404 };
  const pub = _public_founder(row) || {};
  if (pub.is_member) {
    notify("membership_confirmed", [pub.email || ""],
      "Your TiE Bangalore membership is confirmed",
      "Thanks " + (pub.name || "") + " — we've confirmed your TiE Bangalore " +
      "membership with our records. Your VentureReady expert review is now included.",
      "normal");
    notify("membership_confirmed_admin", ["admins"],
      "New TiE member confirmed: " + (pub.name || pub.email || ""),
      (pub.name || pub.email || "A founder") +
      " completed TiE Bangalore membership and it is now confirmed in Zoho.", "normal");
  }
  return { founder: pub };
}

// ---- Meeting requests (TiE-facilitated introductions) ----------------------
function meeting_request(d) {
  // An investor asks TiE to introduce them to a founder. TiE facilitates every
  // intro, so this notifies the admins — never the founder directly.
  const founder_id = d.founder_id;
  const investor_email = (d.investor_email || "").trim().toLowerCase();
  let investor_name = (d.investor_name || "").trim();
  const fb = founder_id ? _founder_brief(founder_id) : {};
  const founder_name = (d.founder_name || fb.name || "").trim();
  const startup = (d.startup || fb.company || "").trim();
  if (!founder_name && !startup) {
    return { error: "We need to know which founder you'd like to meet.", status: 400 };
  }
  let investor_id = null;
  if (investor_email) {
    const inv = db.prepare("SELECT * FROM investor WHERE email=?").get(investor_email);
    if (inv) {
      investor_id = inv.id;
      investor_name = investor_name || (inv.name || "");
    }
  }
  const cur = db.prepare(
    "INSERT INTO meeting(founder_id, founder_name, startup, investor_id, investor_name, " +
    "investor_email, status, requested_at) VALUES(?,?,?,?,?,?, 'requested', datetime('now'))"
  ).run(founder_id, founder_name, startup, investor_id, investor_name, investor_email);
  const row = db.prepare("SELECT * FROM meeting WHERE id=?").get(cur.lastInsertRowid);
  notify("meeting_requested", ["admins"],
    "Meeting request: " + (investor_name || investor_email || "An investor") + " → " +
    (startup || founder_name),
    (investor_name || investor_email || "An investor") + " has requested a TiE-facilitated " +
    "introduction to " + (founder_name || "a founder") +
    (startup ? " (" + startup + ")" : "") + ". Approve and send the intro from the " +
    "Team Portal.", "normal");
  return { meeting: row };
}

async function meeting_list(idToken) {
  const g = await require_admin(idToken);
  if (g.error) return g;
  return { meetings: db.prepare("SELECT * FROM meeting ORDER BY id DESC").all() };
}

async function meeting_intro_sent(idToken, meeting_id) {
  // Admin confirms the introduction has been made: both sides are told.
  const g = await require_admin(idToken);
  if (g.error) return g;
  const row = db.prepare("SELECT * FROM meeting WHERE id=?").get(meeting_id);
  if (!row) return { error: "Unknown meeting request.", status: 404 };
  db.prepare("UPDATE meeting SET status='intro_sent', intro_sent_at=datetime('now') WHERE id=?")
    .run(meeting_id);
  const fb = row.founder_id ? _founder_brief(row.founder_id) : {};
  const founder_email = fb.email || "";
  const startup = row.startup || fb.company || "";
  const inv_who = row.investor_name || row.investor_email || "an investor";
  if (founder_email) {
    notify("meeting_intro_sent_founder", [founder_email],
      "An investor introduction has been made",
      "TiE Bangalore has introduced you to " + inv_who +
      ", who asked to meet after seeing your VentureReady profile. Look out for the " +
      "introduction email and reply directly to arrange a time.", "normal");
  }
  if (row.investor_email) {
    notify("meeting_intro_sent_investor", [row.investor_email],
      "Your introduction has been made",
      "TiE Bangalore has introduced you to " + (row.founder_name || "the founder") +
      (startup ? " (" + startup + ")" : "") +
      ". You can now correspond directly to arrange a meeting.", "normal");
  }
  notify("meeting_intro_sent_admin", ["admins"],
    "Intro sent: " + inv_who + " → " + (startup || row.founder_name || "founder"),
    g.email + " marked the introduction between " + inv_who + " and " +
    (row.founder_name || "the founder") + " as sent.", "normal");
  const listed = await meeting_list(idToken);
  return { ok: true, meetings: listed.meetings || [] };
}

// ---- Deals & impact (attributable investment tracking) --------------------
// The funnel a founder<->investor relationship walks. 'passed' is a dead end
// (deal died); the rest are forward progress ending in 'closed' (an investment).
const DEAL_STAGES = ["introduced", "met", "diligence", "term_sheet", "closed", "passed"];
// Progress order for "reached at least X" counting (excludes the dead-end).
const DEAL_PROGRESS = ["introduced", "met", "diligence", "term_sheet", "closed"];

function _deal_confidence(fc, ic, tv) {
  if (tv) return "tie_verified";
  if (fc && ic) return "both_confirmed";
  if (fc || ic) return "one_confirmed";
  return "unconfirmed";
}

function _deal_row(r) {
  if (!r) return null;
  const fc = !!r.founder_confirmed, ic = !!r.investor_confirmed, tv = !!r.tie_verified;
  return {
    id: r.id, founder_id: r.founder_id, founder_name: r.founder_name || "",
    startup: r.startup || "", investor_id: r.investor_id,
    investor_name: r.investor_name || "", investor_email: r.investor_email || "",
    firm: r.firm || "", stage: r.stage || "introduced",
    amount_inr: r.amount_inr, amount_disclosed: !!r.amount_disclosed,
    founder_consent_public: !!r.founder_consent_public,
    investor_consent_public: !!r.investor_consent_public,
    founder_confirmed: fc, investor_confirmed: ic, tie_verified: tv,
    confidence: _deal_confidence(fc, ic, tv),
    created_at: r.created_at || "", updated_at: r.updated_at || "",
    closed_at: r.closed_at || "", note: r.note || "",
  };
}

function deal_create(d) {
  // Open a deal between a founder and an investor. Reuses an existing OPEN deal
  // for the same pair rather than creating duplicates.
  const founder_id = d.founder_id;
  const fb = founder_id ? _founder_brief(founder_id) : {};
  const founder_name = (d.founder_name || fb.name || "").trim();
  const startup = (d.startup || fb.company || "").trim();
  const investor_email = (d.investor_email || "").trim().toLowerCase();
  let investor_name = (d.investor_name || "").trim();
  let investor_id = d.investor_id, firm = (d.firm || "").trim();
  if (investor_email) {
    const inv = db.prepare("SELECT * FROM investor WHERE email=?").get(investor_email);
    if (inv) { investor_id = inv.id; investor_name = investor_name || (inv.name || ""); firm = firm || (inv.firm || ""); }
  }
  if (!founder_name && !startup) return { error: "A deal needs a founder.", status: 400 };
  if (!investor_email && !investor_name) return { error: "A deal needs an investor.", status: 400 };
  const existing = db.prepare(
    "SELECT * FROM deal WHERE founder_id IS ? AND investor_email=? " +
    "AND stage NOT IN ('closed','passed') ORDER BY id DESC LIMIT 1").get(founder_id, investor_email);
  if (existing) return { deal: _deal_row(existing), reused: true };
  const cur = db.prepare(
    "INSERT INTO deal(founder_id, founder_name, startup, investor_id, investor_name, " +
    "investor_email, firm, stage, source, meeting_id, created_at, updated_at) " +
    "VALUES(?,?,?,?,?,?,?, 'introduced', ?, ?, datetime('now'), datetime('now'))"
  ).run(founder_id, founder_name, startup, investor_id, investor_name, investor_email, firm,
    d.source || "manual", d.meeting_id);
  const row = _deal_row(db.prepare("SELECT * FROM deal WHERE id=?").get(cur.lastInsertRowid));
  notify("deal_created", ["admins"],
    "New deal tracked: " + (investor_name || investor_email || "investor") + " → " +
    (startup || founder_name),
    "A deal between " + (investor_name || investor_email || "an investor") + " and " +
    (startup || founder_name) + " is now being tracked toward outcome.", "normal");
  return { deal: row, reused: false };
}

function deal_advance(d) {
  // Move a deal along, and/or record an amount + public-consent, attributed to
  // whoever acted. When a party changes the stage, the OTHER party's prior
  // confirmation is cleared so they must re-attest the new stage; an admin
  // stage change clears both.
  const deal_id = d.deal_id;
  const actor = (d.actor || "").trim().toLowerCase();
  const cur = db.prepare("SELECT * FROM deal WHERE id=?").get(deal_id);
  if (!cur) return { error: "Unknown deal.", status: 404 };
  const new_stage = (d.stage || cur.stage || "introduced").trim();
  if (!DEAL_STAGES.includes(new_stage)) return { error: "Unknown stage.", status: 400 };
  const stage_changed = new_stage !== (cur.stage || "introduced");
  let fc = cur.founder_confirmed, ic = cur.investor_confirmed, tv = cur.tie_verified;
  let fcp = cur.founder_consent_public, icp = cur.investor_consent_public;
  const consent = d.consent_public;
  if (actor === "founder") { fc = 1; if (consent !== undefined && consent !== null) fcp = consent ? 1 : 0; }
  else if (actor === "investor") { ic = 1; if (consent !== undefined && consent !== null) icp = consent ? 1 : 0; }
  if (stage_changed) {
    if (actor === "founder") { ic = 0; tv = 0; }
    else if (actor === "investor") { fc = 0; tv = 0; }
    else { fc = 0; ic = 0; }
  }
  let amount_inr = cur.amount_inr, amount_disclosed = cur.amount_disclosed;
  if (d.amount_inr !== undefined && d.amount_inr !== null && d.amount_inr !== "") {
    const n = Number(d.amount_inr);
    if (!Number.isInteger(n)) return { error: "Amount must be a whole number of rupees.", status: 400 };
    amount_inr = n; amount_disclosed = 1;
  }
  db.prepare(
    "UPDATE deal SET stage=?, amount_inr=?, amount_disclosed=?, founder_consent_public=?, " +
    "investor_consent_public=?, founder_confirmed=?, investor_confirmed=?, tie_verified=?, " +
    "note=COALESCE(?, note), updated_at=datetime('now'), " +
    "closed_at=CASE WHEN ?='closed' AND closed_at IS NULL THEN datetime('now') ELSE closed_at END " +
    "WHERE id=?"
  ).run(new_stage, amount_inr, amount_disclosed, fcp, icp, fc, ic, tv,
    (d.note === undefined ? null : d.note), new_stage, deal_id);
  const fresh = _deal_row(db.prepare("SELECT * FROM deal WHERE id=?").get(deal_id));
  const label = (fresh.startup || fresh.founder_name) + " ↔ " + (fresh.investor_name || fresh.investor_email || "investor");
  if (new_stage === "closed") {
    notify("deal_closed", ["admins"], "Deal closed: " + label,
      "A deal has been marked closed: " + label +
      (fresh.amount_disclosed && fresh.amount_inr ? ". Amount: ₹" + fresh.amount_inr : ". Amount undisclosed.") +
      " Confidence: " + fresh.confidence + ".", "high");
  } else if (stage_changed) {
    if (actor === "founder" && fresh.investor_email) {
      notify("deal_update_confirm", [fresh.investor_email], "Please confirm a deal update",
        "The status of your deal (" + label + ") was updated to '" + new_stage.replace("_", " ") +
        "'. Please confirm it so TiE's records stay accurate.", "normal");
    } else if (actor === "investor" && fresh.founder_id) {
      const fb2 = _founder_brief(fresh.founder_id);
      if (fb2.email) {
        notify("deal_update_confirm", [fb2.email], "Please confirm a deal update",
          "The status of your deal (" + label + ") was updated to '" + new_stage.replace("_", " ") +
          "'. Please confirm it so TiE's records stay accurate.", "normal");
      }
    }
  }
  return { deal: fresh };
}

async function deal_verify(idToken, deal_id, verified) {
  const g = await require_admin(idToken);
  if (g.error) return g;
  const row = db.prepare("SELECT * FROM deal WHERE id=?").get(deal_id);
  if (!row) return { error: "Unknown deal.", status: 404 };
  db.prepare("UPDATE deal SET tie_verified=?, updated_at=datetime('now') WHERE id=?")
    .run(verified ? 1 : 0, deal_id);
  return { deal: _deal_row(db.prepare("SELECT * FROM deal WHERE id=?").get(deal_id)) };
}

function deals_for(founder_id, investor_email) {
  let rows = [];
  if (founder_id) rows = db.prepare("SELECT * FROM deal WHERE founder_id=? ORDER BY id DESC").all(founder_id);
  else if (investor_email) rows = db.prepare("SELECT * FROM deal WHERE investor_email=? ORDER BY id DESC")
    .all((investor_email || "").trim().toLowerCase());
  return rows.map(_deal_row);
}

async function deals_admin(idToken) {
  const g = await require_admin(idToken);
  if (g.error) return g;
  const rows = db.prepare("SELECT * FROM deal ORDER BY id DESC").all().map(_deal_row);
  const by_stage = {}; DEAL_STAGES.forEach((s) => { by_stage[s] = 0; });
  const conf = { tie_verified: 0, both_confirmed: 0, one_confirmed: 0, unconfirmed: 0 };
  let capital_disclosed = 0, undisclosed_closed = 0;
  const closed = rows.filter((r) => r.stage === "closed");
  rows.forEach((r) => { by_stage[r.stage] = (by_stage[r.stage] || 0) + 1; });
  closed.forEach((r) => {
    conf[r.confidence] = (conf[r.confidence] || 0) + 1;
    if (r.amount_disclosed && r.amount_inr) capital_disclosed += r.amount_inr;
    else undisclosed_closed += 1;
  });
  const stats = {
    total: rows.length, by_stage: by_stage, closed: closed.length,
    capital_disclosed_inr: capital_disclosed, undisclosed_closed: undisclosed_closed,
    confidence: conf,
    founders: new Set(rows.filter((r) => r.founder_id).map((r) => r.founder_id)).size,
    investors: new Set(rows.filter((r) => r.investor_email).map((r) => r.investor_email)).size,
  };
  return { deals: rows, stats: stats };
}

function impact_public() {
  // PUBLIC, showcase-safe aggregates ONLY. No names, no individual amounts.
  // The ₹ headline counts a closed deal ONLY when an amount was disclosed AND
  // both parties consented to public inclusion — everything else is a count.
  const rows = db.prepare("SELECT * FROM deal").all().map(_deal_row);
  const reached = (stageName) => {
    const idx = DEAL_PROGRESS.indexOf(stageName);
    return rows.filter((r) => DEAL_PROGRESS.includes(r.stage) && DEAL_PROGRESS.indexOf(r.stage) >= idx).length;
  };
  const closed = rows.filter((r) => r.stage === "closed");
  let capital_public = 0, public_closings = 0;
  closed.forEach((r) => {
    if (r.amount_disclosed && r.amount_inr && r.founder_consent_public && r.investor_consent_public) {
      capital_public += r.amount_inr; public_closings += 1;
    }
  });
  return {
    introductions: rows.length, meetings: reached("met"),
    in_diligence_plus: reached("diligence"), closed: closed.length,
    startups_backed: new Set(closed.filter((r) => r.founder_id).map((r) => r.founder_id)).size,
    investors_active: new Set(rows.filter((r) => r.investor_email && r.stage !== "introduced")
      .map((r) => r.investor_email)).size,
    capital_enabled_inr: capital_public, capital_from_deals: public_closings,
    closings_amount_undisclosed: closed.length - public_closings,
  };
}

const CHAPTER = "TiE Bangalore";

// ---- Zoho token cache (token lives 1 hour) ----
const _token = { value: null, expires: 0 };

async function zoho_token() {
  if (_token.value && Date.now() / 1000 < _token.expires - 60) {
    return _token.value;
  }
  const q = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: ZOHO_CLIENT_ID,
    client_secret: ZOHO_CLIENT_SECRET,
    scope: "ZohoCreator.report.READ",
  });
  const resp = await fetch("https://accounts.zoho.com/oauth/v2/token?" + q.toString(), { method: "POST" });
  const d = await resp.json();
  _token.value = d.access_token;
  _token.expires = Date.now() / 1000 + parseInt(d.expires_in || 3600, 10);
  return _token.value;
}

async function verify_member(email) {
  // Ask Zoho whether this email is a current TiE Bangalore member.
  //
  // Returns one of three shapes:
  //   - Found & answered:   {member: bool, name, status, category}
  //   - Reached, no record: {member: false, reason: "not found", status: ""}
  //   - COULD NOT REACH:    {member: false, unreachable: true, reason: ...}
  //
  // The `unreachable` flag lets callers tell "Zoho says not a member" apart from
  // "we couldn't check right now", so we keep the last CONFIRMED status instead
  // of wrongly wiping someone's membership on a Zoho outage.
  email = (email || "").trim();
  if (!email) return { member: false, reason: "no email" };
  const params = new URLSearchParams({
    field_config: "custom",
    fields: "Email1,Name1,Status,Chapter_Name,Membership_Category1,Mobile",
    Original_Email: email,
    Chapter_Name: CHAPTER,
  });
  const url = "https://creator.zoho.com/api/v2.1/tie_dev/chapters/report/Member_Details_Admin_View?" + params.toString();
  try {
    // zoho_token() can itself fail if Zoho's auth server is down — keep it inside
    // the try so an auth outage counts as "unreachable", not "not found".
    const resp = await fetch(url, { headers: { Authorization: "Zoho-oauthtoken " + (await zoho_token()) } });
    if (!resp.ok) {
      // 5xx = Zoho itself is having trouble → treat as unreachable (keep last known).
      // 4xx (incl. code 9220 = no matching record) = a real answer: not a member.
      if (resp.status >= 500) {
        return { member: false, unreachable: true, reason: "zoho error " + resp.status };
      }
      return { member: false, reason: "not found", status: "" };
    }
    const d = await resp.json();
    const rec = (d.data || [{}])[0] || {};
    const status = rec.Status || "";
    return {
      member: status === "Active",
      name: (rec.Name1 || {}).zc_display_value || "",
      status: status,
      category: (rec.Membership_Category1 || {}).zc_display_value || "",
    };
  } catch (e) {
    // Network timeout, DNS failure, auth failure, bad JSON — we couldn't get a
    // trustworthy answer, so don't overwrite what we already know.
    return { member: false, unreachable: true, reason: String(e) };
  }
}

async function refresh_membership(founder_id) {
  // Re-check a founder's TiE membership with Zoho and cache the answer.
  //
  // Called at every sign-in (login and signup). Zoho stays the source of truth;
  // the founder row just caches the latest answer so the profile shows it.
  //
  // If Zoho can't be reached we KEEP the last confirmed values and only flip
  // membership_stale=1, so the UI can say "showing last confirmed status". A
  // successful check clears the stale flag. Returns the fresh founder row.
  const row = db.prepare("SELECT * FROM founder WHERE id=?").get(founder_id);
  if (!row) return null;
  const res = await verify_member(row.email);
  if (res.unreachable) {
    // Couldn't reach Zoho — leave the cached snapshot untouched, just flag it stale.
    db.prepare("UPDATE founder SET membership_stale=1 WHERE id=?").run(founder_id);
  } else {
    db.prepare(
      "UPDATE founder SET is_member=?, membership_status=?, membership_category=?, " +
      "membership_name=?, membership_checked_at=datetime('now'), membership_stale=0 " +
      "WHERE id=?").run(
      res.member ? 1 : 0, res.status || "", res.category || "", res.name || "", founder_id);
  }
  return db.prepare("SELECT * FROM founder WHERE id=?").get(founder_id);
}

// ---- "Continue with Google" sign-in ----
// Google proves IDENTITY (who the person is). It does NOT prove TiE membership —
// that's still Zoho's job, run right after via refresh_membership(). The two gates
// stay separate: identity first, membership second.
async function verify_google_token(idToken) {
  // Verify the signed ID token the browser got from Google. We ask Google's own
  // tokeninfo endpoint to validate it (so we're not hand-rolling JWT crypto), then
  // we still check the audience/issuer/verified-email ourselves — never trust a
  // token that wasn't minted for THIS app.
  //
  // NOTE FOR PRODUCTION: for higher volume, verify the token locally against
  // Google's public keys using a vetted library (e.g. google-auth-library) instead
  // of the tokeninfo endpoint. Behaviour is identical; this is simpler for a pilot.
  if (!GOOGLE_CLIENT_ID) return { error: "Google sign-in is not configured on this server." };
  if (!idToken) return { error: "No Google credential was provided." };
  let d;
  try {
    const resp = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken));
    if (!resp.ok) return { error: "Google could not verify that sign-in. Please try again." };
    d = await resp.json();
  } catch (e) {
    return { error: "Couldn’t reach Google to verify the sign-in. Please try again." };
  }
  // aud must be OUR client ID — this stops a token issued for another app being replayed here.
  if (d.aud !== GOOGLE_CLIENT_ID) return { error: "That sign-in was not issued for this app." };
  // iss must be Google.
  if (d.iss !== "accounts.google.com" && d.iss !== "https://accounts.google.com") {
    return { error: "That sign-in did not come from Google." };
  }
  // Token must not be expired.
  if (d.exp && (Date.now() / 1000) > parseInt(d.exp, 10)) {
    return { error: "That Google sign-in has expired. Please try again." };
  }
  // Only accept a verified email — we key TiE membership off the email address.
  if (String(d.email_verified) !== "true" || !d.email) {
    return { error: "Your Google email isn’t verified, so we can’t use it to sign in." };
  }
  return { sub: d.sub, email: (d.email || "").trim().toLowerCase(), name: d.name || "" };
}

function founder_google_upsert(sub, email, name) {
  // Find the founder by Google ID first, then by email, else create a new record.
  // Google accounts have no password — that's fine; password columns stay null.
  email = (email || "").trim().toLowerCase();
  let row = db.prepare("SELECT * FROM founder WHERE google_sub=?").get(sub);
  if (!row && email) {
    row = db.prepare("SELECT * FROM founder WHERE email=?").get(email);
  }
  let fid;
  let is_new = false;
  if (row) {
    // Attach the Google ID (and fill a blank name) without disturbing anything else.
    db.prepare("UPDATE founder SET google_sub=?, name=COALESCE(NULLIF(name,''), ?) WHERE id=?")
      .run(sub, name || "", row.id);
    fid = row.id;
  } else {
    const cur = db.prepare(
      "INSERT INTO founder(name,email,google_sub,created_at) VALUES(?,?,?,datetime('now'))")
      .run(name || "New Founder", email, sub);
    fid = Number(cur.lastInsertRowid);
    is_new = true;
  }
  if (is_new && email) {
    notify("founder_welcome", [email],
      "Welcome to VentureReady",
      "Thanks for joining VentureReady, " + (name || "founder") +
      ". You can now run the free positioning diagnostic and submit your deck for expert review.",
      "normal");
  }
  return fid;
}

async function founder_google_login(idToken) {
  // Full flow: verify identity with Google → find/create the founder → re-check
  // TiE membership with Zoho → return the public profile.
  const v = await verify_google_token(idToken);
  if (v.error) return { error: v.error };
  const fid = founder_google_upsert(v.sub, v.email, v.name);
  const refreshed = await refresh_membership(fid);
  const row = refreshed || db.prepare("SELECT * FROM founder WHERE id=?").get(fid);
  // Decide the role from the admin allow-list. Everyone else is a "founder".
  const role = admin_role_for(v.email) || "founder";
  return { founder: public_founder(row), role: role };
}

// ---- Deck text extraction (reads the founder's actual uploaded deck) ----
// How many slide pictures we'll send the AI, and how big each may be.
// Vision costs more than text, so this path is a FALLBACK for image-only decks
// and is capped to keep a runaway deck from burning the budget.
const MAX_DECK_IMAGES = 20;
const MAX_IMAGE_PX = 1400;

async function shrink_to_jpeg(data, max_px = MAX_IMAGE_PX) {
  // Normalise any embedded picture to a modest JPEG the API will accept.
  // Lazy-require sharp so the app still runs if the optional dep isn't installed.
  const sharp = require("sharp");
  return await sharp(data)
    .resize({ width: max_px, height: max_px, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
}

async function extract_deck_images(filename, raw, max_images = MAX_DECK_IMAGES) {
  // For image-only decks: pull the picture of each slide so the AI can LOOK at it.
  // Takes the largest image per page/slide (that's the slide render), shrinks it,
  // and returns base64 JPEGs ready for the API. Empty list if nothing usable.
  const name = (filename || "").toLowerCase();
  let pics = [];
  try {
    if (name.endsWith(".pptx")) {
      // A .pptx is a ZIP; slide pictures live under ppt/media/. Group media by the
      // slide that references it, then take the largest image per slide.
      const AdmZip = require("adm-zip");
      const zip = new AdmZip(raw);
      const entries = zip.getEntries();
      const media = {};
      for (const e of entries) {
        if (/^ppt\/media\/.*\.(png|jpe?g|gif|bmp)$/i.test(e.entryName)) {
          media[path.basename(e.entryName)] = e.getData();
        }
      }
      // Order slides by their numeric index so the AI sees them in deck order.
      const slideEntries = entries
        .filter((e) => /^ppt\/slides\/slide\d+\.xml$/i.test(e.entryName))
        .sort((a, b) => {
          const na = parseInt(a.entryName.match(/slide(\d+)\.xml/i)[1], 10);
          const nb = parseInt(b.entryName.match(/slide(\d+)\.xml/i)[1], 10);
          return na - nb;
        });
      for (const se of slideEntries) {
        if (pics.length >= max_images) break;
        const rels = zip.getEntry(`ppt/slides/_rels/${path.basename(se.entryName)}.rels`);
        const blobs = [];
        if (rels) {
          const relXml = rels.getData().toString("utf-8");
          const targets = [...relXml.matchAll(/Target="([^"]*media\/[^"]+)"/g)].map((m) => path.basename(m[1]));
          for (const t of targets) {
            if (media[t]) blobs.push(media[t]);
          }
        }
        if (blobs.length) {
          blobs.sort((a, b) => b.length - a.length);
          pics.push(blobs[0]);
        }
      }
    }
    // NOTE: image-only *PDF* extraction (pypdf page.images in the Python app) needs a
    // native PDF library. Text-based PDFs are handled by extract_deck_text below; if a
    // PDF has no text AND no extractable images here, the app falls back to the same
    // "please re-export" message the Python app shows. A developer can wire pdfjs-dist
    // here later to fully match the Python image path for scanned/image-only PDFs.
  } catch (e) {
    console.log("deck image extraction failed:", e.message);
    return [];
  }

  const out = [];
  for (const data of pics) {
    try {
      const jpeg = await shrink_to_jpeg(data);
      out.push({ media_type: "image/jpeg", b64: jpeg.toString("base64") });
    } catch (e) {
      console.log("image convert skipped:", e.message);
    }
  }
  return out;
}

async function extract_deck_text(filename, raw) {
  // Pull plain text out of an uploaded PDF or PPTX so the AI reads the real deck.
  const name = (filename || "").toLowerCase();
  try {
    if (name.endsWith(".pdf")) {
      const pdfParse = require("pdf-parse");
      const data = await pdfParse(raw);
      return (data.text || "").trim();
    }
    if (name.endsWith(".pptx") || name.endsWith(".ppt")) {
      const AdmZip = require("adm-zip");
      const zip = new AdmZip(raw);
      const slideEntries = zip.getEntries()
        .filter((e) => /^ppt\/slides\/slide\d+\.xml$/i.test(e.entryName))
        .sort((a, b) => {
          const na = parseInt(a.entryName.match(/slide(\d+)\.xml/i)[1], 10);
          const nb = parseInt(b.entryName.match(/slide(\d+)\.xml/i)[1], 10);
          return na - nb;
        });
      const out = [];
      for (const se of slideEntries) {
        const xml = se.getData().toString("utf-8");
        // Concatenate the text inside every <a:t>…</a:t> run, like python-pptx does.
        const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXml(m[1]));
        out.push(texts.join(""));
      }
      return out.join("\n").trim();
    }
  } catch (e) {
    console.log("deck extraction failed:", e.message);
    return "";
  }
  // Unknown type: try decoding as plain text.
  try {
    return raw.toString("utf-8").trim();
  } catch (e) {
    return "";
  }
}

function decodeXml(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// ---- AI diagnostic ----
const ANTI_PATTERNS =
  "TAM inflation, vague ICP with no firmographic qualifier, no buyer trigger event, missing 'why now', " +
  "feature-parity-as-moat, vanity metrics, wishful GTM, solution looking for a problem, internal " +
  "contradictions, projection overconfidence, regulatory blindspots, and US-playbook assumptions in the Indian market";

// ---- Model auto-discovery ----
// Nobody has to know or maintain the AI model name. The app asks Anthropic which
// models the account can use and picks the strongest one, preferring Sonnet, then
// Opus. A manual override (ANTHROPIC_MODEL in .env) wins if ever needed.
const _model_cache = { value: null };

async function get_model() {
  if (_model_cache.value) return _model_cache.value;
  const override = (ENV.ANTHROPIC_MODEL || "").trim();
  if (override) {
    _model_cache.value = override;
    return override;
  }
  const fallback = "claude-sonnet-4-5"; // safe default if discovery ever fails
  try {
    const resp = await fetch("https://api.anthropic.com/v1/models?limit=100", {
      method: "GET",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    });
    const data = (await resp.json()).data || [];
    const ids = data.filter((m) => m.id).map((m) => m.id);
    // API returns newest first; keep that order and prefer Sonnet (best value for
    // this diagnostic), then fall back to Opus, then whatever's newest.
    const chosen = ids.find((i) => i.includes("sonnet")) ||
      ids.find((i) => i.includes("opus")) ||
      (ids.length ? ids[0] : fallback);
    _model_cache.value = chosen;
    console.log("AI model auto-selected:", chosen);
    return chosen;
  } catch (e) {
    console.log(`model discovery failed (${e.message}) — using fallback ${fallback}`);
    _model_cache.value = fallback;
    return fallback;
  }
}

// How much deck text we send to the AI. ~25k characters covers virtually every real
// pitch deck (appendix and all) while capping cost on a runaway file. Anything longer
// is flagged to the founder rather than silently dropped.
const DECK_CHAR_LIMIT = 25000;

async function ai_diagnostic(deck_text, icp = "", pitch = "", images = null) {
  if (!ANTHROPIC_API_KEY) {
    // No key yet -> realistic canned result so the demo flows.
    return {
      live: false,
      summary: "Sample result — your real AI key isn't set yet, so this shows the kind of read the engine produces. Add the key and it runs live on the uploaded deck.",
      findings: [
        { dim: "Positioning Clarity", note: "Opening leads with the product, not the customer problem — the 'why now' is missing.", fixes: [
          "Open on the customer's painful trigger, then position your product as the answer.",
          "Add a 'why now' — the market, tech or regulatory shift that makes this the moment.",
          "Cut feature language from the first slide; lead with the outcome the buyer gets."] },
        { dim: "ICP Specificity", note: "Target is described as 'SMEs' with no firmographic or trigger-event qualifier.", fixes: [
          "Name the company size and the buyer's exact role (e.g. 'VP Sales at a 50–200-person SaaS').",
          "State the trigger event that makes them ready to buy right now.",
          "Name two or three real example companies that fit the profile."] },
        { dim: "Messaging Hierarchy", note: "The edge is framed as 'faster and cheaper' — a feature claim, buried among equally-weighted points.", fixes: [
          "Lead with the single message that matters most and make everything else support it.",
          "Replace 'faster and cheaper' with a structural advantage a rival can't copy by trying harder.",
          "Back the hero claim with one concrete proof point, not three vague ones."] },
        { dim: "GTM Sequencing", note: "Acquisition relies on 'word of mouth and partnerships'; there's no first-10-customers plan.", fixes: [
          "Spell out exactly how the first ten customers get reached and closed.",
          "State your motion (self-serve, inside sales, or founder-led) and the CAC you expect.",
          "Sequence the channels — which one you prove first before layering the next."] },
      ],
    };
  }
  let context = "";
  if (icp || pitch) {
    context = (
      "\n\nThe founder also gave two quick inputs at the free step:\n" +
      "WHO IT'S FOR (their stated ICP): " + (icp || "(not given)") + "\n" +
      "ONE-LINE PITCH: " + (pitch || "(not given)") + "\n" +
      "Use these to judge whether the deck actually delivers on what they claim."
    );
  }
  const prompt = (
    "You are a senior TiE Bangalore investment reviewer running a FREE positioning diagnostic. " +
    "This free read sits IN FRONT OF a paid expert review, so it must be genuinely useful but must NOT do the " +
    "founder's rewriting for them — its job is to make them see WHAT is weak and WHICH DIRECTION to move, while " +
    "leaving the actual rework, prioritisation and judgement to the paid expert. " +
    "This is AI pattern analysis, NOT a statistical benchmark. Read the founder's pitch deck text below and " +
    "identify the most important issue under each of the four positioning dimensions: Positioning Clarity, ICP Specificity, " +
    "Messaging Hierarchy, and GTM Sequencing. " +
    "For each dimension, the 'note' should be one sharp sentence naming the problem AND why it costs them with investors. " +
    "Then give two or three DIRECTIONAL pointers in 'fixes' — short nudges that name the type of fix and why it matters, " +
    "phrased as 'rethink / sharpen / pick / separate' guidance. " +
    "CRITICAL — do NOT do the work for them: do NOT write the replacement headline or any ready-to-paste copy, " +
    "do NOT compute or restate the corrected number, do NOT enumerate the specific certifications, regulations or named " +
    "example customers, and do NOT hand over a finished slide. Point the direction only (e.g. 'Pick one beachhead " +
    "application and lead the deck with it' — NOT the exact new headline; 'Your cost-reduction claim is mathematically " +
    "impossible as stated — restate it as a real from/to figure' — NOT the corrected figure itself). " +
    "Watch for these known anti-patterns: " + ANTI_PATTERNS + ". " +
    "End 'summary' with one sentence noting that a TiE expert reviewer would help them prioritise which of these fixes " +
    "matters most for their specific raise and rework it for the investors they're about to meet. " +
    "Respond ONLY as JSON: {\"summary\": str, \"findings\": [{\"dim\": str, \"note\": str, \"fixes\": [str, str, ...]}, ...]}." +
    context + "\n\n" +
    (images ? "The deck is image-based, so its slides are attached as pictures above rather than as text. " +
      "Read the slides directly — including any charts, tables and infographics — and diagnose from what you see."
      : "DECK TEXT:\n" + deck_text.slice(0, DECK_CHAR_LIMIT))
  );
  // Image-only decks: send the slide pictures and let the model read them.
  // Beats OCR — it understands layout, charts and infographics, not just glyphs.
  let content;
  if (images) {
    content = images.map((im) => ({
      type: "image",
      source: { type: "base64", media_type: im.media_type, data: im.b64 },
    }));
    content.push({ type: "text", text: prompt });
  } else {
    content = prompt;
  }
  const body = JSON.stringify({
    model: await get_model(),
    // Enough room for a full four-dimension read on a rich, multi-slide deck.
    // Too small and the reply gets cut off mid-JSON and can't be parsed.
    max_tokens: 4096,
    messages: [{ role: "user", content: content }],
  });
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: body,
  });
  const d = await resp.json();
  // Read every text block (newer models can prepend non-text blocks); don't assume
  // the first block is the text.
  const text = (d.content || [])
    .filter((b) => b && typeof b === "object" && b.type === "text")
    .map((b) => b.text || "").join("");
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    // The model's reply wasn't clean JSON (e.g. truncated or wrapped in prose).
    // Fail gracefully with a readable message instead of crashing the request.
    console.log(`AI JSON parse failed (${e.message}); stop_reason=${d.stop_reason}`);
    return {
      live: true,
      partial: true,
      summary: (
        "The AI read your deck but its detailed reply didn't come back in a " +
        "form we could lay out cleanly this time. Please run the diagnostic " +
        "again — it usually succeeds on a retry."
      ),
      findings: [],
    };
  }
  parsed.live = true;
  return parsed;
}

// ---- HTTP helpers ----
function sendJson(res, code, obj) {
  const payload = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": payload.length });
  res.end(payload);
}

function b64ToBuffer(b64) {
  // Accept "data:...;base64,XXXX" or a bare base64 string, like Python's split(",")[-1].
  const parts = String(b64).split(",");
  return Buffer.from(parts[parts.length - 1], "base64");
}

async function handleGet(req, res, urlObj) {
  const rawPath = urlObj.pathname;
  const p = (rawPath === "/" || rawPath === "") ? "/index.html" : rawPath;
  if (p === "/api/config") {
    // Public front-end config. Only non-secret values belong here. The Google
    // Client ID is designed to be public; the browser needs it to show the button.
    return sendJson(res, 200, { googleClientId: GOOGLE_CLIENT_ID,
      membershipUrl: TIE_MEMBERSHIP_URL });
  }
  if (p === "/api/support") return sendJson(res, 200, support_list());
  if (p === "/api/review") {
    const fid = urlObj.searchParams.get("founder_id") || "";
    return sendJson(res, 200, fid ? review_state(fid) : { rounds: [], latest: null });
  }
  if (p === "/api/dataroom") {
    const fid = urlObj.searchParams.get("founder_id") || "";
    return sendJson(res, 200, fid ? dataroom_list(fid) : { docs: [], views: [] });
  }
  if (p === "/api/founder") {
    const fid = urlObj.searchParams.get("id") || "";
    const rec = fid ? founder_get(fid) : null;
    return sendJson(res, 200, rec || { error: "not found" });
  }
  if (p === "/api/deals") {
    const fid = urlObj.searchParams.get("founder_id") || "";
    const iem = urlObj.searchParams.get("investor_email") || "";
    return sendJson(res, 200, { deals: deals_for(fid || null, iem || null) });
  }
  if (p === "/api/impact") {
    return sendJson(res, 200, impact_public());
  }
  const fp = path.join(HERE, p.replace(/^\/+/, ""));
  if (fs.existsSync(fp) && fs.statSync(fp).isFile() && path.resolve(fp).startsWith(HERE)) {
    const ctype = fp.endsWith(".html") ? "text/html" : "application/octet-stream";
    const data = fs.readFileSync(fp);
    res.writeHead(200, { "Content-Type": ctype, "Content-Length": data.length });
    res.end(data);
  } else {
    sendJson(res, 404, { error: "not found" });
  }
}

async function handlePost(req, res, urlObj, data) {
  const p = urlObj.pathname;
  if (p === "/api/verify-member") {
    const vm = await verify_member(data.email || "");
    // A definitive "not a member" (Zoho reached, no active record) is a gate
    // failure worth flagging to admins. "unreachable" is NOT a failure — we just
    // couldn't check — so it does not notify.
    if (data.email && !vm.member && !vm.unreachable) {
      notify("membership_failed", ["admins"],
        "Membership check failed at the gate",
        "A sign-in was blocked: " + (data.email || "") +
        " was not found as an active TiE Bangalore member in Zoho.", "high");
    }
    return sendJson(res, 200, vm);
  } else if (p === "/api/founder") {
    return sendJson(res, 200, founder_upsert(data));
  } else if (p === "/api/signup") {
    const out = await founder_signup(data);
    return sendJson(res, out.error ? 400 : 200, out);
  } else if (p === "/api/login") {
    const out = await founder_login(data.email || "", data.password || "");
    return sendJson(res, out.error ? 401 : 200, out);
  } else if (p === "/api/auth/google") {
    // "Continue with Google": verify the Google credential, find/create the
    // founder, refresh their TiE membership, and return the profile.
    const out = await founder_google_login(data.credential || "");
    return sendJson(res, out.error ? 401 : 200, out);
  } else if (p === "/api/admin/list") {
    // Super-admin only: read the admin allow-list.
    const g = await require_super_admin(data.credential || "");
    if (g.error) return sendJson(res, g.status, { error: g.error });
    return sendJson(res, 200, { admins: admin_list() });
  } else if (p === "/api/admin/add") {
    // Super-admin only: add an approved admin email.
    const g = await require_super_admin(data.credential || "");
    if (g.error) return sendJson(res, g.status, { error: g.error });
    const email = (data.email || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return sendJson(res, 400, { error: "Please enter a valid email address." });
    }
    db.prepare("INSERT OR IGNORE INTO admin_allowlist(email, added_by, added_at) VALUES(?,?,datetime('now'))")
      .run(email, g.email);
    notify("admin_added", [email, ...Array.from(ADMIN_SUPER_EMAILS).sort()],
      "You have been added as a VentureReady admin",
      g.email + " added " + email + " to the VentureReady Team Portal admin allow-list.", "normal");
    return sendJson(res, 200, { admins: admin_list() });
  } else if (p === "/api/admin/remove") {
    // Super-admin only: remove an admin email (a super-admin can't be removed).
    const g = await require_super_admin(data.credential || "");
    if (g.error) return sendJson(res, g.status, { error: g.error });
    const email = (data.email || "").trim().toLowerCase();
    if (is_super_admin(email)) {
      return sendJson(res, 400, { error: "A super-admin can’t be removed." });
    }
    db.prepare("DELETE FROM admin_allowlist WHERE email=?").run(email);
    notify("admin_removed", Array.from(ADMIN_SUPER_EMAILS).sort(),
      "An admin was removed from VentureReady",
      g.email + " removed " + email + " from the VentureReady Team Portal admin allow-list.", "normal");
    return sendJson(res, 200, { admins: admin_list() });
  } else if (p === "/api/admin/notifications") {
    // Any admin: view the recorded notifications feed / email outbox.
    const g = await require_admin(data.credential || "");
    if (g.error) return sendJson(res, g.status, { error: g.error });
    return sendJson(res, 200, { notifications: notifications_recent(), mail_enabled: MAIL_ENABLED });
  } else if (p === "/api/review") {
    // A reviewer submits a verdict — this is what the founder then sees.
    const fid = data.founder_id;
    const verdict = data.verdict || "";
    if (!fid || !["not_yet", "awarded"].includes(verdict)) {
      return sendJson(res, 400, { error: "founder_id and verdict ('not_yet'|'awarded') are required" });
    }
    return sendJson(res, 200, review_add(fid, verdict, data.gaps, data.reviewer || "", data.note || ""));
  } else if (p === "/api/dataroom") {
    // Upload one diligence document against a checklist item.
    const fid = data.founder_id;
    const key = data.item_key || "";
    const fname = data.filename || "";
    const b64 = data.file_b64 || "";
    if (!(fid && key && b64)) {
      return sendJson(res, 400, { error: "founder_id, item_key and file_b64 are required" });
    }
    const raw = b64ToBuffer(b64);
    const did = dataroom_add(fid, key, fname, raw);
    const out = dataroom_list(fid);
    out.doc_id = did;
    return sendJson(res, 200, out);
  } else if (p === "/api/dataroom/view") {
    return sendJson(res, 200, dataroom_view_log(data.founder_id, data.doc_id, data.item_key || "", data.viewer || ""));
  } else if (p === "/api/diagnostic") {
    let deck_text = data.deck_text || "";
    const fileb64 = data.file_b64 || "";
    const fname = data.filename || "";
    const founder_id = data.founder_id;
    const had_file = Boolean(fileb64);
    let deck_id = null;
    let raw = null;
    if (fileb64) {
      raw = b64ToBuffer(fileb64);
      deck_text = await extract_deck_text(fname, raw);
      // Store the actual deck file + a DB row pointing to it.
      deck_id = deck_add(founder_id, fname, raw);
    }
    // No usable text? The deck is probably image-based (each slide is a
    // picture). Before giving up, try to LOOK at the slides instead.
    let deck_images = null;
    if (had_file && (deck_text || "").trim().length < 120) {
      deck_images = await extract_deck_images(fname, raw);
      if (deck_images && deck_images.length) {
        console.log(`image-based deck: reading ${deck_images.length} slide picture(s) with vision`);
      }
    }

    // Only truly unreadable if there's neither text nor a picture to look at.
    if (had_file && (deck_text || "").trim().length < 120 && (!deck_images || !deck_images.length)) {
      return sendJson(res, 200, {
        live: false,
        unreadable: true,
        summary: (
          "We couldn't read “" + (fname || "your file") + ".” There's no text inside it and we " +
          "couldn't pull out readable slide images either. Please export your " +
          "deck as a PDF or PowerPoint and upload it again — or paste your " +
          "pitch below and we'll read that instead."
        ),
        findings: [],
      });
    }
    let result = null;
    // Reuse a prior read for the same founder + identical deck instead of
    // paying the API again (no double-charging for a re-run).
    if (founder_id && had_file) {
      result = diagnostic_find_reusable(founder_id, fname, raw.length);
    }
    if (result === null) {
      result = await ai_diagnostic(deck_text, data.icp || "", data.pitch || "",
        deck_images && deck_images.length ? deck_images : null);
      if (deck_images && deck_images.length) {
        // Be transparent that this read came from looking at the slides.
        result.read_from_images = true;
        result.summary = "Note: this deck has no text inside it, so we read the slides as images. " +
          (result.summary || "");
      }
      // Persist the read against this founder + deck so every screen and a
      // later visit can pull it back up (survives refresh and restart).
      if (founder_id) diagnostic_save(founder_id, deck_id, result);
    }
    // Long-deck honesty flag: if the deck ran past what we read in full,
    // tell the founder rather than silently analysing only the first part.
    if (had_file && (deck_text || "").length > DECK_CHAR_LIMIT) {
      result.long_deck = true;
      result.summary = (
        "Heads-up: this deck is longer than we read in full — only the first " +
        "~25,000 characters were analysed, so the tail end wasn't seen. Consider " +
        "trimming or splitting it for a complete read. "
      ) + (result.summary || "");
    }
    result.deck_id = deck_id;
    return sendJson(res, 200, result);
  } else if (p === "/api/deal/create") {
    const out = deal_create(data);
    return sendJson(res, out.error ? (out.status || 400) : 200, out);
  } else if (p === "/api/deal/advance") {
    const out = deal_advance(data);
    return sendJson(res, out.error ? (out.status || 400) : 200, out);
  } else if (p === "/api/deal/verify") {
    const out = await deal_verify(data.credential || "", data.deal_id, data.verified !== false);
    if (out.error) return sendJson(res, out.status || 400, { error: out.error });
    return sendJson(res, 200, out);
  } else if (p === "/api/admin/deals") {
    const out = await deals_admin(data.credential || "");
    if (out.error) return sendJson(res, out.status || 403, { error: out.error });
    return sendJson(res, 200, out);
  } else if (p === "/api/support") {
    return sendJson(res, 200, support_add(data));
  } else if (p === "/api/payment/record") {
    const out = payment_record(data);
    return sendJson(res, out.error ? (out.status || 400) : 200, out);
  } else if (p === "/api/admin/review-queue") {
    const g = await require_admin(data.credential || "");
    if (g.error) return sendJson(res, g.status, { error: g.error });
    return sendJson(res, 200, { queue: review_queue() });
  } else if (p === "/api/review/assign") {
    const out = await review_assign(data.credential || "", data.founder_id,
      data.reviewer_email || "", data.reviewer_name || "");
    if (out.error) return sendJson(res, out.status || 400, { error: out.error });
    return sendJson(res, 200, out);
  } else if (p === "/api/investor/apply") {
    const out = investor_apply(data);
    return sendJson(res, out.error ? (out.status || 400) : 200, out);
  } else if (p === "/api/admin/investors") {
    const out = await investor_list(data.credential || "");
    if (out.error) return sendJson(res, out.status || 403, { error: out.error });
    return sendJson(res, 200, out);
  } else if (p === "/api/investor/decision") {
    const out = await investor_decision(data.credential || "", data.investor_id,
      data.decision || "", data.reason || "");
    if (out.error) return sendJson(res, out.status || 400, { error: out.error });
    return sendJson(res, 200, out);
  } else if (p === "/api/membership/handoff") {
    return sendJson(res, 200, membership_handoff(data));
  } else if (p === "/api/membership/recheck") {
    const out = await membership_recheck(data);
    return sendJson(res, out.error ? (out.status || 400) : 200, out);
  } else if (p === "/api/investor/invite") {
    const out = investor_invite(data);
    return sendJson(res, out.error ? (out.status || 400) : 200, out);
  } else if (p === "/api/meeting/request") {
    const out = meeting_request(data);
    return sendJson(res, out.error ? (out.status || 400) : 200, out);
  } else if (p === "/api/admin/meetings") {
    const out = await meeting_list(data.credential || "");
    if (out.error) return sendJson(res, out.status || 403, { error: out.error });
    return sendJson(res, 200, out);
  } else if (p === "/api/meeting/intro-sent") {
    const out = await meeting_intro_sent(data.credential || "", data.meeting_id);
    if (out.error) return sendJson(res, out.status || 400, { error: out.error });
    return sendJson(res, 200, out);
  } else {
    return sendJson(res, 404, { error: "unknown endpoint" });
  }
}

const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url, "http://localhost");
  if (req.method === "GET") {
    handleGet(req, res, urlObj).catch((e) => sendJson(res, 500, { error: String(e && e.message || e) }));
    return;
  }
  if (req.method === "POST") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const rawBody = Buffer.concat(chunks);
      let data;
      try {
        data = JSON.parse(rawBody.length ? rawBody.toString("utf-8") : "{}");
      } catch (e) {
        data = {};
      }
      try {
        await handlePost(req, res, urlObj, data);
      } catch (e) {
        sendJson(res, 500, { error: String(e && e.message || e) });
      }
    });
    return;
  }
  sendJson(res, 404, { error: "not found" });
});

const PORT = parseInt(process.env.PORT || "8000", 10);
// Bind 0.0.0.0 so the app also works on a host like Render; localhost still works locally.
const HOST = process.env.HOST || "0.0.0.0";

db_init();
console.log(`VentureReady demo running.  Open this in your browser:  http://localhost:${PORT}`);
console.log("Zoho member check: " + (ZOHO_CLIENT_ID ? "ready" : "MISSING") +
  " | AI key: " + (ANTHROPIC_API_KEY ? "set (live AI)" : "not set (sample result)"));
console.log("Press Ctrl+C here to stop the app.");
server.listen(PORT, HOST);
