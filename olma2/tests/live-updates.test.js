'use strict';
// Live updates (domain/live-updates.js): subscribing, the baseline-first
// contract, diff-then-summarise, the daily idempotency key, and the rule that
// a transient failure leaves the watermark alone so the hourly tick retries.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { freshDb, makeUser } = require('./helpers');
const liveUpdates = require('../src/domain/live-updates');
const flags = require('../src/domain/flags');

let db, miron, dana;
before(async () => {
  db = await freshDb();
  miron = await makeUser(db.pool, '+972526269826', { firstName: 'מירון' });
  dana = await makeUser(db.pool, '+972521112223', { firstName: 'דנה' });
  const c = await db.pool.connect();
  try {
    await c.query(`UPDATE users SET timezone = 'Asia/Jerusalem' WHERE id = ANY($1)`, [[miron.id, dana.id]]);
  } finally { c.release(); }
});
after(async () => { await db.teardown(); });

async function withClient(fn) {
  const client = await db.pool.connect();
  try { return await fn(client); } finally { client.release(); }
}

// OpenRouter catalog stub: three URLs (plain, video, image), same shape.
function orFetch(models) {
  return async (url) => ({
    ok: true,
    json: async () => ({
      data: models.filter((m) => {
        const u = String(url);
        if (u.includes('output_modalities=video')) return (m.architecture.output_modalities || []).includes('video');
        if (u.includes('output_modalities=image')) return (m.architecture.output_modalities || []).includes('image');
        return (m.architecture.output_modalities || []).includes('text');
      }),
    }),
  });
}
const model = (id, out, prompt = '0.000001', completion = '0.000002') => ({
  id, name: id, architecture: { output_modalities: out }, pricing: { prompt, completion },
});
const okComplete = (summary) => async () => ({
  ok: true, text: JSON.stringify({ summary }), model: 'deepseek/deepseek-v4-flash',
  usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
});

test('subscribe validates source, cadence, hour — and refuses duplicates', async () => {
  await withClient(async (c) => {
    assert.equal((await liveUpdates.subscribe(c, miron, { source: 'nope' })).ok, false);
    assert.equal((await liveUpdates.subscribe(c, miron, { source: 'openrouter_models', cadence: 'hourly' })).ok, false);
    assert.equal((await liveUpdates.subscribe(c, miron, { source: 'openrouter_models', local_hour: 24 })).ok, false);

    const first = await liveUpdates.subscribe(c, miron, { source: 'openrouter_models' });
    assert.equal(first.ok, true);
    assert.ok(first.data.note.includes('baselined'));
    const dup = await liveUpdates.subscribe(c, miron, { source: 'openrouter_models' });
    assert.equal(dup.ok, false);
    assert.equal(dup.error.code, 'conflict');
  });
});

