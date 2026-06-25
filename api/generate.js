// api/generate.js
//
// PharmaSignal AI — real-time data aggregator + synthesizer.
//
// This function is NOT a thin wrapper around an LLM prompt. On every request
// it fans out to six independent live pharma data feeds, normalizes whatever
// comes back, and returns that raw aggregated data to the client (so the UI
// can render it directly) AND feeds it to Claude with explicit instructions
// to synthesize across sources rather than just narrate one of them.
//
// Live feeds:
//   1. ClinicalTrials.gov v2      — trial status, phase, sponsor, enrollment
//   2. openFDA FAERS              — adverse event report counts
//   3. openFDA Drugs@FDA          — approval/marketing status (Orange Book proxy)
//   4. USPTO via PatentsView      — patents matching the drug name
//   5. PubMed (NCBI E-utilities)  — most recent literature
//   6. openFDA Enforcement        — recalls / field actions
//
// Launch Readiness Report (reportType === 'launch'): additionally runs a
// deterministic, rule-based scoring engine (computeLaunchReadiness) over the
// six feeds — six 0-100 dimension scores plus an overall GO/CAUTION/NO-GO
// band — and returns it as `launchScore` so the frontend can render it as a
// real scorecard. Claude is told to narrate around these numbers, not invent
// its own.
//
// Env vars (Vercel → Settings → Environment Variables):
//   ANTHROPIC_API_KEY     required
//   FDA_API_KEY            optional — raises openFDA rate limits
//   PATENTSVIEW_API_KEY    optional — required for USPTO patent search to return results
//   NCBI_API_KEY           optional — raises PubMed rate limits
//
// Metrics layer: every successful report increments a public, keyless hit
// counter (abacus.jasoncameron.dev) under namespace ABACUS_NS. This is a
// best-effort, non-blocking call — if the counter service is unreachable the
// report still returns normally and reportCount comes back as null, which the
// frontend renders as "—" rather than guessing a number. See api/metrics.js
// for the live accuracy benchmark and api/feedback.js for the feedback tally.

const ABACUS_NS = 'pharmasignal-ai-v1';

async function bumpReportCounter() {
  try {
    const r = await withTimeout(fetch(`https://abacus.jasoncameron.dev/hit/${ABACUS_NS}/reports-generated`), 3000);
    if (!r.ok) return null;
    const data = await r.json();
    return typeof data.value === 'number' ? data.value : null;
  } catch (e) {
    return null;
  }
}

const CT_BASE    = 'https://clinicaltrials.gov/api/v2/studies';
const FDA_BASE    = 'https://api.fda.gov/drug';
const USPTO_BASE  = 'https://search.patentsview.org/api/v1/patent/';
const EUTILS_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

function withTimeout(promise, ms = 9000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), ms))
  ]);
}

// ---------- 1. ClinicalTrials.gov v2 ----------
async function fetchClinicalTrials(drug) {
  try {
    const url = `${CT_BASE}?query.term=${encodeURIComponent(drug)}&pageSize=6&sort=LastUpdatePostDate:desc`;
    const r = await withTimeout(fetch(url));
    if (!r.ok) return { ok: false, label: 'ClinicalTrials.gov', error: `HTTP ${r.status}` };
    const data = await r.json();
    const studies = (data.studies || []).map(s => {
      const id = s.protocolSection?.identificationModule || {};
      const st = s.protocolSection?.statusModule || {};
      const dm = s.protocolSection?.designModule || {};
      const cm = s.protocolSection?.conditionsModule || {};
      const sm = s.protocolSection?.sponsorCollaboratorsModule || {};
      return {
        nctId: id.nctId,
        title: id.briefTitle,
        status: st.overallStatus,
        phase: (dm.phases || []).join('/') || 'N/A',
        enrollment: dm.enrollmentInfo?.count,
        conditions: (cm.conditions || []).join(', '),
        sponsor: sm.leadSponsor?.name,
        start: st.startDateStruct?.date,
        primaryCompletion: st.primaryCompletionDateStruct?.date
      };
    });
    return { ok: true, label: 'ClinicalTrials.gov', totalCount: data.totalCount ?? studies.length, studies };
  } catch (e) {
    return { ok: false, label: 'ClinicalTrials.gov', error: e.message };
  }
}

