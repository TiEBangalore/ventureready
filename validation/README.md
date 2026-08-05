# Portfolio validation

Does the AI agree with real TiE investment decisions? This runs a batch of **old
decks with known outcomes** through the same six-dimension rubric the platform
uses, and compares the AI's read against what actually happened.

> It's a **directional calibration check on a small sample — not a benchmark, and
> not proof.** Earning the VentureReady mark measures *investor-readiness*, which
> is correlated with — but not the same as — getting funded. A "divergence" can
> just mean a ready founder got passed for thesis/timing reasons, or a weak deck
> got funded on a relationship. Read each divergence on its own.

## Steps

1. Put old decks (PDF or PPTX) into **`decks/`**.
2. Fill in **`outcomes.csv`** — one row per deck:
   - `deck_filename` — must match the file in `decks/`
   - `outcome` — `funded` | `near_miss` | `passed`
   - `stage` — `pre_seed` | `seed` | `series_a` … (optional; improves scoring)
   - `note` — the real reason, one line (optional)
3. From the **`Code/`** folder, run:

   ```bash
   python3 validation/run_validation.py --dry-run   # checks inputs, no AI calls, no cost
   python3 validation/run_validation.py             # live run (uses the AI key in .env)
   ```

4. Read the output:
   - **`scorecard.md`** — plain-English summary (agreement rate, per-deck table, divergences)
   - **`results.csv`** — full per-deck detail with the six tier scores

## Notes

- Cost is small — roughly a few rupees per text deck, a little more for image-heavy decks (runs on Sonnet by default).
- Everything here is **git-ignored** (`decks/`, `outcomes.csv`, results) — the real portfolio data never leaves your machine.
- The scorer mirrors the reviewer's rubric: each of the six dimensions (Problem, Market, Differentiation, Team, Traction, Unit Economics) is scored Tier 1–4, and the "mark" is earned only at Tier 2 or better on all six.