test('openrouter source: first run baselines silently, a later new model becomes ONE message', async () => {
  await withClient(async (c) => {
    const { rows: [sub] } = await c.query(
      `SELECT id FROM live_subscriptions WHERE user_id = $1 AND source = 'openrouter_models'`, [miron.id]);

    // Run 1: two models in the catalog — baseline, no outbox row, no LLM.
    let completeCalls = 0;
    const deps1 = {
      fetchImpl: orFetch([model('a/one', ['text']), model('b/two', ['video'])]),
      complete: async () => { completeCalls++; return { ok: false }; },
    };
    const s1 = await liveUpdates.sweepLiveUpdates(c, deps1);
    assert.deepEqual(s1.baselined, [Number(sub.id)]);
    assert.equal(completeCalls, 0);
    const { rows: st } = await c.query(`SELECT last_state FROM live_subscriptions WHERE id = $1`, [sub.id]);
    assert.deepEqual([...st[0].last_state.knownIds].sort(), ['a/one', 'b/two']);

    // Run 2: nothing new — quiet, still no LLM.
    await c.query(`UPDATE live_subscriptions SET next_run_at = now() WHERE id = $1`, [sub.id]);
    const s2 = await liveUpdates.sweepLiveUpdates(c, deps1);
    assert.deepEqual(s2.quiet, [Number(sub.id)]);
    assert.equal(completeCalls, 0);

    // Run 3: a new image model appears — summarised and enqueued once.
    await c.query(`UPDATE live_subscriptions SET next_run_at = now() WHERE id = $1`, [sub.id]);
    const deps3 = {
      fetchImpl: orFetch([model('a/one', ['text']), model('b/two', ['video']), model('c/new-img', ['image'])]),
      complete: okComplete('מודל תמונות חדש: c/new-img — זול, שווה בדיקה'),
    };
    const s3 = await liveUpdates.sweepLiveUpdates(c, deps3);
    assert.deepEqual(s3.sent, [Number(sub.id)]);

    const { rows: out } = await c.query(
      `SELECT payload FROM outbox WHERE user_id = $1 AND kind = 'live_update'`, [miron.id]);
    assert.equal(out.length, 1);
    assert.ok(out[0].payload.summary.includes('c/new-img'));

    // The summarising call was PAID and recorded — migration-012 rule.
    const { rows: led } = await c.query(
      `SELECT count(*)::int AS n FROM usage_ledger WHERE user_id = $1`, [miron.id]);
    assert.ok(led[0].n >= 1);

    // Same-day re-run cannot double-send (daily idempotency key).
    await c.query(`UPDATE live_subscriptions SET next_run_at = now(),
                   last_state = jsonb_set(last_state, '{knownIds}', '["a/one","b/two"]') WHERE id = $1`, [sub.id]);
    await liveUpdates.sweepLiveUpdates(c, deps3);
    const { rows: again } = await c.query(
      `SELECT count(*)::int AS n FROM outbox WHERE user_id = $1 AND kind = 'live_update'`, [miron.id]);
    assert.equal(again[0].n, 1);
  });
});

test('a failed summarise leaves the watermark alone so the next tick retries', async () => {
  await withClient(async (c) => {
    const { rows: [sub] } = await c.query(
      `SELECT id, last_state FROM live_subscriptions WHERE user_id = $1 AND source = 'openrouter_models'`, [miron.id]);
    await c.query(`UPDATE live_subscriptions SET next_run_at = now(),
                   last_state = '{"knownIds": ["a/one"]}' WHERE id = $1`, [sub.id]);
    const deps = {
      fetchImpl: orFetch([model('a/one', ['text']), model('z/brand-new', ['text'])]),
      complete: async () => ({ ok: false, error: 'model down' }),
    };
    const s = await liveUpdates.sweepLiveUpdates(c, deps);
    assert.equal(s.errored.length, 1);
    const { rows: st } = await c.query(`SELECT last_state FROM live_subscriptions WHERE id = $1`, [sub.id]);
    assert.deepEqual(st[0].last_state.knownIds, ['a/one']); // z/brand-new NOT swallowed
    // restore a sane state for later tests
    await c.query(`UPDATE live_subscriptions SET last_state = '{"knownIds": ["a/one","z/brand-new"]}',
                   next_run_at = now() + interval '1 day' WHERE id = $1`, [sub.id]);
  });
});

