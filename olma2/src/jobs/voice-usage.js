'use strict';
// Records what every voice call actually cost, per call, per user — built
// 2026-08-31 for the pricing-model question ("כמה עולה לי דקת שיחה?"), which
// until now could only be answered by reading provider balances by hand.
//
// Twilio is the one meter that reports an authoritative per-call price, and
// it reports it LATE: a call's `price` is null for the first minutes after
// it ends, then settles. So this sweep re-reads the recent call list every
// tick and upserts — a row is complete only once twilio_usd is non-null,
// and re-upserting the same sid is how the price back-fills. The other
// three meters (Deepgram STT, Cartesia TTS, the LLM) publish no per-call
// figure at all; their share is estimated per minute at the DASHBOARD, from
// measured rates, and stays labelled an estimate — this table stores only
// what a provider actually said.
//
// Fifty calls per tick is deliberate paging-free laziness: at the current
// volume (~20 calls on the busiest day yet) one page covers days, and a
// price that has not settled within a page's worth of newer calls is not
// going to. If volume ever grows past that, the sweep starts missing tails
// — the count is in the heartbeat note so the growth is visible first.
const PAGE_SIZE = 50;

async function fetchRecentCalls(sid, token, doFetch) {
  const auth = 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64');
  const res = await doFetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json?PageSize=${PAGE_SIZE}`,
    { headers: { Authorization: auth } }
  );
  if (!res.ok) throw new Error(`twilio calls list: http ${res.status}`);
  const body = await res.json();
  return body.calls || [];
}

async function sweepVoiceUsage(client, deps = {}) {
  const sid = deps.sid || process.env.TWILIO_SID;
  const token = deps.token || process.env.TWILIO_TOKEN;
  if (!sid || !token) return { skipped: 'twilio not configured' };

  const calls = await fetchRecentCalls(sid, token, deps.fetch || fetch);
  let upserted = 0, priced = 0;
  for (const c of calls) {
    if (!c.sid) continue;
    // Twilio reports price as a negative string ("-0.19380"); stored as the
    // positive amount spent. null stays null — "not settled yet", not free.
    const usd = c.price == null ? null : Math.abs(Number(c.price));
    const started = c.start_time ? new Date(c.start_time) : null;
    const { rowCount } = await client.query(
      `INSERT INTO voice_usage_ledger (call_sid, user_id, phone, status, started_at, duration_sec, twilio_usd)
       VALUES ($1, (SELECT id FROM users WHERE phone = $2), $2, $3, $4, $5, $6)
       ON CONFLICT (call_sid) DO UPDATE
         SET status = EXCLUDED.status,
             duration_sec = EXCLUDED.duration_sec,
             twilio_usd = COALESCE(EXCLUDED.twilio_usd, voice_usage_ledger.twilio_usd),
             updated_at = now()
       WHERE voice_usage_ledger.status IS DISTINCT FROM EXCLUDED.status
          OR voice_usage_ledger.duration_sec IS DISTINCT FROM EXCLUDED.duration_sec
          OR (EXCLUDED.twilio_usd IS NOT NULL
              AND voice_usage_ledger.twilio_usd IS DISTINCT FROM EXCLUDED.twilio_usd)`,
      [c.sid, c.to || '', c.status || '', started, Number(c.duration) || 0, usd]
    );
    if (rowCount) upserted++;
    if (usd != null) priced++;
  }
  return { seen: calls.length, upserted, priced };
}

module.exports = { sweepVoiceUsage, PAGE_SIZE };
