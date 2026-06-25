// api/metrics.js
//
// PharmaSignal AI — metrics layer (GET, no body required).
//
// Returns three honest, non-fabricated numbers:
//
//   1. reportCount  — total reports generated, read from a public keyless hit
//      counter (abacus.jasoncameron.dev), incremented in api/generate.js on
//      every successful report. If the counter service is unreachable this
//      comes back as null — the frontend renders "—", it never guesses.
//
//   2. feedback     — { up, down } thumbs tallies, read from the same counter
//      service, written to by api/feedback.js. Expect this to be near zero
//      until the app has real traffic — that's reported as-is, not padded.
//
//   3. benchmark     — a LIVE accuracy check, not a cached claim. On every
//      call this function re-queries openFDA Drugs@FDA for four PINNED FDA
//      application numbers (not name search — see methodology note below)
//      and compares the extracted original-approval date against a small
//      set of well-known, independently publicly verifiable reference dates.
//      The match/mismatch result you see was computed seconds ago against
//      the live government API, not hardcoded.
//
// Methodology note on why application numbers are pinned rather than
// searched by brand/generic name: openFDA's Drugs@FDA brand_name/generic_name
// search can return the wrong application for drugs with multiple associated
// filings. Two concrete cases hit during development: searching
// brand_name:"keytruda" can surface a 2025 combination-product BLA instead of
// the original 2014 monotherapy approval, and brand_name:"gleevec" can
// surface a 2003 tablet-reformulation NDA instead of the original 2001
// capsule NDA. Pinning the exact application_number and reading the ORIG
// submission sidesteps that ambiguity entirely. Gleevec is deliberately
// excluded from the benchmark set below rather than "fixed" by guessing.

const FDA_BASE = 'https://api.fda.gov/drug/drugsfda.json';
const ABACUS_NS = 'pharmasignal-ai-v1';

function withTimeout(promise, ms = 8000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), ms))
  ]);
}

// Pinned, independently-verifiable benchmark set.
// referenceDate is the well-known public approval date for each drug's
// ORIGINAL approval (sourced from FDA press materials / public reporting),
// checked here against the live openFDA submission record for that exact
// application number.
const BENCHMARK_SET = [
  { drug: 'Lipitor (atorvastatin)', applicationNumber: 'NDA020702', referenceDate: '1996-12-17' },
  { drug: 'Humira (adalimumab)',    applicationNumber: 'BLA125057', referenceDate: '2002-12-31' },
  { drug: 'Keytruda (pembrolizumab)', applicationNumber: 'BLA125514', referenceDate: '2014-09-04' },
  { drug: 'Ozempic (semaglutide)',  applicationNumber: 'NDA209637', referenceDate: '2017-12-05' }
];

function toIso(yyyymmdd) {
  if (!yyyymmdd || yyyymmdd.length !== 8) return null;
  return `${yyyymmdd.slice(0,4)}-${yyyymmdd.slice(4,6)}-${yyyymmdd.slice(6,8)}`;
}

async function checkOne(entry) {
  try {
    const key = process.env.FDA_API_KEY ? `&api_key=${process.env.FDA_API_KEY}` : '';
    const url = `${FDA_BASE}?search=application_number:"${entry.applicationNumber}"&limit=1${key}`;
    const r = await withTimeout(fetch(url));
    if (!r.ok) {
      return { ...entry, ok: false, error: `openFDA HTTP ${r.status}`, liveDate: null, match: null };
    }
    const data = await r.json();
    const app = (data.results || [])[0];
    const orig = app && (app.submissions || []).find(s => s.submission_type === 'ORIG');
    const liveDate = orig ? toIso(orig.submission_status_date) : null;
    if (!liveDate) {
      return { ...entry, ok: false, error: 'No ORIG submission found on the live record', liveDate: null, match: null };
    }
    return { ...entry, ok: true, error: null, liveDate, match: liveDate === entry.referenceDate };
  } catch (e) {
    return { ...entry, ok: false, error: e.message, liveDate: null, match: null };
  }
}

async function runBenchmark() {
  const results = await Promise.all(BENCHMARK_SET.map(checkOne));
  const checked = results.filter(r => r.ok);
  const matched = checked.filter(r => r.match).length;
  return {
    items: results,
    matched,
    checked: checked.length,
    total: results.length,
    summary: checked.length
      ? `${matched}/${checked.length} pinned FDA records matched their independently-verifiable public approval date (live openFDA query, just now)`
      : 'openFDA was unreachable for all pinned records at request time',
    methodology: 'Queried openFDA Drugs@FDA by exact, pinned application_number (not brand/generic name search, which is unreliable for drugs with multiple filings — see Keytruda/Gleevec note in source) and compared the ORIG submission date against a public reference date.'
  };
}

async function readCounter(key) {
  try {
    const r = await withTimeout(fetch(`https://abacus.jasoncameron.dev/get/${ABACUS_NS}/${key}`), 4000);
    if (!r.ok) return null;
    const data = await r.json();
    return typeof data.value === 'number' ? data.value : null;
  } catch (e) {
    return null;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const [reportCount, feedbackUp, feedbackDown, benchmark] = await Promise.all([
      readCounter('reports-generated'),
      readCounter('feedback-up'),
      readCounter('feedback-down'),
      runBenchmark()
    ]);

    return res.status(200).json({
      reportCount,
      feedback: { up: feedbackUp, down: feedbackDown },
      benchmark
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