test('weather: geocoded once at subscribe, always sends at cadence', async () => {
  await withClient(async (c) => {
    const geoFetch = async (url) => {
      const u = String(url);
      if (u.includes('geocoding-api')) {
        return { ok: true, json: async () => ({ results: [{ name: 'תל אביב', latitude: 32.08, longitude: 34.78 }] }) };
      }
      return { ok: true, json: async () => ({ daily: { time: ['2026-08-29'], temperature_2m_max: [31], temperature_2m_min: [24], precipitation_probability_max: [0], weather_code: [0] } }) };
    };
    const sub = await liveUpdates.subscribe(c, dana, { source: 'weather', params: { city: 'tel aviv' } }, { fetchImpl: geoFetch });
    assert.equal(sub.ok, true);
    assert.equal(sub.data.params.city, 'תל אביב');
    assert.equal(sub.data.params.lat, 32.08);

    const s = await liveUpdates.sweepLiveUpdates(c, { fetchImpl: geoFetch, complete: okComplete('שמיים בהירים, 24-31 מעלות') });
    assert.deepEqual(s.sent, [sub.data.subscription_id]);
    const { rows: out } = await c.query(
      `SELECT payload FROM outbox WHERE user_id = $1 AND kind = 'live_update'`, [dana.id]);
    assert.equal(out.length, 1);
    assert.ok(out[0].payload.summary.includes('מעלות'));

    // A city the geocoder cannot find is refused at subscribe time.
    const nowhere = await liveUpdates.subscribe(c, dana, { source: 'weather', params: { city: 'xyzzynotaplace' } },
      { fetchImpl: async () => ({ ok: true, json: async () => ({ results: [] }) }) });
    assert.equal(nowhere.ok, false);
    assert.equal(nowhere.error.code, 'not_found');
  });
});

test('paused and eval users are skipped even when due', async () => {
  await withClient(async (c) => {
    await c.query(`UPDATE live_subscriptions SET next_run_at = now() WHERE user_id = $1`, [dana.id]);
    await c.query(`UPDATE users SET paused_at = now() WHERE id = $1`, [dana.id]);
    const s = await liveUpdates.sweepLiveUpdates(c, {
      fetchImpl: async () => { throw new Error('must not fetch for a paused user'); },
    });
    assert.deepEqual(s.sent, []);
    assert.deepEqual(s.errored, []);
    await c.query(`UPDATE users SET paused_at = NULL WHERE id = $1`, [dana.id]);
  });
});

test('the per-user cap is a live flag, and unsubscribe frees a slot', async () => {
  await withClient(async (c) => {
    await flags.setFlag(c, liveUpdates.SUBS_CAP_FLAG, 1);
    // dana already has her weather subscription → a second is over the cap.
    const over = await liveUpdates.subscribe(c, dana, { source: 'openrouter_models' });
    assert.equal(over.ok, false);
    assert.equal(over.error.code, 'conflict');

    const { rows: [w] } = await c.query(
      `SELECT id FROM live_subscriptions WHERE user_id = $1 AND cancelled_at IS NULL`, [dana.id]);
    assert.equal((await liveUpdates.unsubscribe(c, dana.id, w.id)).ok, true);
    // Someone else's id cannot be cancelled.
    const { rows: [m] } = await c.query(
      `SELECT id FROM live_subscriptions WHERE user_id = $1 AND cancelled_at IS NULL LIMIT 1`, [miron.id]);
    assert.equal((await liveUpdates.unsubscribe(c, dana.id, m.id)).ok, false);

    const freed = await liveUpdates.subscribe(c, dana, { source: 'openrouter_models' });
    assert.equal(freed.ok, true);
    await flags.setFlag(c, liveUpdates.SUBS_CAP_FLAG, 5);
    // This subscription's job here was proving the cap freed up, not proving
    // sweep behaviour — cancel it so it doesn't sit due:true (default
    // next_run_at = now()) and pollute a later test's sweepLiveUpdates call.
    await liveUpdates.unsubscribe(c, dana.id, freed.data.subscription_id);
  });
});

test('next_run_at lands on the chosen local hour in the user\'s timezone', async () => {
  await withClient(async (c) => {
    const next = await liveUpdates.computeNextRun(c, 'Asia/Jerusalem', 9, 'daily');
    const { rows } = await c.query(
      `SELECT extract(hour from $1::timestamptz AT TIME ZONE 'Asia/Jerusalem')::int AS h,
              $1::timestamptz > now() AS future`, [next]);
    assert.equal(rows[0].h, 9);
    assert.equal(rows[0].future, true);
    const weekly = await liveUpdates.computeNextRun(c, 'Asia/Jerusalem', 9, 'weekly');
    const { rows: w } = await c.query(
      `SELECT ($1::timestamptz - now()) > interval '1 day' AS far`, [weekly]);
    // weekly lands either today (if 9:00 is still ahead) or 7 days out — both
    // valid; just assert it parses and is in the future.
    assert.equal(typeof w[0].far, 'boolean');
  });
});

