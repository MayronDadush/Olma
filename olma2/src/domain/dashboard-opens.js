'use strict';
// How often people open their own page, and when (owner, 2026-10-06).
//
// An open is a load of /me on a live session — the HTML, not /me/data or
// /me/events, which the same load fetches behind it. A page restored from the
// background on a phone without reloading is not seen, so this counts at
// most what really happened, never more.
//
// Folded to one row per person per half hour: a pull-to-refresh, a tab
// reopened, a sign-in followed by its own redirect are the same visit.
//
// Each open says where it came from (migration 113): `app` is the installed
// app's start address, `link` a /d/ link from WhatsApp, `browser` a bare
// /me. A `browser` load folds into anything recent — it is what the /me
// right after a link IS — while `app` and `link` fold only into their own
// kind, so somebody who taps a link and later opens the app is seen doing
// both.
const SOURCES = new Set(['app', 'link', 'browser']);
//
// The owner opens people's pages from the admin user page, and that session
// is marked (dashboard-auth.createLink's `byAdmin`, migration 112). His
// visits are written too, marked, rather than dropped — so the admin page can
// say how many it left out, and a mark that stopped working shows up as that
// number going to zero instead of as nothing at all.
const FOLD_MINUTES = 30;

async function record(client, userId, { byAdmin = false, source = 'browser' } = {}) {
  const src = SOURCES.has(source) ? source : 'browser';
  const { rowCount } = await client.query(
    `INSERT INTO dashboard_opens (user_id, by_admin, source)
     SELECT $1, $2, $4
      WHERE NOT EXISTS (SELECT 1 FROM dashboard_opens
                         WHERE user_id = $1 AND by_admin = $2
                           AND ($4 = 'browser' OR source = $4)
                           AND opened_at > now() - ($3 || ' minutes')::interval)`,
    [userId, Boolean(byAdmin), String(FOLD_MINUTES), src]);
  return rowCount === 1;
}

// Which door a load of /me came through, off its query alone.
function sourceOf(url) {
  try {
    return new URL(String(url || ''), 'http://x').searchParams.has('hl') ? 'app' : 'browser';
  } catch (_) { return 'browser'; }
}

// Everything the admin section draws, over the last `days`. Eval and test
// accounts are left out of the counts the same way the home page leaves them
// out; the owner's own opens are counted separately and never in the totals.
async function summary(client, { days = 30, tz = 'Asia/Jerusalem' } = {}) {
  const real = `NOT u.is_eval AND NOT u.is_test`;
  const { rows: [totals] } = await client.query(
    `SELECT count(*) FILTER (WHERE NOT o.by_admin AND ${real})::int AS opens,
            count(DISTINCT o.user_id) FILTER (WHERE NOT o.by_admin AND ${real})::int AS people,
            count(*) FILTER (WHERE NOT o.by_admin AND ${real} AND o.opened_at > now() - interval '7 days')::int AS opens7,
            count(DISTINCT o.user_id) FILTER (WHERE NOT o.by_admin AND ${real} AND o.opened_at > now() - interval '7 days')::int AS people7,
            count(*) FILTER (WHERE o.by_admin)::int AS admin_opens,
            count(*) FILTER (WHERE NOT o.by_admin AND NOT (${real}))::int AS test_opens,
            min(o.opened_at) FILTER (WHERE NOT o.backfilled) AS counting_since,
            min(o.opened_at) FILTER (WHERE o.source IS NOT NULL AND NOT o.backfilled) AS source_since
       FROM dashboard_opens o JOIN users u ON u.id = o.user_id
      WHERE o.opened_at > now() - ($1 || ' days')::interval`,
    [String(days)]);
  const { rows: people } = await client.query(
    `SELECT u.id, u.first_name, u.timezone,
            count(*)::int AS opens,
            count(*) FILTER (WHERE o.opened_at > now() - interval '7 days')::int AS opens7,
            count(*) FILTER (WHERE o.backfilled)::int AS backfilled,
            count(*) FILTER (WHERE o.source = 'app')::int AS app,
            count(*) FILTER (WHERE o.source = 'link')::int AS link,
            count(*) FILTER (WHERE o.source = 'browser')::int AS browser,
            min(o.opened_at) AS first_at, max(o.opened_at) AS last_at,
            (array_agg(o.opened_at ORDER BY o.opened_at DESC))[1:5] AS recent
       FROM dashboard_opens o JOIN users u ON u.id = o.user_id
      WHERE o.opened_at > now() - ($1 || ' days')::interval
        AND NOT o.by_admin AND ${real}
      GROUP BY u.id
      ORDER BY max(o.opened_at) DESC`,
    [String(days)]);
  // When in THEIR day — an open at 07:00 in New York is a morning, not
  // 14:00. Backfilled rows are sign-ins, and still a time of day.
  const { rows: byHour } = await client.query(
    `SELECT extract(hour FROM o.opened_at AT TIME ZONE COALESCE(u.timezone, $2))::int AS hour,
            count(*)::int AS n
       FROM dashboard_opens o JOIN users u ON u.id = o.user_id
      WHERE o.opened_at > now() - ($1 || ' days')::interval
        AND NOT o.by_admin AND ${real}
      GROUP BY 1 ORDER BY 1`,
    [String(days), tz]);
  const { rows: byDay } = await client.query(
    `SELECT (o.opened_at AT TIME ZONE $2)::date AS day, count(*)::int AS n,
            count(DISTINCT o.user_id)::int AS people
       FROM dashboard_opens o JOIN users u ON u.id = o.user_id
      WHERE o.opened_at > now() - ($1 || ' days')::interval
        AND NOT o.by_admin AND ${real}
      GROUP BY 1 ORDER BY 1 DESC`,
    [String(days), tz]);
  // Per door, over the same people: opens and heads, in both windows.
  const { rows: bySource } = await client.query(
    `SELECT COALESCE(o.source, 'unknown') AS source,
            count(*)::int AS opens, count(DISTINCT o.user_id)::int AS people,
            count(*) FILTER (WHERE o.opened_at > now() - interval '7 days')::int AS opens7,
            count(DISTINCT o.user_id) FILTER (WHERE o.opened_at > now() - interval '7 days')::int AS people7
       FROM dashboard_opens o JOIN users u ON u.id = o.user_id
      WHERE o.opened_at > now() - ($1 || ' days')::interval
        AND NOT o.by_admin AND ${real}
      GROUP BY 1`,
    [String(days)]);
  // The other half of "who has the app": an iPhone's installed app can only
  // be signed into with a code (dashboard-auth.createCode), and every code
  // sent writes this row — so it is the whole history of that door, from
  // before anything here counted.
  const { rows: [codes] } = await client.query(
    `SELECT count(*)::int AS sent, count(DISTINCT a.actor_id)::int AS people, max(a.created_at) AS last_at
       FROM audit_log a JOIN users u ON u.id = a.actor_id
      WHERE a.event = 'dashboard.code_shortcut' AND ${real}`);
  return { days, totals, people, byHour, byDay, bySource, codes };
}

module.exports = { record, summary, sourceOf, FOLD_MINUTES, SOURCES };
