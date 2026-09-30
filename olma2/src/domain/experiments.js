'use strict';
// A/B tests on what Olma says and when (owner, 2026-09-30: "which message,
// and when, works best"). Two variants per experiment, never more: at ~30
// weekly active people a third arm splits the little there is into nothing.
//
// Assignment is a hash of the experiment key and the person's id, so a person
// sees the same variant on every visit and across restarts, and nothing is
// stored to get it. Exposure is an audit row (`experiment.exposed`, one per
// person per experiment — `expose` checks first), and the outcome is whatever
// the experiment's own SQL says happened after it. Nothing here sends
// anything.
//
// Ending one is the owner's call, from the admin page ("לקבע"): the chosen
// variant goes into the `experiments` flag, everybody gets it from then on,
// and no new exposure is recorded. The page never declares a winner on its
// own — with these numbers most differences are noise, and it says so.
const crypto = require('node:crypto');
const flags = require('./flags');
const audit = require('./audit');

const FLAG = 'experiments';
const EXPOSED = 'experiment.exposed';

// `converted` is a boolean SQL expression over `e.uid` (who was exposed) and
// `e.at` (when first). Outcomes are counted only for an exposure old enough
// for its window to have closed; the rest are shown as still open.
const EXPERIMENTS = {
  invite_card_moment: {
    title: 'מתי מופיע כרטיס ההזמנה בדף האישי',
    variants: {
      a: 'תמיד',
      b: 'רק אחרי רגע טוב — תיאום שנסגר או משימה שהושלמה ב־48 השעות האחרונות',
    },
    exposure: 'פתחו את הדף שלהם בזמן הניסוי (בשתי הקבוצות — גם מי שלא ראה כרטיס)',
    outcome: 'לחצו על "שליחה בוואטסאפ" או "העתקת ההודעה" תוך 7 ימים',
    windowDays: 7,
    converted: `EXISTS (SELECT 1 FROM audit_log o WHERE o.actor_id = e.uid
                  AND o.event = 'referral.shared'
                  AND o.created_at BETWEEN e.at AND e.at + interval '7 days')`,
  },
};

function variantFor(key, userId) {
  const h = crypto.createHash('sha256').update(`${key}:${userId}`).digest();
  return (h[0] & 1) ? 'b' : 'a';
}

async function winners(client) {
  const v = await flags.getFlag(client, FLAG);
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

// Which variant this person gets, and whether the experiment is still
// running. An unknown key is a bug in the caller, so it throws.
async function assign(client, key, userId) {
  const exp = EXPERIMENTS[key];
  if (!exp) throw new Error(`unknown experiment: ${key}`);
  const locked = (await winners(client))[key];
  if (locked && Object.hasOwn(exp.variants, locked)) return { variant: locked, running: false };
  return { variant: variantFor(key, userId), running: true };
}

// Assign and, while it runs, record the exposure once. Returns the variant.
async function expose(client, key, userId, detail = {}) {
  const a = await assign(client, key, userId);
  if (!a.running || !userId) return a.variant;
  const { rows } = await client.query(
    `SELECT 1 FROM audit_log WHERE actor_id = $1 AND event = $2 AND detail->>'exp' = $3 LIMIT 1`,
    [userId, EXPOSED, key]);
  if (!rows[0]) await audit.record(client, userId, EXPOSED, { ...detail, exp: key, variant: a.variant });
  return a.variant;
}

async function lock(client, key, variant) {
  const exp = EXPERIMENTS[key];
  if (!exp || (variant !== null && !Object.hasOwn(exp.variants, variant))) return false;
  const next = { ...(await winners(client)) };
  if (variant === null) delete next[key]; else next[key] = variant;
  await flags.setFlag(client, FLAG, next);
  await audit.record(client, null, 'admin.experiment_locked', { exp: key, variant });
  return true;
}

// Two-proportion z-test, two-sided. Returns p, or null when it cannot be
// computed.
function pValue(x1, n1, x2, n2) {
  if (!n1 || !n2) return null;
  const p = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (!se) return null;
  const z = Math.abs(x1 / n1 - x2 / n2) / se;
  // Abramowitz-Stegun 26.2.17 for the normal tail.
  const t = 1 / (1 + 0.2316419 * z);
  const d = Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI);
  const tail = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return 2 * tail;
}

// The rule the page applies before it says anything but "too early": each
// arm has at least MIN_DONE finished exposures and the difference clears
// p < 0.05.
const MIN_DONE = 30;
function verdict(arms) {
  const [a, b] = arms;
  if (!a || !b || a.done < MIN_DONE || b.done < MIN_DONE) return { call: 'early', p: null };
  const p = pValue(a.converted, a.done, b.converted, b.done);
  if (p === null || p >= 0.05) return { call: 'no_difference', p };
  return { call: a.converted / a.done > b.converted / b.done ? 'a' : 'b', p };
}

async function results(client, key) {
  const exp = EXPERIMENTS[key];
  const { rows } = await client.query(
    `WITH e AS (
       SELECT a.actor_id AS uid, a.detail->>'variant' AS variant, min(a.created_at) AS at
         FROM audit_log a JOIN users u ON u.id = a.actor_id
        WHERE a.event = $1 AND a.detail->>'exp' = $2 AND NOT u.is_eval AND NOT u.is_test
        GROUP BY 1, 2)
     SELECT e.variant,
            count(*)::int AS exposed,
            count(*) FILTER (WHERE e.at <= now() - make_interval(days => $3))::int AS done,
            count(*) FILTER (WHERE e.at <= now() - make_interval(days => $3) AND ${exp.converted})::int AS converted
       FROM e GROUP BY e.variant`,
    [EXPOSED, key, exp.windowDays]);
  const arms = ['a', 'b'].map((v) => {
    const r = rows.find((x) => x.variant === v) || { exposed: 0, done: 0, converted: 0 };
    return { variant: v, label: exp.variants[v], exposed: r.exposed, done: r.done, converted: r.converted };
  });
  return { key, ...exp, arms, verdict: verdict(arms), locked: (await winners(client))[key] || null };
}

module.exports = { EXPERIMENTS, FLAG, EXPOSED, MIN_DONE, variantFor, assign, expose, lock, results, pValue, verdict };