// ---------- 2. openFDA: FAERS adverse events ----------
async function fetchFAERS(drug) {
  try {
    const key = process.env.FDA_API_KEY ? `&api_key=${process.env.FDA_API_KEY}` : '';
    const url = `${FDA_BASE}/event.json?search=patient.drug.medicinalproduct:"${encodeURIComponent(drug)}"&count=patient.reaction.reactionmeddrapt.exact${key}`;
    const r = await withTimeout(fetch(url));
    if (r.status === 404) return { ok: true, label: 'FAERS (openFDA)', reactions: [], note: 'No FAERS reports found for this term.' };
    if (!r.ok) return { ok: false, label: 'FAERS (openFDA)', error: `HTTP ${r.status}` };
    const data = await r.json();
    return { ok: true, label: 'FAERS (openFDA)', reactions: (data.results || []).slice(0, 10) };
  } catch (e) {
    return { ok: false, label: 'FAERS (openFDA)', error: e.message };
  }
}

// ---------- 3. openFDA: Drugs@FDA (approval/marketing — Orange Book proxy) ----------
async function fetchDrugsFDA(drug) {
  try {
    const key = process.env.FDA_API_KEY ? `&api_key=${process.env.FDA_API_KEY}` : '';
    const term = encodeURIComponent(drug);
    const url = `${FDA_BASE}/drugsfda.json?search=(openfda.brand_name:"${term}"+OR+openfda.generic_name:"${term}")&limit=5${key}`;
    const r = await withTimeout(fetch(url));
    if (r.status === 404) return { ok: true, label: 'Drugs@FDA / Orange Book', applications: [], note: 'No FDA application records found for this term.' };
    if (!r.ok) return { ok: false, label: 'Drugs@FDA / Orange Book', error: `HTTP ${r.status}` };
    const data = await r.json();
    const applications = (data.results || []).map(app => ({
      applicationNumber: app.application_number,
      sponsor: app.sponsor_name,
      products: (app.products || []).slice(0, 4).map(p => ({
        brand: p.brand_name,
        dosageForm: p.dosage_form,
        marketingStatus: p.marketing_status,
        activeIngredients: (p.active_ingredients || []).map(ai => `${ai.name} ${ai.strength}`).join('; ')
      })),
      latestSubmission: (app.submissions || [])[0] && {
        type: app.submissions[0].submission_type,
        status: app.submissions[0].submission_status,
        date: app.submissions[0].submission_status_date
      }
    }));
    return { ok: true, label: 'Drugs@FDA / Orange Book', applications };
  } catch (e) {
    return { ok: false, label: 'Drugs@FDA / Orange Book', error: e.message };
  }
}

// ---------- 4. USPTO (PatentsView) ----------
async function fetchPatents(drug) {
  const apiKey = process.env.PATENTSVIEW_API_KEY;
  if (!apiKey) {
    return { ok: false, label: 'USPTO (PatentsView)', error: 'PATENTSVIEW_API_KEY not configured — sign up free at patentsview.org/apis/keyrequest.' };
  }
  try {
    const q = encodeURIComponent(JSON.stringify({ _text_any: { patent_title: drug } }));
    const f = encodeURIComponent(JSON.stringify(['patent_id', 'patent_title', 'patent_date']));
    const url = `${USPTO_BASE}?q=${q}&f=${f}`;
    const r = await withTimeout(fetch(url, { headers: { 'X-Api-Key': apiKey } }));
    if (!r.ok) return { ok: false, label: 'USPTO (PatentsView)', error: `HTTP ${r.status}` };
    const data = await r.json();
    const patents = (data.patents || []).slice(0, 8).map(p => ({
      id: p.patent_id,
      title: p.patent_title,
      date: p.patent_date
    }));
    return { ok: true, label: 'USPTO (PatentsView)', patents };
  } catch (e) {
    return { ok: false, label: 'USPTO (PatentsView)', error: e.message };
  }
}