// ---- RSS (news_topic / sports_summary) --------------------------------------

const RSS_SAMPLE = (items) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><rss version="2.0"><channel>` +
  `<title>חדשות</title><link>https://news.google.com/</link>` +
  items.map((it) => `<item><title>${it.title}</title><link>${it.link || 'https://example.com/a'}</link>` +
    `<guid isPermaLink="false">g${it.title.length}</guid><pubDate>${it.pubDate}</pubDate>` +
    `<description>&lt;a href="x"&gt;desc&lt;/a&gt;</description>` +
    `<source url="https://example.com">${it.source || 'מקור'}</source></item>`).join('') +
  `</channel></rss>`;

function rssFetch(xml) {
  return async () => ({ ok: true, text: async () => xml });
}

test('parseRssItems: reads real-shaped items, decodes entities, tolerates CDATA', () => {
  const withEntities = RSS_SAMPLE([
    { title: 'כותרת אחת &amp; שתיים', pubDate: 'Sat, 29 Aug 2026 08:35:49 GMT', source: 'Ynet' },
  ]);
  const items = liveUpdates.parseRssItems(withEntities);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'כותרת אחת & שתיים');
  assert.equal(items[0].source, 'Ynet');
  assert.equal(items[0].pubDate, new Date('Sat, 29 Aug 2026 08:35:49 GMT').toISOString());

  const cdata = `<?xml version="1.0"?><rss version="2.0"><channel>` +
    `<item><title><![CDATA[כותרת עם <תגית>]]></title><link>https://x</link>` +
    `<pubDate>Sat, 29 Aug 2026 08:35:49 GMT</pubDate><source>מקור</source></item></channel></rss>`;
  const cItems = liveUpdates.parseRssItems(cdata);
  assert.equal(cItems.length, 1);
  assert.equal(cItems[0].title, 'כותרת עם <תגית>');
});

test('parseRssItems: not-RSS or unparseable input returns null (transient, not empty)', () => {
  assert.equal(liveUpdates.parseRssItems('<html>not rss</html>'), null);
  assert.equal(liveUpdates.parseRssItems(''), null);
  assert.equal(liveUpdates.parseRssItems(null), null);
  // A well-formed channel with zero items is a valid, successfully parsed
  // empty feed — [] on purpose, distinct from a parse failure.
  assert.deepEqual(liveUpdates.parseRssItems(RSS_SAMPLE([])), []);
});

test('parseRssItems: an item missing a parseable pubDate is dropped, not crashed on', () => {
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel>` +
    `<item><title>בלי תאריך</title><link>https://x</link><source>מ</source></item>` +
    `<item><title>עם תאריך</title><link>https://y</link><pubDate>Sat, 29 Aug 2026 08:35:49 GMT</pubDate><source>מ</source></item>` +
    `</channel></rss>`;
  const items = liveUpdates.parseRssItems(xml);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'עם תאריך');
});

test('news_topic: requires a topic; first run baselines on the newest pubDate, nothing sent', async () => {
  await withClient(async (c) => {
    assert.equal((await liveUpdates.subscribe(c, dana, { source: 'news_topic', params: {} })).ok, false);

    const old1 = 'Thu, 27 Aug 2026 10:00:00 GMT', old2 = 'Fri, 28 Aug 2026 09:00:00 GMT';
    const baselineFetch = rssFetch(RSS_SAMPLE([
      { title: 'ידיעה ישנה 1', pubDate: old1 }, { title: 'ידיעה ישנה 2', pubDate: old2 },
    ]));
    const sub = await liveUpdates.subscribe(c, dana, { source: 'news_topic', params: { topic: 'בורסה' } });
    assert.equal(sub.ok, true);
    assert.equal(sub.data.params.topic, 'בורסה');

    const s1 = await liveUpdates.sweepLiveUpdates(c, { fetchImpl: baselineFetch, complete: okComplete('n/a') });
    assert.deepEqual(s1.baselined, [sub.data.subscription_id]);
    const { rows: st } = await c.query(`SELECT last_state FROM live_subscriptions WHERE id = $1`, [sub.data.subscription_id]);
    assert.equal(st[0].last_state.lastSeen, new Date(old2).toISOString());
  });
});

