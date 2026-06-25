// api/feedback.js
//
// PharmaSignal AI — user feedback (thumbs up / down) on a generated report.
//
// POST { vote: "up" | "down" } increments a public, keyless hit counter
// (abacus.jasoncameron.dev) under namespace ABACUS_NS and returns the
// updated { up, down } tally. There is no database and no auth here by
// design — this is meant to be a transparent, lightweight public counter,
// not a moderated feedback system. Anyone can read the current tally via
// GET /api/metrics. Expect these numbers to be honestly close to zero until
// the app has real visitors — that's reported as-is rather than padded.

const ABACUS_NS = 'pharmasignal-ai-v1';

function withTimeout(promise, ms = 6000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), ms))
  ]);
}

async function hit(key) {
  const r = await withTimeout(fetch(`https://abacus.jasoncameron.dev/hit/${ABACUS_NS}/${key}`));
  if (!r.ok) throw new Error(`Counter service HTTP ${r.status}`);
  const data = await r.json();
  return typeof data.value === 'number' ? data.value : null;
}

async function get(key) {
  try {
    const r = await withTimeout(fetch(`https://abacus.jasoncameron.dev/get/${ABACUS_NS}/${key}`));
    if (!r.ok) return null;
    const data = await r.json();
    return typeof data.value === 'number' ? data.value : null;
  } catch (e) {
    return null;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { vote } = req.body || {};
  if (vote !== 'up' && vote !== 'down') {
    return res.status(400).json({ error: 'vote must be "up" or "down"' });
  }

  try {
    const newValue = await hit(vote === 'up' ? 'feedback-up' : 'feedback-down');
    const otherKey = vote === 'up' ? 'feedback-down' : 'feedback-up';
    const otherValue = await get(otherKey);

    return res.status(200).json({
      up: vote === 'up' ? newValue : otherValue,
      down: vote === 'down' ? newValue : otherValue
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