// ---------- 5. PubMed (NCBI E-utilities) — most recent literature ----------
async function fetchPubMed(drug) {
  try {
    const key = process.env.NCBI_API_KEY ? `&api_key=${process.env.NCBI_API_KEY}` : '';
    const searchUrl = `${EUTILS_BASE}/esearch.fcgi?db=pubmed&term=${encodeURIComponent(drug)}&retmode=json&retmax=6&sort=date${key}`;
    const sr = await withTimeout(fetch(searchUrl));
    if (!sr.ok) return { ok: false, label: 'PubMed', error: `HTTP ${sr.status}` };
    const sdata = await sr.json();
    const ids = sdata.esearchresult?.idlist || [];
    if (ids.length === 0) return { ok: true, label: 'PubMed', papers: [], note: 'No recent PubMed articles found for this term.' };

    const summaryUrl = `${EUTILS_BASE}/esummary.fcgi?db=pubmed&id=${ids.join(',')}&retmode=json${key}`;
    const sumR = await withTimeout(fetch(summaryUrl));
    if (!sumR.ok) return { ok: false, label: 'PubMed', error: `HTTP ${sumR.status}` };
    const sumData = await sumR.json();
    const papers = ids.map(id => {
      const item = sumData.result?.[id];
      if (!item) return null;
      return {
        pmid: id,
        title: item.title,
        journal: item.source,
        pubdate: item.pubdate,
        authors: (item.authors || []).slice(0, 3).map(a => a.name).join(', ')
      };
    }).filter(Boolean);
    return { ok: true, label: 'PubMed', papers };
  } catch (e) {
    return { ok: false, label: 'PubMed', error: e.message };
  }
}

// ---------- 6. openFDA Enforcement (recalls / field actions) ----------
async function fetchEnforcement(drug) {
  try {
    const key = process.env.FDA_API_KEY ? `&api_key=${process.env.FDA_API_KEY}` : '';
    const url = `${FDA_BASE}/enforcement.json?search=product_description:"${encodeURIComponent(drug)}"&limit=5&sort=report_date:desc${key}`;
    const r = await withTimeout(fetch(url));
    if (r.status === 404) return { ok: true, label: 'FDA Enforcement', recalls: [], note: 'No recalls or field actions found for this term.' };
    if (!r.ok) return { ok: false, label: 'FDA Enforcement', error: `HTTP ${r.status}` };
    const data = await r.json();
    const recalls = (data.results || []).map(r => ({
      recallNumber: r.recall_number,
      classification: r.classification,
      status: r.status,
      firm: r.recalling_firm,
      reason: r.reason_for_recall,
      reportDate: r.report_date,
      distribution: r.distribution_pattern
    }));
    return { ok: true, label: 'FDA Enforcement', recalls };
  } catch (e) {
    return { ok: false, label: 'FDA Enforcement', error: e.message };
  }
}