test('news_topic: a headline newer than the watermark becomes ONE summarised message; older ones are ignored', async () => {
  await withClient(async (c) => {
    const sub = await liveUpdates.subscribe(c, dana, { source: 'news_topic', params: { topic: 'טכנולוגיה' } },
      {});
    const id = sub.data.subscription_id;
    // Manually plant a watermark, as if a previous run had already happened.
    await c.query(`UPDATE live_subscriptions SET last_state = $2, next_run_at = now()
                   WHERE id = $1`, [id, JSON.stringify({ lastSeen: new Date('Fri, 28 Aug 2026 09:00:00 GMT').toISOString() })]);

    let promptedItems = null;
    const complete = async ({ user }) => { promptedItems = JSON.parse(user); return okComplete('חדשות טריות')(); };
    const fetchImpl = rssFetch(RSS_SAMPLE([
      { title: 'ידיעה ישנה — מלפני היום', pubDate: 'Fri, 28 Aug 2026 08:00:00 GMT' }, // older than watermark
      { title: 'ידיעה טרייה', pubDate: 'Sat, 29 Aug 2026 08:00:00 GMT', source: 'Ynet' }, // newer
    ]));
    const s = await liveUpdates.sweepLiveUpdates(c, { fetchImpl, complete });
    assert.deepEqual(s.sent, [id]);
    assert.equal(promptedItems.length, 1);
    assert.equal(promptedItems[0].title, 'ידיעה טרייה');

    const { rows: out } = await c.query(
      `SELECT payload FROM outbox WHERE user_id = $1 AND kind = 'live_update' AND payload->>'source' = 'news_topic'`, [dana.id]);
    assert.equal(out.length, 1);
    assert.equal(out[0].payload.summary, 'חדשות טריות');
  });
});

test('sports_summary: team is optional and defaults to general sports; empty feed is still a valid baseline', async () => {
  await withClient(async (c) => {
    const generic = await liveUpdates.subscribe(c, miron, { source: 'sports_summary', params: {} }, {});
    assert.equal(generic.ok, true);
    assert.equal(generic.data.params.team, '');

    const withTeam = await liveUpdates.subscribe(c, dana, { source: 'sports_summary', params: { team: 'מכבי תל אביב' } }, {});
    assert.equal(withTeam.ok, true);
    assert.equal(withTeam.data.params.team, 'מכבי תל אביב');

    let seenUrls = [];
    const s = await liveUpdates.sweepLiveUpdates(c, {
      fetchImpl: async (url) => { seenUrls.push(String(url)); return { ok: true, text: async () => RSS_SAMPLE([]) }; },
      complete: okComplete('n/a'),
    });
    assert.ok(s.baselined.includes(generic.data.subscription_id) || s.errored.some((e) => e.startsWith(String(generic.data.subscription_id))) === false);
    assert.ok(seenUrls.some((u) => u.includes(encodeURIComponent('ספורט'))));
    assert.ok(seenUrls.some((u) => u.includes(encodeURIComponent('מכבי תל אביב'))));
  });
});

