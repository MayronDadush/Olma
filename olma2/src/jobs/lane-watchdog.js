'use strict';
// External watchdog for wedged session lanes — the fast half of the fix that
// jobs/unanswered.js only cushions.
//
// The gateway's own recovery declines for ever when lastProgressAgeMs is
// undefined (it answers keep_lane every tick, and lowering
// stuckSessionAbortMs does not help — the staleness test short-circuits
// first). So: detect from the gateway's own log, the same philosophy as
// channels/sessions.js, and act with the narrowest RPC it exposes —
// sessions.abort on that ONE session key. No restart, nobody else
// disturbed. Separate from checkin.js for the same reason unanswered.js is.
//
// Order of defence: ~90s this frees the lane; 3-45m unanswered.js answers a
// message that was dropped outright. docs/incidents.md, "Wedged session
// lanes (the live bug v2 works around)".
const fs = require('node:fs');
const path = require('node:path');
const audit = require('../domain/audit');
const flags = require('../domain/flags');
const sessions = require('../channels/sessions');

// The gateway declares a session stuck at stuckSessionWarnMs (30s here) and
// attempts its own recovery at stuckSessionAbortMs (75s). We only act after it
// has both classified the lane stuck AND explicitly declined to free it, so
// this floor is strictly more conservative than the gateway's own abort — a
// legitimately slow run (local voice transcription is ~37s with no progress
// events) is never in scope.
const DEFAULT_MIN_AGE_MS = 90_000;

// One abort per lane per cooldown: if a lane wedges again immediately, that is
// a different problem and repeated aborts would only hide it.
const COOLDOWN_MS = 10 * 60_000;

// How recent a log observation has to be to still describe the lane as it is
// NOW. The tail we read can span hours on a quiet box, and the log keeps every
// line: without this, one lane that wedged and was freed this morning stays
// "wedged" for the rest of the day, and every time the cooldown lapses the
// watchdog aborts it again — on a lane that by then may be carrying a live
// reply. Lines with no timestamp (plain journald text) are exempt; there is
// nothing to judge them by.
const MAX_EVENT_AGE_MS = 15 * 60_000;

// Beyond this many aborts in an hour something systemic is wrong. Stop acting
// and file an issue instead — a watchdog that silently papers over a melting
// system is worse than one that stops and says so.
const HOURLY_CAP = 6;

const LOG_DIR = process.env.OLMA_OPENCLAW_LOG_DIR || '/tmp/openclaw';
const TAIL_BYTES = 512 * 1024;

// ---- log reading ------------------------------------------------------------

function todayLogPath(now, dir = LOG_DIR) {
  const d = new Date(now);
  const stamp = d.toISOString().slice(0, 10);
  return path.join(dir, `openclaw-${stamp}.log`);
}

// Only the tail matters and the file grows to megabytes, so never read it whole.
function readTail(file, bytes = TAIL_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* already gone */ }
  }
}

// ---- parsing (pure) ---------------------------------------------------------

const FIELD = (name, text) => {
  const m = new RegExp(`${name}=([^\\s]+)`).exec(text);
  return m ? m[1] : null;
};

// The gateway writes two lines we care about, both through its diagnostic
// logger, both carrying sessionKey:
//
//   stuck session: sessionId=… sessionKey=… state=processing age=148s
//     queueDepth=3 reason=queued_work_without_active_run …
//   stuck session recovery outcome: status=skipped action=keep_lane
//     sessionId=… sessionKey=… activeWorkKind=embedded_run reason=…
//
// The first carries the age, the second carries the verdict — a lane is only
// wedged for our purposes when both are true of it.
function parseEvents(raw) {
  const stuck = new Map();   // sessionKey -> {ageMs, queueDepth, at}
  const declined = new Set();

  for (const line of String(raw).split('\n')) {
    if (!line.trim()) continue;
    let msg = line, at = null;
    // The file is JSON lines; journald-style plain text is accepted too so the
    // same parser can be pointed at either.
    if (line.startsWith('{')) {
      try {
        const o = JSON.parse(line);
        msg = String(o.message || '');
        at = o.time || null;
      } catch { continue; }
    }
    if (!msg.startsWith('stuck session')) continue;

    const key = FIELD('sessionKey', msg);
    if (!key || key === 'unknown') continue;

    if (msg.startsWith('stuck session recovery outcome:')) {
      // "skipped" is the gateway telling us it will not free this lane.
      if (FIELD('status', msg) === 'skipped') declined.add(key);
      continue;
    }
    if (msg.startsWith('stuck session:')) {
      const age = FIELD('age', msg);
      const qd = FIELD('queueDepth', msg);
      const ageMs = age ? Number(String(age).replace(/s$/, '')) * 1000 : 0;
      const prev = stuck.get(key);
      // keep the worst observation in the window
      if (!prev || ageMs > prev.ageMs) {
        stuck.set(key, { ageMs, queueDepth: Number(qd || 0), at });
      }
    }
  }

  const out = [];
  for (const [key, v] of stuck) {
    if (!declined.has(key)) continue;      // the gateway is still trying — leave it alone
    out.push({ sessionKey: key, ...v });
  }
  return out;
}

// A lane is only worth acting on when someone is actually waiting behind it.
// queueDepth 0 means nothing is queued: the lane may be untidy, but no message
// is being withheld from anyone, and aborting would be pure risk for no gain.
function pickWedged(events, minAgeMs = DEFAULT_MIN_AGE_MS, now = null) {
  return events.filter((e) => {
    if (!(e.queueDepth > 0 && e.ageMs >= minAgeMs)) return false;
    if (now == null || !e.at) return true;
    const seenAt = Date.parse(e.at);
    return Number.isNaN(seenAt) || now - seenAt <= MAX_EVENT_AGE_MS;
  });
}

