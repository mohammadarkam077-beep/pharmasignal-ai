# pharmasignal-ai

[pharmasignal-ai.vercel.app](https://pharmasignal-ai.vercel.app)

AI-powered pharma intelligence console. Pick a report type (Safety Signal, Pipeline CI, HEOR Brief, Regulatory, or Launch Readiness), enter a drug name, and get a structured intelligence brief that **aggregates six live data feeds and synthesizes them** — not just a report generated from Claude's general knowledge.

## Architecture

- `index.html` — static frontend. Builds the prompt, calls `/api/generate`, renders the AI narrative **and** a "Live Data Aggregation" panel showing the raw structured data from each of the six feeds (status badges, key entries per source). No build step.
- `api/generate.js` — Vercel serverless function. For the named drug, queries six live sources in parallel, builds a "verified data appendix" from whatever returns, and sends the appendix + report prompt to Claude with explicit synthesizer instructions. Returns `{ text, sources, data }` — `text` is Claude's narrative, `sources` is a one-line OK/unavailable summary, and `data` is the raw aggregated bundle the frontend renders directly.
- `vercel.json` — routes `/api/*` to the function.

## Aggregator + synthesizer model

This isn't a single prompt fed by hidden data — it's two distinct jobs:

1. **Aggregator**: the API fetches all six sources independently and returns the raw structured results to the frontend, which displays them as their own cards (live status per source, real IDs/counts/dates). The user can see exactly what was retrieved, separate from any AI interpretation.
2. **Synthesizer**: Claude is explicitly instructed not to summarize each source in isolation. Every factual claim in the narrative must be tagged inline to its source (e.g. "(ClinicalTrials.gov)", "(FAERS)"), unavailable sources must be stated as such rather than guessed, and the report must include a dedicated **Cross-Source Synthesis** section connecting patterns across at least two feeds (e.g. trial pipeline activity vs. adverse event trends, or patent landscape vs. enforcement history).

## Launch Readiness Report (commercial-value deliverable)

The fifth report type is differentiated from the other four: instead of relying purely on Claude's judgment, `api/generate.js` runs a **deterministic, rule-based scoring engine** (`computeLaunchReadiness`) over the six live feeds and produces a reproducible scorecard before Claude ever sees the data:

| Dimension | Computed from | Logic |
|---|---|---|
| Clinical Maturity | ClinicalTrials.gov | Highest trial phase reached + count of active/recruiting trials |
| Regulatory Status | Drugs@FDA | Whether any application has an active marketing status |
| IP Runway | USPTO/PatentsView | Recency of the most recent matching patent grant |
| Safety Profile | FAERS + FDA Enforcement | Total ADR report volume, penalized for any Class I recall |
| Evidence Base | PubMed | Volume of recent literature |
| Field Action Risk | FDA Enforcement | Count of recall/field-action records |

Each dimension scores 0-100 (or `N/A` if its source was unavailable, never a guessed number), and the six scores average into an overall score with a **GO / CAUTION / NO-GO** band (≥75 / 55-74 / <55). This scorecard is returned to the frontend as `launchScore` and rendered directly as a visual bar chart with a coverage line ("N/M dimensions scored from live data") — the user sees the real, auditable numbers, not an LLM's impression of them. Claude's job for this report type is constrained to explaining and narrating around the pre-computed scorecard (citing the underlying feed for each dimension), not to inventing its own scores.

This makes the Launch Readiness Report the app's clearest commercial differentiator: a quantitative, reproducible Go/No-Go judgment grounded in live regulatory, clinical, IP, safety, and literature data, rather than a purely qualitative AI narrative.

## Live data sources

| # | Source | What it provides | Auth required |
|---|---|---|---|
| 1 | [ClinicalTrials.gov API v2](https://clinicaltrials.gov/data-api/api) | Matching trials: status, phase, sponsor, enrollment, dates | No |
| 2 | [openFDA FAERS](https://open.fda.gov/apis/drug/event/) | Adverse event report counts by reaction term | No (key recommended for higher rate limits) |
| 3 | [openFDA Drugs@FDA](https://open.fda.gov/apis/drug/drugsfda/) | Approval/application status, marketing status, submissions — used as the Orange Book–adjacent source since the full Orange Book patent/exclusivity tables aren't exposed as a REST API | No (key recommended) |
| 4 | [USPTO via PatentsView](https://patentsview.org/apis/api-endpoints) | Patents matching the drug name in the title | **Yes** — free key required |
| 5 | [PubMed / NCBI E-utilities](https://www.ncbi.nlm.nih.gov/books/NBK25501/) | Recent literature: titles, journals, authors, publication dates | No (key recommended for higher rate limits) |
| 6 | [openFDA Enforcement](https://open.fda.gov/apis/drug/enforcement/) | Recalls and field actions: classification, reason, firm, status, scope | No (key recommended) |

If a source fails or returns nothing, `api/generate.js` tells Claude explicitly so it states "unavailable" instead of inventing numbers, and the frontend shows that card as "UNAVAILABLE" rather than hiding it.

## Environment variables (set in Vercel → Project → Settings → Environment Variables)

- `ANTHROPIC_API_KEY` — required, used to call Claude.
- `FDA_API_KEY` — optional. Get one free at https://open.fda.gov/apis/authentication/ to raise openFDA (FAERS/Drugs@FDA/Enforcement) rate limits.
- `PATENTSVIEW_API_KEY` — required for the USPTO patent card to return results. Get one free at https://patentsview.org/apis/keyrequest. Without it, that card just shows "unavailable" rather than failing the whole report.
- `NCBI_API_KEY` — optional. Get one free at https://www.ncbi.nlm.nih.gov/account/settings/ to raise PubMed E-utilities rate limits.

## Metrics layer

Three honest, non-fabricated numbers, surfaced in the sidebar's "Live metrics" panel and the header's report counter — built specifically so the app's own claims about itself follow the same anti-fabrication rule as its drug reports: if a backing service is unreachable, show "—", don't guess.

- `api/metrics.js` — `GET`, no body. Returns `{ reportCount, feedback: { up, down }, benchmark }`.
- `api/feedback.js` — `POST { vote: "up" | "down" }`. Returns the updated `{ up, down }` tally.
- `api/generate.js` — on every successful report, fires a best-effort, 3-second-timeout call to bump the report counter and returns the new total as `reportCount` in its response.

**1. Reports generated** — a live count of total reports the app has produced, backed by [abacus.jasoncameron.dev](https://abacus.jasoncameron.dev), a free, keyless public hit-counter API. No database, no auth — anyone can read the same number back via `GET /api/metrics`. If the counter service is down, the badge shows "—" instead of a stale or fabricated number.

**2. Accuracy benchmark against a published reference** — not a cached claim, a live check. On every call to `/api/metrics`, the function re-queries openFDA Drugs@FDA for four **pinned** FDA application numbers and compares the extracted original-approval date against a well-known, independently publicly verifiable reference date:

| Drug | Application # | Public reference date |
|---|---|---|
| Lipitor (atorvastatin) | NDA020702 | 1996-12-17 |
| Humira (adalimumab) | BLA125057 | 2002-12-31 |
| Keytruda (pembrolizumab) | BLA125514 | 2014-09-04 |
| Ozempic (semaglutide) | NDA209637 | 2017-12-05 |

Why pinned application numbers instead of searching by brand/generic name: openFDA's name-based search can return the wrong filing for drugs with multiple associated applications. Two concrete cases surfaced during development — `brand_name:"keytruda"` can return a 2025 combination-product BLA instead of the original 2014 monotherapy approval, and `brand_name:"gleevec"` can return a 2003 tablet-reformulation NDA instead of the original 2001 capsule NDA. Pinning the exact `application_number` and reading the `ORIG` submission sidesteps that ambiguity. Gleevec is deliberately excluded from the benchmark set rather than "fixed" by guessing which application is canonical.

**3. User feedback** — a thumbs up/down widget shown under every generated report, also backed by abacus.jasoncameron.dev. Expect this to read close to zero honestly — the tool reports the real count, not a padded one, until there's real traffic.

## Known limitations

- True FDA Orange Book patent/exclusivity listings (the actual patent-to-product linkage and expiry dates) live in downloadable flat files on fda.gov, not a REST API — `Drugs@FDA` is used as the closest live-API proxy for approval/marketing status. A future iteration could fetch and parse the Orange Book text files directly if exact patent-linkage data is needed.
- FAERS counts are raw report counts, not adjusted signal scores (PRR/ROR) — Claude is instructed to present them as raw counts, not calculated disproportionality statistics, unless it computes them transparently from the numbers given.
- Each fetch is wrapped with a 9-second timeout so a single slow source can't hang the whole report; a timed-out source is reported as unavailable like any other failure.