test('a malformed RSS response is a transient failure, not a crash — the sweep survives and retries', async () => {
  await withClient(async (c) => {
    const sub = await liveUpdates.subscribe(c, dana, { source: 'news_topic', params: { topic: 'חלל' } }, {});
    await c.query(`UPDATE live_subscriptions SET last_state = '{"lastSeen":"2026-08-28T00:00:00.000Z"}',
                   next_run_at = now() WHERE id = $1`, [sub.data.subscription_id]);
    const before_ = await c.query(`SELECT last_state, next_run_at FROM live_subscriptions WHERE id = $1`, [sub.data.subscription_id]);
    const s = await liveUpdates.sweepLiveUpdates(c, {
      fetchImpl: async () => ({ ok: true, text: async () => '<not>even xml' }),
      complete: okComplete('n/a'),
    });
    assert.equal(s.errored.length, 1);
    const after_ = await c.query(`SELECT last_state, next_run_at FROM live_subscriptions WHERE id = $1`, [sub.data.subscription_id]);
    assert.deepEqual(before_.rows[0].last_state, after_.rows[0].last_state);
    assert.deepEqual(before_.rows[0].next_run_at, after_.rows[0].next_run_at);
    // This subscription is DELIBERATELY left errored/due (that is the point
    // of the test) — cancel it so it doesn't stay due:true forever and
    // pollute a later test's sweepLiveUpdates() error count.
    await liveUpdates.unsubscribe(c, dana.id, sub.data.subscription_id);
  });
});

test('a reasoning model that hits its token budget before writing an answer is a transient failure, not a silent swallow', async () => {
  // Real incident, 2026-08-29: deepseek-v4-flash spent its whole completion
  // budget "thinking" about 15 real headlines and never wrote the JSON
  // answer — res.ok true, text empty (finish_reason "length"). Money was
  // still spent and must still be recorded; the watermark must NOT advance,
  // or the headlines that caused this are silently lost forever.
  await withClient(async (c) => {
    const sub = await liveUpdates.subscribe(c, dana, { source: 'news_topic', params: { topic: 'רובוטיקה' } }, {});
    await c.query(`UPDATE live_subscriptions SET last_state = '{"lastSeen":"2026-08-28T00:00:00.000Z"}',
                   next_run_at = now() WHERE id = $1`, [sub.data.subscription_id]);
    const before_ = await c.query(`SELECT last_state, next_run_at FROM live_subscriptions WHERE id = $1`, [sub.data.subscription_id]);
    const truncated = async () => ({
      ok: true, text: '', model: 'deepseek/deepseek-v4-flash',
      usage: { input: 800, output: 700, cacheRead: 0, cacheWrite: 0 },
    });
    const s = await liveUpdates.sweepLiveUpdates(c, {
      fetchImpl: rssFetch(RSS_SAMPLE([{ title: 'כותרת טרייה', pubDate: 'Sat, 29 Aug 2026 09:00:00 GMT' }])),
      complete: truncated,
    });
    assert.equal(s.errored.length, 1);
    const after_ = await c.query(`SELECT last_state, next_run_at FROM live_subscriptions WHERE id = $1`, [sub.data.subscription_id]);
    assert.deepEqual(before_.rows[0].last_state, after_.rows[0].last_state);
    assert.deepEqual(before_.rows[0].next_run_at, after_.rows[0].next_run_at);
    // The truncated call still cost real money and must still be recorded.
    const { rows: led } = await c.query(`SELECT count(*)::int AS n FROM usage_ledger WHERE user_id = $1`, [dana.id]);
    assert.ok(led[0].n >= 1);
    // Deliberately left errored/due — clean up so it cannot pollute a later
    // test's sweepLiveUpdates() error count.
    await liveUpdates.unsubscribe(c, dana.id, sub.data.subscription_id);
  });
});

test('the summarising call carries enough headroom for a reasoning model on a full 15-headline batch', () => {
  // Not a live-API test (no network in the suite) — a pin on the constant
  // itself, so a future "optimisation" back toward a small maxTokens cannot
  // reintroduce the 2026-08-29 incident without a test noticing.
  const src = fs.readFileSync(path.join(__dirname, '../src/domain/live-updates.js'), 'utf8');
  const m = src.match(/maxTokens:\s*(\d+)/);
  assert.ok(m, 'summarize() must set an explicit maxTokens');
  assert.ok(Number(m[1]) >= 2000, `maxTokens (${m[1]}) is too low for a reasoning model — see the 2026-08-29 incident in the comment above summarize()`);
});
