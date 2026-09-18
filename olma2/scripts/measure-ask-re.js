'use strict';
// Does a wider `reminder-promise.ASK_RE` earn its place? Read-only, and it
// prints COUNTS ONLY.
//
//   node olma2/scripts/measure-ask-re.js        (on the box; `ops.sh measure-ask-re`)
//
// Why it exists: Miron asked "תוסיף תזכורת ליום שלישי ב-9 וחצי …" on
// 2026-09-17, the 9:30 was filed as `due_at`, the automatic reminder armed an
// hour early, and `promise_watch` — the job whose entire purpose is to ask
// whether the moment they named is the moment that got armed — never judged
// the message, because `ASK_RE`'s noun alternative wants a digit straight
// after the ל and "תזכורת **ליום** שלישי" puts a word there.
//
// Widening it is not a free win. `rules/detectors.md`: a hint that fires on
// ordinary input is worse than no hint, and a new pattern is measured against
// real data before it ships — `tasks.joinsTwoAsks` was checked against all 202
// production titles before it was allowed out. This is that measurement.
//
// ── Why there is no message text in the output ──────────────────────────────
// It runs through `ops.sh`, whose menu is closed precisely so that nothing it
// prints is a person's message, name or number, and whose output lands in a
// GitHub Actions log. So the messages the candidate ADDS are classified HERE,
// on the box, and only the counts travel. The classifications are proxies for
// the question a person would answer by eye, and they are deliberately crude:
// a cancel is not a request, and a question is usually not one either.
//
// If the counts are ambiguous the eyeball pass is still available — but it has
// to happen over somebody's own ssh, never through this workflow.
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const { createPool } = require(path.join(ROOT, 'src/db/pool'));
const sessions = require(path.join(ROOT, 'src/channels/sessions-async'));
const { ASK_RE, momentsAsked } = require(path.join(ROOT, 'src/domain/reminder-promise'));

// The proposal: "תזכורת" followed, within one clause, by ל/ב and a digit.
// That is the shape the current second alternative misses.
const CANDIDATE = /תזכיר(י)?\s+ל[יינו]|תזכורת[^.?\n]{0,40}?[בל]-?\s*\d|remind\s+me|set\s+a\s+reminder/i;

// Proxies for "a person would call this a false positive". Undoing a reminder
// is the one that worried me when I wrote the pattern.
const CANCEL_SHAPED = /תבטל|לבטל|בטל\s|תסיר|להסיר|תמחק|למחוק|תפסיק|להפסיק/;

const PER_USER = 120;

async function main() {
  const pool = createPool();
  const client = await pool.connect();
  const n = {
    users: 0, unreadable: 0, messages: 0,
    current: 0, candidate: 0, added: 0,
    addedCancelShaped: 0, addedQuestion: 0, addedHalfPast: 0, addedNoHourFound: 0,
  };
  try {
    const { rows: users } = await client.query(
      `SELECT id, phone, agent_id, timezone
         FROM users
        WHERE agent_id IS NOT NULL AND NOT is_eval AND status = 'active'
        ORDER BY id`
    );
    n.users = users.length;
    for (const u of users) {
      let msgs;
      try {
        msgs = (await sessions.readRecentMessages(u.agent_id, PER_USER, undefined, u.phone)) || [];
      } catch {
        // Could not READ is never a thing in trouble, and it is never silence
        // either: counted, so a roster half of which is unreadable cannot look
        // like a clean measurement.
        n.unreadable++;
        continue;
      }
      for (const m of msgs) {
        if (m.role !== 'user' || !m.text) continue;
        const text = String(m.text);
        if (/^DELIVERY:/.test(text)) continue;
        n.messages++;
        const now = ASK_RE.test(text);
        const next = CANDIDATE.test(text);
        if (now) n.current++;
        if (next) n.candidate++;
        if (!next || now) continue;
        n.added++;
        if (CANCEL_SHAPED.test(text)) n.addedCancelShaped++;
        if (text.includes('?')) n.addedQuestion++;
        // "9 וחצי" is 09:00 to `momentsAsked`, not 09:30 — the SECOND gap,
        // and the reason a fired detector could still name the wrong hour.
        if (/וחצי/.test(text)) n.addedHalfPast++;
        if (![...momentsAsked(text, Date.parse(m.at), u.timezone)].length) n.addedNoHourFound++;
      }
    }
  } finally {
    client.release();
    await pool.end();
  }

  console.log('== ASK_RE candidate measurement (counts only, by design) ==');
  console.log(`users read                : ${n.users}`);
  console.log(`transcripts unreadable    : ${n.unreadable}`);
  console.log(`inbound messages examined : ${n.messages}`);
  console.log('');
  console.log(`current ASK_RE fires on   : ${n.current}`);
  console.log(`candidate fires on        : ${n.candidate}`);
  console.log(`ADDED by the candidate    : ${n.added}`);
  console.log('');
  console.log('of the added:');
  console.log(`  cancel-shaped (likely wrong) : ${n.addedCancelShaped}`);
  console.log(`  a question (likely wrong)    : ${n.addedQuestion}`);
  console.log(`  no hour found at all         : ${n.addedNoHourFound}`);
  console.log(`  says "וחצי" (hour off by 30m): ${n.addedHalfPast}`);
  console.log('');
  const suspect = n.addedCancelShaped + n.addedQuestion;
  if (!n.added) {
    console.log('READ: the candidate adds nothing on real traffic. Do not ship it.');
  } else if (suspect * 2 >= n.added) {
    console.log(`READ: ${suspect} of ${n.added} added look wrong. Narrow the pattern before shipping.`);
  } else {
    console.log(`READ: ${n.added - suspect} of ${n.added} added look like real asks. Worth shipping.`);
  }
  if (n.addedHalfPast) {
    console.log(`AND: ${n.addedHalfPast} of them say "וחצי", which momentsAsked reads as the round hour — widening ASK_RE alone would file those with the wrong hour.`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