// ---------- Build the aggregated-data appendix injected into the Claude prompt ----------
function buildDataAppendix({ ct, faers, fda, patents, pubmed, enforcement }) {
  const lines = [];
  lines.push('=== LIVE DATA AGGREGATION (retrieved at request time from 6 independent feeds — treat as ground truth) ===');

  lines.push('\n[1. ClinicalTrials.gov]');
  if (ct.ok) {
    lines.push(`Total matching trials: ${ct.totalCount}`);
    if (ct.studies.length === 0) lines.push('No trials returned for this term.');
    ct.studies.forEach(s => {
      lines.push(`- ${s.nctId} | ${s.title} | Status: ${s.status} | Phase: ${s.phase} | Sponsor: ${s.sponsor} | Enrollment: ${s.enrollment ?? 'N/A'} | Conditions: ${s.conditions} | Start: ${s.start} | Primary completion: ${s.primaryCompletion}`);
    });
  } else {
    lines.push(`Unavailable (${ct.error}). Do not invent trial numbers, phases, or sponsors.`);
  }

  lines.push('\n[2. FAERS — openFDA Adverse Event Reports]');
  if (faers.ok) {
    if (faers.note) lines.push(faers.note);
    faers.reactions.forEach(r => lines.push(`- ${r.term}: ${r.count} reports`));
  } else {
    lines.push(`Unavailable (${faers.error}). Do not invent ADR counts or PRR/ROR figures.`);
  }

  lines.push('\n[3. Drugs@FDA / Orange Book — approval & marketing status]');
  if (fda.ok) {
    if (fda.note) lines.push(fda.note);
    fda.applications.forEach(a => {
      lines.push(`- Application ${a.applicationNumber} | Sponsor: ${a.sponsor} | Latest submission: ${a.latestSubmission ? `${a.latestSubmission.type} (${a.latestSubmission.status}, ${a.latestSubmission.date})` : 'N/A'}`);
      a.products.forEach(p => lines.push(`    · ${p.brand} — ${p.dosageForm} — ${p.marketingStatus} — ${p.activeIngredients}`));
    });
  } else {
    lines.push(`Unavailable (${fda.error}). Do not invent application numbers or approval dates.`);
  }

  lines.push('\n[4. USPTO — Patents (PatentsView)]');
  if (patents.ok) {
    if (patents.patents.length === 0) lines.push('No matching patents returned.');
    patents.patents.forEach(p => lines.push(`- ${p.id} | ${p.title} | Granted: ${p.date}`));
  } else {
    lines.push(`Unavailable (${patents.error}). Do not invent patent numbers or expiry dates.`);
  }

  lines.push('\n[5. PubMed — recent literature]');
  if (pubmed.ok) {
    if (pubmed.note) lines.push(pubmed.note);
    pubmed.papers.forEach(p => lines.push(`- PMID ${p.pmid} | ${p.title} | ${p.authors} | ${p.journal}, ${p.pubdate}`));
  } else {
    lines.push(`Unavailable (${pubmed.error}). Do not invent citations, authors, or journal names.`);
  }

  lines.push('\n[6. FDA Enforcement — recalls / field actions]');
  if (enforcement.ok) {
    if (enforcement.note) lines.push(enforcement.note);
    enforcement.recalls.forEach(r => lines.push(`- ${r.recallNumber} | Class ${r.classification} | ${r.status} | Firm: ${r.firm} | Reason: ${r.reason} | Reported: ${r.reportDate}`));
  } else {
    lines.push(`Unavailable (${enforcement.error}). Do not invent recall numbers or reasons.`);
  }

  lines.push('\n=== END AGGREGATION ===');
  lines.push(`
You are not a generic report writer — you are a pharma intelligence SYNTHESIZER. Your job is to integrate the six feeds above into one coherent analysis, not to summarize each feed in isolation.

Rules:
1. Every specific factual claim (trial status, ADR count, approval date, patent, citation, recall) must trace to a feed above. Tag it inline with the feed name in parentheses, e.g. "(ClinicalTrials.gov)" or "(FAERS)".
2. Where a feed is unavailable or empty, say so explicitly in the relevant section instead of inventing specifics — but you may still use general pharmacology/clinical knowledge for mechanism explanation and interpretation, clearly distinguishable from sourced facts.
3. Include a dedicated "## CROSS-SOURCE SYNTHESIS" section near the end that explicitly connects at least two feeds — e.g. how trial momentum relates to patent timing, how adverse event trends relate to recall history, how recent literature aligns with or contradicts the safety/efficacy picture. This is the most important section: it is where you add analytical value beyond restating each feed.`);

  return lines.join('\n');
}

function sourcesSummary({ ct, faers, fda, patents, pubmed, enforcement }) {
  const tag = (res) => `${res.label}: ${res.ok ? 'OK' : 'unavailable'}`;
  return [ct, faers, fda, patents, pubmed, enforcement].map(tag).join(' · ');
}

// Trim each source's payload to what the frontend needs for the "live data" panel
function buildClientData({ ct, faers, fda, patents, pubmed, enforcement }) {
  return { ct, faers, fda, patents, pubmed, enforcement };
}

