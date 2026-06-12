# Consensus Research v6

Multi-source product, service, and restaurant research using weighted consensus scoring — with **verified-quote claims**. Finds truth at the intersection of independent review platforms, and refuses to present evidence it can't trace to fetched source text.

Forked from [Bryptobricks/consensus-researcher](https://github.com/Bryptobricks/consensus-researcher) (v5) and rebuilt around a two-phase, agent-driven architecture.

## How It Works

Instead of trusting any single source, this skill aggregates Reddit, HackerNews, Amazon, expert sites, niche forums, Lemmy, YouTube, Twitter/X, and GitHub — then scores products on **cross-platform convergence**. If 3+ independent sources agree on a strength or flaw, it's probably real.

> A complaint on 1 platform is anecdotal. On 2 platforms, it's notable. On 3+, it's confirmed.

### The v6 difference: two-phase research with quote verification

v5 extracted claims with regex keyword matching — it couldn't tell "great" from "not great". v6 splits research into phases so an LLM agent does the reading:

```
1. COLLECT   research.js collect "query" --out bundle.json
             CLI fetches sources into an ID-addressed bundle (full Reddit/HN/
             forum threads, full expert article text, Amazon/X/YouTube snippets)

2. EXTRACT   The agent (Claude Code / OpenClaw) reads bundle.sources and writes
             claims: brand × dimension × polarity + a VERBATIM quote.
             Handles negation, sarcasm, conditionals, comparisons.
             (No agent? `research.js extract` is the regex fallback.)

3. SCORE     research.js score claims.json --bundle bundle.json
             Every quote is verified against the bundle's source text:
             exact match → in-order fuzzy (≥85% tokens, blocks fabrication) →
             attested (agent-fetched pages) → REJECTED (excluded from scoring,
             reported with reason). Verified claims flow into convergence scoring.

4. REPORT    Every output ends with a verification stamp:
             [OK] Verified — 14 sources, 41/47 claims quote-verified
             (38 exact, 3 fuzzy), 2 attested, 4 rejected | extractor: agent | v6
```

The agent's judgment is the intelligence; the CLI is the accountability layer.

## Sources

| Tier | Sources | Weight | Fetch level |
|------|---------|--------|-------------|
| 1 | Reddit (3-strategy fallback + cache), HackerNews (Algolia API, full comment trees) | HIGH | Full threads |
| 2 | Expert sites (full article text at standard+), niche forums (Discourse JSON when available), YouTube | MEDIUM-HIGH | Full / snippet |
| 3 | Amazon, Twitter/X, Lemmy (deep mode) | MEDIUM | Snippet / full |
| 4 | Trustpilot, generic review sites | LOW | Snippet |

Niche forums are mapped per category (head-fi/audiosciencereview for tech, longecity for supplements, …) with automatic Discourse detection for full structured posts.

## Reliability ("must know 100%")

- **Quote verification** — fabricated or paraphrased quotes are rejected before scoring and listed in the report with reasons.
- **Fetch log** — every platform failure is recorded per-run and surfaced in output and `research.js status`. "No complaints found" and "platform was down" are never conflated.
- **Loud degradation** — DDG bot-challenge pages, parser zero-yields on non-empty HTML, and corrupt cache/state files are detected, logged, and recovered — never silently swallowed.
- **Search fallback chain** — Brave (if `BRAVE_API_KEY` set) → DuckDuckGo html → DuckDuckGo lite, with health tracking and ad filtering.
- **Test suite** — 59 fixture-based tests over scoring math, parsers, verification, bundles, and platform mappers: `npm test`.

## Usage

### As an agent skill (the intended way)

Works as a [Claude Code](https://claude.com/claude-code) skill and an [OpenClaw](https://github.com/openclaw/openclaw) skill from the same `SKILL.md`. Drop the repo into your skills directory and ask the agent to research something — it runs the full collect → extract → verify → score loop and delivers the compact report.

### CLI

```bash
# Two-phase (agent-driven)
node scripts/research.js collect "creatine monohydrate" --depth standard --out bundle.json
node scripts/research.js extract bundle.json --out claims.json     # regex fallback
node scripts/research.js score claims.json --bundle bundle.json --save --format json
node scripts/research.js ingest bundle.json https://labdoor.com/review/x   # add a page as verifiable source

# Legacy one-shot (regex extraction, cron-friendly)
node scripts/research.js "glycine powder" --category supplement --save
node scripts/research.js "cursor vs zed" --category software
node scripts/research.js --compare "Sony WH-1000XM5" "Bose QC Ultra" --category tech

# Watchlist & feedback
node scripts/research.js watchlist add "Nutricost creatine" --note "daily supplement"
node scripts/research.js watchlist check --deep            # theme shifts, reformulations
node scripts/research.js watchlist check --deep --json     # machine-readable, cron-friendly
node scripts/research.js feedback "creatine" --satisfaction 8   # calibrates future scoring

# Health
node scripts/research.js status    # provider health, last collect failures, calibration
```

**Requirements:** Node.js 18+. Zero npm dependencies. `BRAVE_API_KEY` strongly recommended ([free tier: 2K queries/mo](https://brave.com/search/api/)) — the DDG fallback works but bot-challenges under heavy use.

### Scheduled checks (Windows Task Scheduler)

```powershell
schtasks /create /tn "ConsensusWatchlist" /sc weekly /d SUN /st 09:00 `
  /tr "node C:\path\to\consensus-researcher\scripts\research.js watchlist check --deep --json"
```

Or from an OpenClaw cron job: `node scripts/research.js watchlist check --deep --json` and surface items with `"flagged": true`.

## File Structure

```
consensus-researcher/
├── SKILL.md                      # Agent orchestration spec (Claude Code + OpenClaw)
├── scripts/
│   ├── research.js               # CLI: collect/extract/score/ingest + legacy one-shot,
│   │                             # watchlist, feedback, status, cache
│   ├── lib/
│   │   ├── taxonomy.js           # Dimension taxonomy (single source of truth)
│   │   ├── bundle.js             # Collection bundle build/validate (collect/v1)
│   │   ├── verify.js             # Quote verification (exact/fuzzy/attested/rejected)
│   │   ├── fetchlog.js           # Per-run fetch failure tracking
│   │   ├── search.js             # Brave → DDG html → DDG lite, health + ad filtering
│   │   ├── reddit.js             # 3-strategy Reddit cascade + cache
│   │   ├── hn.js                 # HackerNews via Algolia (full comment trees)
│   │   ├── forums.js             # Niche forums with Discourse detection
│   │   ├── lemmy.js              # lemmy.world API (deep mode)
│   │   ├── fetchpage.js          # Generic static-page fetcher (expert full text, ingest)
│   │   ├── cache.js              # Shared file-cache helper
│   │   └── feedback.js           # Scoring calibration
│   └── test/                     # node:test suite (npm test)
├── references/                   # methodology, schema, brand intel database
├── data/                         # caches, watchlist, health, bundles (gitignored)
└── memory/research/              # saved reports (.md + .json)
```

## Scoring

Baseline **5.0**. Confirmed strength (3+ independent sources): **+0.5** (+0.75 for testing/purity/maintenance/adoption). Confirmed issue: severity-weighted — safety **−1.5**, effectiveness **−1.0**, quality **−0.5**, value/taste **−0.25**; 2-source issues at half weight. Safety issues at 2+ sources disqualify a brand from top pick. Range 1.0–10.0.

| Score | Verdict |
|-------|---------|
| 8.0+ | Strong Buy |
| 6.5–7.9 | Buy with Caveats |
| 4.5–6.4 | Mixed |
| < 4.5 | Avoid |

**Stamp tiers:** `[OK] Verified` needs <15% claim rejection and 3+ source types; agent-fetched ("attested") evidence outnumbering CLI-verified evidence caps at `[WARN]`; regex extraction caps at `[WARN]` unless data sufficiency is HIGH.

## What's New (v6)

- Two-phase collect/score architecture — the agent reads, the CLI verifies
- Claim quote verification: exact → in-order fuzzy → attested → rejected
- Verification stamp with full counts on every output
- HackerNews via Algolia (full comment trees, Tier 1)
- Full-text expert pages at standard+ depth (was: snippets only)
- Niche forums with Discourse JSON detection; Lemmy at deep
- Fetch log: platform failures are data, not stderr noise
- DDG hardening: ad filtering, bot-challenge detection, lite-endpoint fallback
- Watchlist `--json` for cron; first-deep-check baseline fix
- 59-test suite (was: zero tests)

See [SKILL.md](SKILL.md) for agent orchestration and `references/methodology.md` for the full scoring spec.

## License

MIT
