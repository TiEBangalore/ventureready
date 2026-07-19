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
  return db.prepare("SELECT * FROM support WHERE id=?").get(rid);
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

function founder_signup(d) {
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
  return { founder: public_founder(row) };
}

function founder_login(email, password) {
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
  return { founder: public_founder(row) };
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
  // Returns object: {member: bool, name, status, category}.
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
    const resp = await fetch(url, { headers: { Authorization: "Zoho-oauthtoken " + (await zoho_token()) } });
    if (!resp.ok) {
      // code 9220 = no matching record = not a member
      return { member: false, reason: "not found" };
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
    return { member: false, reason: "not found" };
  }
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
    return sendJson(res, 200, await verify_member(data.email || ""));
  } else if (p === "/api/founder") {
    return sendJson(res, 200, founder_upsert(data));
  } else if (p === "/api/signup") {
    const out = founder_signup(data);
    return sendJson(res, out.error ? 400 : 200, out);
  } else if (p === "/api/login") {
    const out = founder_login(data.email || "", data.password || "");
    return sendJson(res, out.error ? 401 : 200, out);
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
  } else if (p === "/api/support") {
    return sendJson(res, 200, support_add(data));
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