// ---------- Launch Readiness Scorecard ----------
// Deterministic, rule-based scoring computed directly from the six live feeds.
// This is intentionally NOT left to the LLM to judge — every number here traces
// to a concrete signal in the aggregated data, so the scorecard is reproducible
// and auditable, and Claude is told to narrate around it rather than invent it.
function computeLaunchReadiness({ ct, faers, fda, patents, pubmed, enforcement }) {
  const dims = [];

  // 1. Clinical Maturity — based on highest trial phase reached and active trial count
  let clinicalScore, clinicalNote;
  if (ct.ok && ct.studies.length) {
    const phaseText = ct.studies.map(s => s.phase || '').join(' ');
    const hasPhase4 = /4/.test(phaseText);
    const hasPhase3 = /3/.test(phaseText);
    const activeCount = ct.studies.filter(s => /recruit|active|enrolling/i.test(s.status || '')).length;
    clinicalScore = hasPhase4 ? 95 : hasPhase3 ? 75 : 45;
    clinicalNote = `${ct.totalCount} matching trial(s); highest phase signal: ${hasPhase4 ? '4 (marketed/post-approval studies)' : hasPhase3 ? '3' : '<3'}; ${activeCount} currently active/recruiting (ClinicalTrials.gov)`;
  } else if (ct.ok) {
    clinicalScore = 15;
    clinicalNote = 'No matching trials found on ClinicalTrials.gov — limited clinical evidence trail.';
  } else {
    clinicalScore = 0;
    clinicalNote = `ClinicalTrials.gov unavailable (${ct.error})`;
  }
  dims.push({ key: 'clinical', label: 'Clinical Maturity', score: clinicalScore, note: clinicalNote, ok: ct.ok });

  // 2. Regulatory Status — based on Drugs@FDA application/marketing status
  let regScore, regNote;
  if (fda.ok && fda.applications.length) {
    const marketed = fda.applications.some(a => a.products.some(p => /prescription|over.the.counter|otc/i.test(p.marketingStatus || '')));
    regScore = marketed ? 90 : 55;
    regNote = `${fda.applications.length} FDA application record(s); marketing status ${marketed ? 'active' : 'pending or unclear'} (Drugs@FDA)`;
  } else if (fda.ok) {
    regScore = 20;
    regNote = 'No FDA application records found — no established regulatory foothold in this dataset.';
  } else {
    regScore = 0;
    regNote = `Drugs@FDA unavailable (${fda.error})`;
  }
  dims.push({ key: 'regulatory', label: 'Regulatory Status', score: regScore, note: regNote, ok: fda.ok });

  // 3. IP Runway — based on recency of matching patents
  let ipScore, ipNote;
  if (patents.ok && patents.patents.length) {
    const years = patents.patents.map(p => parseInt((p.date || '').slice(0, 4), 10)).filter(y => !Number.isNaN(y));
    const newest = years.length ? Math.max(...years) : null;
    const age = newest ? new Date().getFullYear() - newest : null;
    ipScore = age === null ? 50 : age <= 5 ? 85 : age <= 10 ? 60 : 35;
    ipNote = `${patents.patents.length} matching patent(s); most recent granted ${newest ?? 'N/A'} (USPTO/PatentsView)`;
  } else if (patents.ok) {
    ipScore = 30;
    ipNote = 'No matching patents found — IP protection for this asset is unclear from this dataset.';
  } else {
    ipScore = null; // genuinely unknown — missing API key, not a real "0"
    ipNote = `USPTO data unavailable (${patents.error})`;
  }
  dims.push({ key: 'ip', label: 'IP Runway', score: ipScore, note: ipNote, ok: patents.ok });

  // 4. Safety Profile — based on FAERS report volume, penalized by Class I recalls
  let safetyScore, safetyNote;
  const hasClassIRecall = enforcement.ok && (enforcement.recalls || []).some(r => /^I$/i.test((r.classification || '').trim()));
  if (faers.ok) {
    const totalReports = (faers.reactions || []).reduce((s, r) => s + (r.count || 0), 0);
    let base = totalReports > 5000 ? 50 : totalReports > 500 ? 70 : 90;
    safetyScore = Math.max(0, base - (hasClassIRecall ? 40 : 0));
    safetyNote = `${totalReports.toLocaleString()} total ADR report(s) across top reaction terms (FAERS)${hasClassIRecall ? '; Class I recall on record (FDA Enforcement)' : ''}`;
  } else {
    safetyScore = 50;
    safetyNote = `FAERS unavailable (${faers.error}) — safety dimension defaulted to neutral midpoint, treat with caution.`;
  }
  dims.push({ key: 'safety', label: 'Safety Profile', score: safetyScore, note: safetyNote, ok: faers.ok });

  // 5. Evidence Base — based on recent PubMed literature volume
  let evidenceScore, evidenceNote;
  if (pubmed.ok) {
    const n = (pubmed.papers || []).length;
    evidenceScore = n >= 5 ? 85 : n >= 2 ? 60 : n === 1 ? 40 : 20;
    evidenceNote = `${n} recent PubMed article(s) identified (PubMed)`;
  } else {
    evidenceScore = null;
    evidenceNote = `PubMed unavailable (${pubmed.error})`;
  }
  dims.push({ key: 'evidence', label: 'Evidence Base', score: evidenceScore, note: evidenceNote, ok: pubmed.ok });

  // 6. Field Action Risk — based on FDA Enforcement recall history
  let riskScore, riskNote;
  if (enforcement.ok) {
    const n = (enforcement.recalls || []).length;
    riskScore = n === 0 ? 95 : n <= 2 ? 60 : 30;
    riskNote = `${n} recall/field action record(s) on file (FDA Enforcement)`;
  } else {
    riskScore = null;
    riskNote = `FDA Enforcement data unavailable (${enforcement.error})`;
  }
  dims.push({ key: 'risk', label: 'Field Action Risk', score: riskScore, note: riskNote, ok: enforcement.ok });

  const scored = dims.filter(d => typeof d.score === 'number');
  const overall = scored.length ? Math.round(scored.reduce((s, d) => s + d.score, 0) / scored.length) : null;
  const band = overall === null ? 'INSUFFICIENT DATA' : overall >= 75 ? 'GO' : overall >= 55 ? 'CAUTION' : 'NO-GO';
  const coverage = `${scored.length}/${dims.length} dimensions scored from live data`;

  return { dims, overall, band, coverage };
}