// A turn that ran to the end and put nothing on the wire. The gateway says so
// in one line, naming the message it swallowed:
//
//   visible channel turn dispatched with no queued reply payloads:
//     channel=whatsapp messageId=… sessionKey=… cause=completed
//
// This is the only unambiguous "this person wrote and got nothing" the box
// produces, and until 2026-09-05 nothing read it. Yahav's third message that
// evening — "תזכיר לי מחר ב19:00 להתקשר למלי" — is the whole of its history
// here: three tool calls timed out against a brokerd that was mid-deploy, the
// model produced no text, and the line went into the log unread. He was
// answered only because a check-in rung fired two seconds later and happened
// to ask about the same person.
//
// Its lane was never `stuck` by the gateway's definition (queueAhead=0, one
// active run ahead of it), so nothing above this line could have seen it —
// worth stating plainly, because the first fix proposed for that incident was
// lowering DEFAULT_MIN_AGE_MS, which would have changed nothing and made a
// legitimately slow run likelier to be aborted.
//
// Parsed here, beside the other reader of this file; acted on in
// jobs/unanswered.js, which owns the repair and its cooldown.
function parseDroppedTurns(raw) {
  const out = [];
  for (const line of String(raw || '').split('\n')) {
    if (!line.startsWith('{')) continue;   // readTail slices mid-line
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const msg = String(o.message || '');
    if (!msg.includes('no queued reply payloads')) continue;
    const key = FIELD('sessionKey', msg);
    const messageId = FIELD('messageId', msg);
    const at = Date.parse(o.time || '');
    if (!key || key === 'unknown' || !messageId || Number.isNaN(at)) continue;
    out.push({
      sessionKey: key, messageId, at,
      channel: FIELD('channel', msg), cause: FIELD('cause', msg),
    });
  }
  return out;
}

// ---- the sweep --------------------------------------------------------------

async function recentAbortCount(client, sinceInterval) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS n FROM audit_log
     WHERE event = 'lane.watchdog_abort' AND created_at > now() - $1::interval`,
    [sinceInterval]
  );
  return rows[0].n;
}

async function abortedRecently(client, sessionKey) {
  const { rows } = await client.query(
    `SELECT 1 FROM audit_log
     WHERE event = 'lane.watchdog_abort'
       AND detail->>'sessionKey' = $1
       AND created_at > now() - make_interval(secs => $2)
     LIMIT 1`,
    [sessionKey, COOLDOWN_MS / 1000]
  );
  return Boolean(rows[0]);
}

// deps.abort({agentId, key}) -> {ok, error?}   (injected; production uses
// channels/openclaw.abortSessionLane, tests a recorder)
// deps.readLog() -> raw log text               (injected for the same reason)
async function sweepLaneWatchdog(client, deps = {}) {
  const now = deps.now || Date.now();
  const read = deps.readLog || (() => readTail(todayLogPath(now)));
  const minAge = Number(await flags.getFlag(client, 'lane_watchdog_min_age_ms') ?? DEFAULT_MIN_AGE_MS);

  const wedged = pickWedged(parseEvents(read()), minAge, now);
  if (wedged.length === 0) return { wedged: 0, aborted: [] };

  const hourly = await recentAbortCount(client, '1 hour');
  if (hourly >= HOURLY_CAP) {
    const guard = require('./config-guard');
    await guard.fileViolations(client, [
      `session lanes are wedging repeatedly — ${hourly} watchdog aborts in the last hour, cap ${HOURLY_CAP} reached; watchdog paused`,
    ]);
    return { wedged: wedged.length, aborted: [], capped: true };
  }

  const aborted = [];
  for (const w of wedged) {
    if (await abortedRecently(client, w.sessionKey)) continue;

    const parsed = sessions.parseKey(w.sessionKey);
    if (!parsed) continue;

    // Attribute it to the person whose conversation this is, so the abort
    // shows up on their row in the dashboard rather than as a faceless event.
    let userId = null;
    if (parsed.peer && /^\+\d{7,15}$/.test(parsed.peer)) {
      const { rows } = await client.query(`SELECT id FROM users WHERE phone = $1`, [parsed.peer]);
      userId = rows[0] ? rows[0].id : null;
    }

    const res = await deps.abort({ agentId: parsed.agentId, key: w.sessionKey });

    // Recorded on both outcomes: a failing abort is the case we most need to
    // see, and without a row the cooldown could not hold it back either.
    await audit.record(client, userId, 'lane.watchdog_abort', {
      sessionKey: w.sessionKey,
      agentId: parsed.agentId,
      ageSeconds: Math.round(w.ageMs / 1000),
      queueDepth: w.queueDepth,
      ok: Boolean(res && res.ok),
      error: res && res.ok ? null : String((res && res.error) || 'unknown').slice(0, 200),
    });
    if (res && res.ok) aborted.push(w.sessionKey);
  }
  return { wedged: wedged.length, aborted };
}

module.exports = {
  sweepLaneWatchdog, parseEvents, pickWedged, parseDroppedTurns, todayLogPath, readTail,
  DEFAULT_MIN_AGE_MS, COOLDOWN_MS, HOURLY_CAP, MAX_EVENT_AGE_MS,
};
