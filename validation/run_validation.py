#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
VentureReady — Portfolio Validation Harness
============================================
Runs a batch of OLD TiE decks (with known real outcomes) through the same AI
that powers the platform, scoring each on the six VentureReady dimensions, then
compares the AI's read against what actually happened. This is the "does the
model agree with real investment decisions?" test from the Alok Sharma session.

WHAT IT IS: a directional calibration check on a small sample — NOT a benchmark,
and NOT proof. Earning the VentureReady mark is about investor-readiness, which
is correlated with (but not the same as) getting funded.

HOW TO USE
----------
1. Drop your old decks (PDF or PPTX) into  validation/decks/
2. Fill in  validation/outcomes.csv  — one row per deck:
       deck_filename, outcome, stage, note
   where `outcome` is one of:  funded | near_miss | passed
   (funded/near_miss = investors leaned in; passed = investors declined)
3. From the Code/ folder, run:
       python3 validation/run_validation.py            # live (uses your AI key)
       python3 validation/run_validation.py --dry-run  # no API calls, just checks inputs
4. Read the results:
       validation/results.csv       (per-deck detail)
       validation/scorecard.md      (plain-English summary)

Costs roughly a few rupees per text deck, a bit more for image-heavy decks.
Nothing here is committed to git (decks are private) — see validation/.gitignore.
"""
import os, sys, csv, json, base64, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
CODE = os.path.dirname(HERE)
sys.path.insert(0, CODE)

# Reuse the platform's own deck-reading + model selection (no server is started
# on import — server.py guards startup behind __main__).
import server  # noqa: E402

DECKS_DIR = os.path.join(HERE, "decks")
OUTCOMES_CSV = os.path.join(HERE, "outcomes.csv")
RESULTS_CSV = os.path.join(HERE, "results.csv")
SCORECARD_MD = os.path.join(HERE, "scorecard.md")

DIMS = ["Problem", "Market", "Differentiation", "Team", "Traction", "Unit Economics"]

# outcome buckets: did investors lean in?
POSITIVE = {"funded", "near_miss", "near-miss", "near"}
NEGATIVE = {"passed", "pass", "rejected", "declined", "no"}


def score_deck(deck_text, images, stage):
    """Ask the model to score the six dimensions Tier 1-4 (1 = top, lower better),
    the way a TiE reviewer would. Returns a dict or raises."""
    stage_line = (" The company's stage is: %s. Weight the dimensions by stage — "
                  "for a very early (pre-seed) company, Problem and Team matter more "
                  "than Traction." % stage) if stage else ""
    prompt = (
        "You are a senior TiE Bangalore investment reviewer scoring a pitch deck against the "
        "VentureReady rubric. Score EACH of the six investor-readiness dimensions on a 1-4 tier "
        "ladder where Tier 1 is the top and higher numbers are weaker (lower is better): "
        "Problem (urgent, must-have?), Market (real spend now, timing), Differentiation (hard-to-copy edge), "
        "Team (why this team wins), Traction (real customers/usage/contracts), Unit Economics (per-customer economics). "
        "Tier 1 = exceptional, proven; Tier 2 = clear, credible (the bar to earn the mark); Tier 3-4 = still developing." + stage_line +
        " The VentureReady mark is earned only if the deck is Tier 2 or better on ALL SIX dimensions. "
        "Watch for these anti-patterns: " + server.ANTI_PATTERNS + ". "
        "Respond ONLY as JSON: {\"tiers\": {\"Problem\": 1-4, \"Market\": 1-4, \"Differentiation\": 1-4, "
        "\"Team\": 1-4, \"Traction\": 1-4, \"Unit Economics\": 1-4}, \"verdict\": \"recommend\"|\"not_yet\", "
        "\"rationale\": \"one or two sentences\"}. Set verdict to \"recommend\" only if every tier is 1 or 2.\n\n"
        + ("The deck is image-based; its slides are attached as pictures. Read them directly."
           if images else "DECK TEXT:\n" + (deck_text or "")[:server.DECK_CHAR_LIMIT])
    )
    if images:
        content = [{"type": "image", "source": {"type": "base64",
                    "media_type": im["media_type"], "data": im["b64"]}} for im in images]
        content.append({"type": "text", "text": prompt})
    else:
        content = prompt
    body = json.dumps({"model": server.get_model(), "max_tokens": 1024,
                       "messages": [{"role": "user", "content": content}]}).encode()
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages", data=body, method="POST",
        headers={"x-api-key": server.ANTHROPIC_API_KEY,
                 "anthropic-version": "2023-06-01", "content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        data = json.loads(r.read().decode())
    text = "".join(b.get("text", "") for b in data.get("content", []))
    s, e = text.find("{"), text.rfind("}")
    return json.loads(text[s:e + 1])


def ai_pass(tiers):
    """Mark earned = every dimension at Tier 1 or 2."""
    try:
        return all(int(tiers.get(d, 4)) <= 2 for d in DIMS)
    except (TypeError, ValueError):
        return False


def load_outcomes():
    if not os.path.exists(OUTCOMES_CSV):
        return {}
    out = {}
    with open(OUTCOMES_CSV, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            fn = (row.get("deck_filename") or "").strip()
            if fn and not fn.startswith("#"):
                out[fn] = {"outcome": (row.get("outcome") or "").strip().lower(),
                           "stage": (row.get("stage") or "").strip(),
                           "note": (row.get("note") or "").strip()}
    return out


def main():
    dry = "--dry-run" in sys.argv
    outcomes = load_outcomes()
    decks = sorted(f for f in os.listdir(DECKS_DIR)
                   if f.lower().endswith((".pdf", ".pptx", ".ppt")))
    if not decks:
        print("No decks found in %s — drop PDF/PPTX files there first." % DECKS_DIR)
        return
    if not server.ANTHROPIC_API_KEY and not dry:
        print("No ANTHROPIC_API_KEY in .env — cannot run live. Use --dry-run to check inputs.")
        return

    print("Found %d deck(s); %d have outcomes in outcomes.csv." % (len(decks), len(outcomes)))
    rows = []
    for fn in decks:
        meta = outcomes.get(fn, {})
        actual = meta.get("outcome", "")
        stage = meta.get("stage", "")
        if dry:
            print("  [dry] %-40s outcome=%s stage=%s" % (fn, actual or "(missing)", stage or "-"))
            continue
        path = os.path.join(DECKS_DIR, fn)
        with open(path, "rb") as f:
            raw = f.read()
        text = server.extract_deck_text(fn, raw)
        images = None
        if len((text or "").strip()) < 120:
            images = server.extract_deck_images(fn, raw)
        try:
            res = score_deck(text, images, stage)
        except Exception as e:  # noqa: BLE001
            print("  !! %s — scoring failed: %s" % (fn, e))
            rows.append({"deck": fn, "actual": actual, "ai_verdict": "ERROR",
                         "ai_pass": "", "agree": "", "rationale": str(e)[:200],
                         **{d: "" for d in DIMS}})
            continue
        tiers = res.get("tiers", {})
        aip = ai_pass(tiers)
        # agreement: investors leaned in AND AI would give the mark, or investors
        # passed AND AI would not — only computed when we know the real outcome.
        agree = ""
        if actual in POSITIVE:
            agree = "yes" if aip else "no"
        elif actual in NEGATIVE:
            agree = "yes" if not aip else "no"
        print("  %-40s actual=%-9s AI=%-9s %s" % (
            fn, actual or "(none)", "MARK" if aip else "not_yet",
            "" if not agree else ("agree" if agree == "yes" else "DIVERGE")))
        rows.append({"deck": fn, "actual": actual,
                     "ai_verdict": res.get("verdict", ""),
                     "ai_pass": "mark" if aip else "not_yet",
                     "agree": agree, "rationale": res.get("rationale", ""),
                     **{d: tiers.get(d, "") for d in DIMS}})

    if dry or not rows:
        return

    # write results.csv
    cols = ["deck", "actual", "ai_verdict", "ai_pass", "agree"] + DIMS + ["rationale"]
    with open(RESULTS_CSV, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for r in rows:
            w.writerow(r)

    # scorecard.md
    scored = [r for r in rows if r["agree"] in ("yes", "no")]
    agr = sum(1 for r in scored if r["agree"] == "yes")
    pos = [r for r in scored if r["actual"] in POSITIVE]
    neg = [r for r in scored if r["actual"] in NEGATIVE]
    pos_ok = sum(1 for r in pos if r["ai_pass"] == "mark")
    neg_ok = sum(1 for r in neg if r["ai_pass"] == "not_yet")
    lines = []
    lines.append("# Portfolio validation — scorecard\n")
    lines.append("_Directional calibration on a small sample — not a benchmark. "
                 "The VentureReady mark measures investor-readiness, which is correlated with, "
                 "but not the same as, getting funded._\n")
    lines.append("## Headline")
    if scored:
        lines.append("- **Agreement with real outcomes:** %d of %d (%.0f%%)" % (
            agr, len(scored), 100.0 * agr / len(scored)))
    lines.append("- Funded / near-miss decks the AI would give the mark: **%d of %d**" % (pos_ok, len(pos)))
    lines.append("- Passed decks the AI would also hold back (not_yet): **%d of %d**" % (neg_ok, len(neg)))
    lines.append("\n## Per-deck\n")
    lines.append("| Deck | Real outcome | AI verdict | " + " | ".join(DIMS) + " | Agree? |")
    lines.append("|---|---|---|" + "---|" * len(DIMS) + "---|")
    for r in rows:
        lines.append("| %s | %s | %s | %s | %s |" % (
            r["deck"], r["actual"] or "-", r["ai_pass"] or r["ai_verdict"],
            " | ".join(str(r.get(d, "")) for d in DIMS),
            {"yes": "✓", "no": "✗ diverge", "": "-"}[r["agree"]]))
    lines.append("\n## Where the AI diverged from reality\n")
    div = [r for r in rows if r["agree"] == "no"]
    if not div:
        lines.append("_No divergences on the decks with known outcomes._")
    for r in div:
        lines.append("- **%s** (real: %s, AI: %s) — %s" % (
            r["deck"], r["actual"], r["ai_pass"], r["rationale"]))
    lines.append("\n## How to read this\n")
    lines.append("- A **divergence isn't necessarily the AI being wrong** — a founder can be "
                 "genuinely investor-ready and still get passed (fund thesis, timing, cheque size), "
                 "or get funded on a relationship despite a weak deck. Read the divergences one by one.")
    lines.append("- Use the per-dimension tiers to see **which dimension the AI is harshest/softest on** "
                 "versus real reviewers — that's what to calibrate in the reviewer guideline.")
    with open(SCORECARD_MD, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

    print("\nWrote %s and %s" % (os.path.relpath(RESULTS_CSV, CODE), os.path.relpath(SCORECARD_MD, CODE)))


if __name__ == "__main__":
    main()