function buildLaunchAppendix(launchScore) {
  const lines = [];
  lines.push('\n=== LAUNCH READINESS SCORECARD (pre-computed deterministically from the live feeds above — do not recompute or contradict these numbers) ===');
  lines.push(`Overall: ${launchScore.overall === null ? 'N/A' : launchScore.overall + '/100'} — Band: ${launchScore.band} (${launchScore.coverage})`);
  launchScore.dims.forEach(d => {
    lines.push(`- ${d.label}: ${d.score === null ? 'N/A' : d.score + '/100'} — ${d.note}`);
  });
  lines.push('Treat this scorecard as ground truth. Your job in the report is to explain WHY each dimension scored as it did (citing the feed in parentheses), not to assign your own numbers. A dimension marked N/A means that data source was unavailable — say so explicitly rather than guessing a score.');
  return lines.join('\n');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { prompt, drug, reportType } = req.body || {};

  if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

  try {
    let finalPrompt = prompt;
    let sources = null;
    let clientData = null;
    let launchScore = null;

    if (drug) {
      const [ct, faers, fda, patents, pubmed, enforcement] = await Promise.all([
        fetchClinicalTrials(drug),
        fetchFAERS(drug),
        fetchDrugsFDA(drug),
        fetchPatents(drug),
        fetchPubMed(drug),
        fetchEnforcement(drug)
      ]);

      const bundle = { ct, faers, fda, patents, pubmed, enforcement };
      finalPrompt = `${buildDataAppendix(bundle)}\n\n${prompt}`;
      sources = sourcesSummary(bundle);
      clientData = buildClientData(bundle);

      if (reportType === 'launch') {
        launchScore = computeLaunchReadiness(bundle);
        finalPrompt = `${finalPrompt}\n\n${buildLaunchAppendix(launchScore)}`;
      }
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: reportType === 'launch' ? 2400 : 2000,
        messages: [{ role: 'user', content: finalPrompt }]
      })
    });

    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });

    const reportCount = await bumpReportCounter();

    return res.status(200).json({ text: data.content[0].text, sources, data: clientData, launchScore, reportCount });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
