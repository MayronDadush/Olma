'use strict';
// Drains the outbox. Runs inside brokerd on an interval. FOR UPDATE SKIP
// LOCKED means a second worker (or an overlapping tick) can never double-send
// — the idempotency the whole "nothing is lost, nothing sent twice" promise
// rests on.
const { withTx } = require('../db/pool');
const preferences = require('../domain/preferences');
const quietFacts = require('../domain/quiet-facts');
const pauseDomain = require('../domain/pause');
const quota = require('../domain/quota');
const flagsDomain = require('../domain/flags');
const proactiveText = require('../domain/proactive-text');
const { decide } = require('./gate');
const audit = require('../domain/audit');
const { mergeRoleFor, planMerge, MERGEABLE_KINDS } = require('../domain/message-merge');
const { checkChannels } = require('../adapters/gateway-health');

// A delivery is a full model turn — 30-90s of wall time and most of the box's
// one core. An unbounded tick over a backlog (observed live 2026-08-27: ~20
// minutes, during which live users' turn_start calls starved and the gateway
// texted them raw error strings) is worse than a slower drain. Cheap terminal
// outcomes (expire/drop/hold) stay uncapped — only actual sends count.
const MAX_DELIVERIES_PER_TICK = 5;

// ── Reminders that come due together go out together ────────────────────────
// The outbox drains a row at a time, so nine reminders due at 08:00 were nine
// separate WhatsApp messages — which is what Vered got on her first morning
// after a night of held rows all released at once. They are one moment in her
// day and should be one message.
//
// Coalescing happens HERE, at delivery, and deliberately not at enqueue. A
// batch built by the sweep would have to share one idempotency key, and then
// cancelling a single reminder would let the sweep re-create the whole group —
// the exact shape of the fault that woke her at half past one. At delivery
// there is no new key and no new row: the rows stay individually cancellable,
// individually expiring, each climbing its own ladder, and the only thing that
// is shared is the one send that happens to carry all of them.
//
// The cap is not a limit on what is due — anything past it goes out on the
// next tick as its own message — it is a limit on how long one message may be.
const MAX_BATCH = 8;

// ── A retry is a new message, so a doomed send must not be attempted ────────
// A delivery on the model path is `openclaw agent --deliver`: the gateway runs
// a WHOLE TURN — tools, a rendered schedule card, the model's own words — and
// only then hands the result to the channel. If the channel cannot carry it,
// the send fails, the row backs off, and the next attempt runs the turn AGAIN.
// Nothing of the first attempt is kept, because nothing of it was ever written
// down: the outbox row holds an instruction, not a message.
//
// That is not merely expensive. Each recomposition reads a world that the
// failed sends themselves created. On 2026-09-11 the WhatsApp channel was
// disconnected from 06:07 to 12:05 and Yehav's morning digest was composed
// five times — 08:26, 08:36, 08:46, 08:57, 09:08 — five model turns and five
// freshly rendered cards. Four went nowhere. The fifth, the one the returning
// channel finally carried, was the one that had watched him say nothing for
// forty minutes: "11 מחכות, 3 תזכורות נשלחו — ואתה לא עונה". He had answered
// every message he was actually shown. The silence was ours, and the retry
// loop is what turned it into an accusation (`incidents.md`, "The fifth draft
// was the rude one").
//
// So: before the first send of a tick, ask the gateway whether its channels
// can carry anything. `down` skips the send and books exactly the bookkeeping
// the failed send would have booked — attempts + 1, the reason in
// `last_error`, the same backoff — so every reader downstream (the stuck-row
// alarm, the reminder-redo discriminator that needs `attempts > 0` with an
// error beside it, the dashboard) sees precisely what it sees today. The only
// thing that does not happen is the turn.
//
// `unknown` sends. The probe is not the authority on whether we may talk to
// somebody — it is an optimisation that skips work known to be wasted — and a
// detector that goes quiet must never be the thing that silences the system.
// Refusing on "could not tell" is the hazard the channel detector itself is
// written to avoid, pointed the other way.
//
// Asked at most ONCE per tick, and only when there is a row to send: a quiet
// tick costs nothing, a busy one costs the 11-18ms the WebSocket answers in.
function channelProbe(deps) {
  const ask = deps.checkChannels || checkChannels;
  let asked = null;
  return () => {
    if (!asked) asked = ask({}).catch((e) => ({ status: 'unknown', detail: String((e && e.message) || e), channels: [] }));
    return asked;
  };
}

function payloadOf(row) {
  const p = row.payload;
  return (typeof p === 'string' ? JSON.parse(p) : p) || {};
}

// The template key this row would render with, or null if it is not a
// batchable reminder at all: a payload carrying an `instruction` asks for a
// model turn by definition (proactive-text.rawPipeTextFor), and a titleless
// row renders nothing.
function batchKeyFor(row) {
  if (row.kind !== 'reminder') return null;
  const p = payloadOf(row);
  if (p.instruction) return null;
  if (!String(p.title || '').trim()) return null;
  return proactiveText.reminderTemplateKey(p);
}

// deliver(user, row) → { ok, error? } — injected; production uses
// channels/openclaw.js, tests inject a recorder.
async function drainOnce(pool, deliver, now = new Date(), deps = {}) {
  const outcomes = { delivered: 0, held: 0, expired: 0, dropped: 0, failed: 0 };
  const channelsCanCarry = channelProbe(deps);
  // Rows whose own bookkeeping threw, recorded rather than rethrown — see the
  // catch at the bottom of the loop.
  const errored = [];

  // Plain read — the authoritative locking is the per-row FOR UPDATE SKIP
  // LOCKED below (a lock taken here would be released at this tx's commit
  // anyway, and only mislead readers into thinking it protects something).
  const { rows: candidates } = await pool.query(
    `SELECT o.*, u.timezone, u.agent_id, u.quota_blocked_until, u.first_name, u.last_inbound_at, u.last_dashboard_at,
            u.digest_times, u.paused_at, u.paused_reason, u.room_invite_sent_at, u.is_eval, u.checkin_misses, u.locale
     FROM outbox o JOIN users u ON u.id = o.user_id
     WHERE o.sent_at IS NULL AND (o.release_after IS NULL OR o.release_after <= $1)
       -- A budget hold with no release time is waiting for the next digest to
       -- carry it (collectHeld), so it must not be retried on a clock. One
       -- WITH a release time is the no-digest case: the gate scheduled it for
       -- the next day, and skipping it here is what left those rows unsent
       -- forever despite the release time the gate had set.
       AND (o.hold_reason IS DISTINCT FROM 'budget' OR o.release_after IS NOT NULL)
     ORDER BY o.created_at LIMIT 50`,
    [now]
  );

  // Rows a batch earlier in this tick already carried. On success the re-lock
  // below would skip them anyway (sent_at is set); on FAILURE it would not,
  // and the sibling would be sent again immediately as its own message —
  // spending the retry the backoff had just scheduled, in the same tick.
  const carried = new Set();

  for (const row of candidates) {
    if (outcomes.delivered + outcomes.failed >= MAX_DELIVERIES_PER_TICK) break;
    if (carried.has(String(row.id))) continue;
    try {
      await withTx(pool, async (client) => {
        // re-lock this row; skip if another tick got it meanwhile
        const { rows: locked } = await client.query(
          `SELECT * FROM outbox WHERE id = $1 AND sent_at IS NULL FOR UPDATE SKIP LOCKED`, [row.id]
        );
        if (!locked[0]) return;

        const plan = await quota.planFor(client, row.user_id);
        const blocked = await quota.isBlocked(client, row.user_id, now.toISOString());
        const win = await preferences.availabilityWindow(client, row.user_id);
        // The row already carries both fields the default is computed from,
        // so an unstated quiet day costs no extra query, the holiday list is
        // read only for somebody who asked for it, and an Israeli Saturday
        // resolves to the real candle-lighting → havdalah window. All three
        // are assembled in domain/quiet-facts.js, because since 2026-09-22 the
        // gate is no longer the only thing that asks: a repeating reminder is
        // SCHEDULED off these days too, a week before any row gets here.
        const { quietDays, quietDates, shabbatWindow } =
          await quietFacts.quietFactsFor(client, {
            id: row.user_id, timezone: row.timezone, locale: row.locale,
          }, now);
        const budget = Number(await flagsDomain.getFlag(client, 'proactive_daily_budget') ?? 4);
        // Count only what the budget actually governs. Urgent rows and the two
        // user-chosen kinds are exempt in decide() — counting them here let a day
        // with three reminders exhaust a budget those reminders ignored, and then
        // every ordinary message for the rest of that day was held. That is how a
        // real connection request went unseen: five sends, none of them subject to
        // the budget, ate all four slots. Keep this list in sync with decide().
        //
        // 'cancelled_by_admin' and 'superseded' rows carry sent_at too — that
        // is how cancelling stops the producer re-creating them — but nothing
        // was ever delivered, so counting them would let cancelling a message
        // burn the same budget as sending it.
        //
        // count(DISTINCT sent_at), not count(*): a batch is stamped by one
        // `UPDATE ... WHERE id = ANY(...)`, so every row it carried shares the
        // transaction's timestamp to the microsecond. The budget is a limit on
        // how often Olma interrupts somebody, and that is messages — counting
        // rows would charge a merged message twice and make merging cost more
        // than sending the same things separately.
        const { rows: sentRows } = await client.query(
          `SELECT count(DISTINCT sent_at)::int AS n FROM outbox
           WHERE user_id = $1 AND sent_at IS NOT NULL AND sent_at::date = $2::date
             AND (hold_reason IS NULL OR hold_reason NOT IN ('expired', 'cancelled_by_admin', 'paused', 'superseded'))
             AND urgency <> 'urgent'
             AND kind NOT IN ('reminder', 'digest', 'introduction')`,
          [row.user_id, now]
        );

        // Did this person write in the room that is running this coordination,
        // since it started? Only then, and only for a row about that
        // coordination, does the gate's 15-minute window open on it — the
        // owner's rule, 2026-09-08. The query is what scopes the exception:
        // `meetings.group_id` ties the row to one room, `last_wrote_at >=
        // mt.created_at` is his "after the coordination started", and a row
        // with no meeting behind it never asks at all.
        //
        // A message that did not name her never reaches this column (see
        // migration 056), so a NULL here means "she was shown nothing from
        // them", never "they said nothing".
        const meetingId = Number(row.payload && row.payload.meetingId) || 0;
        let groupWroteAt = null;
        if (meetingId) {
          const { rows: wrote } = await client.query(
            `SELECT max(m.last_wrote_at) AS at
               FROM meetings mt
               JOIN chat_group_members m
                 ON m.group_id = mt.group_id AND m.user_id = $2 AND m.left_at IS NULL
              WHERE mt.id = $1 AND mt.group_id IS NOT NULL
                AND m.last_wrote_at IS NOT NULL AND m.last_wrote_at >= mt.created_at`,
            [meetingId, row.user_id]);
          groupWroteAt = wrote[0] ? wrote[0].at : null;
        }
        // The one coordination message a PAUSED person still gets (owner,
        // 2026-09-13; domain/pause.js). Only an invite, only to a meeting a
        // room started, only while this pause has not spent it. Worker-scoped
        // like groupWroteAt, and false for every sibling below: it is about
        // THIS row, and a paused person's other rows must still drop.
        //
        // `quietRoomInvite` is the same allowance for somebody who has stopped
        // answering without being paused (owner, 2026-09-22) — the same three
        // conditions, anchored on their last word instead of on `paused_at`
        // (pause.quietRoomInviteSpent), and asked only when the gate's quiet
        // branch can actually be reached, so an ordinary invite to somebody
        // who is answering never stamps the column and never costs them a
        // later pause's allowance. A paused row keeps `pausedRoomInvite`
        // alone: the pause branch is decided before the quiet one, so widening
        // that fact would change what a pause means.
        let pausedRoomInvite = false;
        let quietRoomInvite = false;
        const roomInviteCandidate = row.kind === 'meeting_invite' && meetingId
          && (row.paused_at
            ? !pauseDomain.roomInviteSpent(row)
            : (Number(row.checkin_misses) || 0) >= 1 && !pauseDomain.quietRoomInviteSpent(row));
        if (roomInviteCandidate) {
          const { rows: g } = await client.query(
            `SELECT 1 FROM meetings WHERE id = $1 AND group_id IS NOT NULL AND status = 'negotiating'`,
            [meetingId]);
          if (g.length > 0) {
            if (row.paused_at) pausedRoomInvite = true;
            else quietRoomInvite = true;
          }
        }
        // Have they ANSWERED in this coordination? The gate's silence branch
        // treats a yes or a no on record as proof this row is news about
        // something of theirs rather than something Olma decided to say (owner,
        // 2026-09-23, the narrow line of two). Worker-scoped and about THIS
        // row's meeting, like the two above, so it is false for every sibling.
        //
        // An answer to ANY option of this meeting counts, live or deleted: a
        // person who declined the only slot on the table has engaged with the
        // coordination exactly as much as one who accepted it, and the option
        // they answered about is the first thing the negotiation throws away.
        let answeredCoordination = false;
        if (meetingId) {
          const { rows: ans } = await client.query(
            `SELECT 1 FROM meeting_option_answers a
               JOIN meeting_options o ON o.id = a.option_id
              WHERE o.meeting_id = $1 AND a.user_id = $2 LIMIT 1`,
            [meetingId, row.user_id]);
          answeredCoordination = ans.length > 0;
        }
        // An introduction still waiting to go out. Bounded to two days on
        // purpose: a repair that was queued and somehow never delivered must
        // not silence everything else for this person for ever, and past that
        // the queue is more useful than the apology.
        const { rows: introRows } = await client.query(
          `SELECT 1 FROM outbox
            WHERE user_id = $1 AND kind = 'introduction' AND sent_at IS NULL
              AND id <> $2
              AND (expires_at IS NULL OR expires_at > $3)
              AND created_at > $3::timestamptz - interval '2 days'
            LIMIT 1`,
          [row.user_id, row.id, now]
        );

        // And one that has just LANDED. The gate gives an introduction a few
        // minutes of the floor to itself, counted from the moment it actually
        // went out rather than from whenever the waiting row was last looked
        // at — a row evaluated a second after the introduction was stamped
        // would otherwise be released a second later. `hold_reason IS NULL` is
        // load-bearing: a cancelled or superseded introduction carries
        // `sent_at` too, and nothing was ever delivered.
        const { rows: introSent } = await client.query(
          `SELECT sent_at FROM outbox
            WHERE user_id = $1 AND kind = 'introduction'
              AND sent_at IS NOT NULL AND hold_reason IS NULL
              AND sent_at > $2::timestamptz - interval '1 hour'
            ORDER BY sent_at DESC LIMIT 1`,
          [row.user_id, now]
        );

        // What this person has actually HEARD in the last hour, by kind — the
        // fact behind the gate's repeat guard. Keyed by kind rather than read
        // for this row's kind alone, because the batch and the merge below
        // re-decide siblings of other kinds against these same facts, and a
        // number gathered for the lead row would be answering the wrong
        // question for them. `hold_reason IS NULL` is what makes it "heard": a
        // cancelled, superseded or dropped row carries sent_at too and reached
        // nobody (a timed-out send does not — it is stamped clean, because it
        // very likely went out).
        const { rows: heard } = await client.query(
          // Bounded on BOTH sides against the tick's own clock. The upper bound
          // is not paranoia about the future: Postgres stamps `sent_at` with
          // its own clock while this tick carries the JavaScript `now` it was
          // handed, so a row delivered moments ago is routinely a few
          // milliseconds ahead of it — and a caller running the drain at a
          // moment of its own choosing (every test that does, and the on-box
          // replays) would otherwise read every genuinely later row as "just
          // sent" and drop the whole queue as duplicates. A minute of slack
          // covers the skew and nothing else.
          `SELECT kind, max(sent_at) AS at FROM outbox
            WHERE user_id = $1 AND sent_at IS NOT NULL AND hold_reason IS NULL
              AND sent_at > $2::timestamptz - interval '1 hour'
              AND sent_at <= $2::timestamptz + interval '1 minute'
            GROUP BY kind`,
          [row.user_id, now]
        );
        const lastSentByKind = Object.fromEntries(heard.map((r) => [r.kind, r.at]));

        // Named, because the batch below re-decides each sibling against the
        // identical facts — everything here except `row` is about the PERSON.
        const facts = {
          row, plan, blocked, paused: Boolean(row.paused_at),
          evalUser: Boolean(row.is_eval),
          checkinMisses: Number(row.checkin_misses) || 0,
          blockedUntil: row.quota_blocked_until,
          window: win.data.window, quietDays, quietDates, shabbatWindow, tz: row.timezone,
          lastInboundAt: row.last_inbound_at, dashboardWroteAt: row.last_dashboard_at, groupWroteAt,
          pausedRoomInvite, quietRoomInvite, answeredCoordination,
          hasDigest: Boolean(row.digest_times),
          introductionPending: introRows.length > 0,
          introductionSentAt: introSent[0] ? introSent[0].sent_at : null,
          lastSentByKind,
          sentToday: sentRows[0].n, budget, now,
        };
        const verdict = decide(facts);

        // Terminal, like 'expired': sent_at is stamped so the sweep that produced
        // this row cannot produce it again, and hold_reason records that nothing
        // was actually sent.
        if (verdict.action === 'drop') {
          await client.query(
            `UPDATE outbox SET sent_at = now(), hold_reason = $2 WHERE id = $1`,
            [row.id, verdict.holdReason]
          );
          // Every other drop reason is a state somebody can look up — paused,
          // quiet, an eval row. A duplicate is the only one that says something
          // upstream produced a message it should not have, so it leaves a row
          // to count: a guard nobody can measure is one nobody will trust.
          if (verdict.holdReason === 'duplicate') {
            await audit.record(client, row.user_id, 'delivery.duplicate_suppressed', {
              outboxId: Number(row.id), kind: row.kind,
              lastSentAt: lastSentByKind[row.kind] || null,
            });
          }
          outcomes.dropped++;
          return;
        }
        if (verdict.action === 'expire') {
          await client.query(
            `UPDATE outbox SET sent_at = now(), hold_reason = 'expired' WHERE id = $1`, [row.id]
          );
          outcomes.expired++;
          return;
        }
        if (verdict.action === 'hold') {
          await client.query(
            `UPDATE outbox SET hold_reason = $2, release_after = $3 WHERE id = $1`,
            [row.id, verdict.holdReason, verdict.releaseAfter]
          );
          outcomes.held++;
          return;
        }

        // Everything else of this person's that is due right now, renders with
        // the SAME rung template, and would pass this same gate. Locked in
        // this transaction, so a row another tick already holds is simply not
        // batched rather than waited for; and re-decided rather than assumed,
        // because expiry is per row — a rung whose two hours ran out must not
        // ride along on a sibling that is still live.
        const ids = [row.id];
        const titles = [payloadOf(row).title];
        const key = batchKeyFor(row);
        if (key) {
          const { rows: siblings } = await client.query(
            `SELECT * FROM outbox
              WHERE user_id = $1 AND id <> $2 AND kind = 'reminder' AND sent_at IS NULL
                AND (release_after IS NULL OR release_after <= $3)
                AND (hold_reason IS DISTINCT FROM 'budget' OR release_after IS NOT NULL)
              ORDER BY created_at, id
              FOR UPDATE SKIP LOCKED`,
            [row.user_id, row.id, now]
          );
          for (const sib of siblings) {
            if (ids.length >= MAX_BATCH) break;
            if (batchKeyFor(sib) !== key) continue;
            // `groupWroteAt`, `answeredCoordination` and the two room-invite
            // allowances were read for THIS row's coordination and are the
            // facts here that are about the row rather than the person. The
            // batch is reminders only, which never carry a meeting, so all are
            // empty for every sibling — said out loud rather than relied upon.
            if (decide({
              ...facts, groupWroteAt: null, pausedRoomInvite: false, quietRoomInvite: false,
              answeredCoordination: false, row: sib,
            }).action !== 'deliver') continue;
            ids.push(sib.id);
            titles.push(payloadOf(sib).title);
            carried.add(String(sib.id));
          }
        }

        // ── The same, across kinds ──────────────────────────────────────
        // The batch above merges reminders with reminders. This one merges
        // everything else that came due in the same moment and is not
        // diminished by the company — a check-in behind the morning digest,
        // a "these went to the archive" beside it. domain/message-merge.js
        // draws that line and holds the one-ask rule; here we only lock,
        // re-decide and carry, exactly as above. A row is either in the
        // reminder batch or in this one, never both: a reminder rides the raw
        // pipe with the owner's wording and no model, and that is the whole
        // reason it is not folded into a composed turn.
        let mergedParts = null;
        if (!key && mergeRoleFor(row)) {
          const { rows: others } = await client.query(
            `SELECT * FROM outbox
              WHERE user_id = $1 AND id <> $2 AND sent_at IS NULL
                AND kind = ANY($4)
                AND (release_after IS NULL OR release_after <= $3)
                AND (hold_reason IS DISTINCT FROM 'budget' OR release_after IS NOT NULL)
              ORDER BY created_at, id
              FOR UPDATE SKIP LOCKED`,
            [row.user_id, row.id, now, MERGEABLE_KINDS]
          );
          // Re-decided rather than assumed, for the same reason as above:
          // expiry, quiet and the introduction hold are all per row, and a row
          // the gate would stop must not ride along on one it would not.
          //
          // `answeredCoordination` is reset for the same reason it is in the
          // reminder batch. `groupWroteAt` is not, and that asymmetry is not a
          // judgement: no `MERGEABLE` kind carries a meeting at all
          // (domain/message-merge.js — digests, the ladder's rung, travel and
          // four statements), so neither meeting fact can decide anything here.
          // Mine is stated because a kind added to that table later would make
          // it matter, and a fact about another row's coordination must not be
          // the thing that lets a sibling through.
          const deliverable = others.filter((sib) => decide({
            ...facts, pausedRoomInvite: false, quietRoomInvite: false, answeredCoordination: false, row: sib,
          }).action === 'deliver');
          const parts = planMerge(row, deliverable);
          if (parts) {
            mergedParts = parts.map((r) => ({ kind: r.kind, payload: payloadOf(r) }));
            for (const part of parts) {
              if (String(part.id) === String(row.id)) continue;
              ids.push(part.id);
              carried.add(String(part.id));
            }
          }
        }

        // `items` and `mergedParts` ride the in-memory row only. Nothing about
        // the batch is written down, so a redelivery after a failed send
        // re-forms it from whatever is still due then.
        // The one question asked before any turn is spent. Only an explicit
        // `down` stops the send; see channelProbe above for why `unknown` does
        // not, and why this is asked here rather than at the top of the tick
        // (a tick with nothing deliverable never reaches this line).
        const channels = await channelsCanCarry();
        const result = channels.status === 'down'
          ? { ok: false, error: `channel unavailable, no turn spent: ${channels.detail}` }
          : await deliver(
            mergedParts ? { ...row, payload: { ...payloadOf(row), mergedParts } }
              : ids.length > 1 ? { ...row, payload: { ...payloadOf(row), items: titles } }
                // In memory only, like `items`: the reader tells the model
                // this person is paused and this is the one message about it.
                : pausedRoomInvite ? { ...row, payload: { ...payloadOf(row), pausedNotice: true } }
                  : row
          );
        // Stamped only once the send confirmed or timed out (booked as sent
        // below): "we told them" is never written for a message that failed.
        // One column, two allowances, and the trail says which one paid: a
        // pause and a run of silence are different rules with different
        // anchors, and a single audit kind would make them one thing to read
        // back. The quiet half is spent only when the GATE says the row got
        // through on it (verdict.spendsQuietRoomInvite) — a row the room
        // window or the page carried is not an allowance being used.
        const spendRoomInvite = async () => {
          const quiet = Boolean(verdict.spendsQuietRoomInvite);
          if (!pausedRoomInvite && !quiet) return;
          await client.query(`UPDATE users SET room_invite_sent_at = now() WHERE id = $1`, [row.user_id]);
          await audit.record(client, row.user_id, quiet ? 'quiet.room_invite_sent' : 'pause.room_invite_sent', {
            outboxId: Number(row.id), meetingId,
          });
        };
        if (result.ok) {
          await client.query(
            `UPDATE outbox SET sent_at = now(), hold_reason = NULL WHERE id = ANY($1::bigint[])`, [ids]
          );
          await spendRoomInvite();
          outcomes.delivered++;
          if (ids.length > 1) outcomes.batched = (outcomes.batched || 0) + ids.length - 1;
        } else if (result.timedOut) {
          // A timeout is a message that has very likely gone out, not one that
          // failed (channels/openclaw.js, `runOpenclaw`). The CLI hands the
          // turn to the gateway and waits for the model; killing it at the
          // deadline stops the WAITING, never the turn, and `--deliver` sends
          // whatever the turn says. Retried as a failure, every retry is a
          // whole new turn and a whole new message: Dana got the same day-one
          // check-in six times in seventeen minutes (2026-09-08, row 8675,
          // attempts = 5), the last of them with the model's tool-call markup
          // in it. So the row is booked as SENT — one attempt spent, the
          // timeout kept in `last_error` so the dashboard can count them — and
          // never retried. The price is the rare message that really was lost
          // to a dead gateway; that person hears the next thing Olma has to
          // say, which is a smaller harm than six copies of this one.
          await client.query(
            `UPDATE outbox SET sent_at = now(), hold_reason = NULL,
                    attempts = attempts + 1, last_error = $2
             WHERE id = ANY($1::bigint[])`,
            [ids, String(result.error || 'openclaw timeout').slice(0, 500)]
          );
          await audit.record(client, row.user_id, 'delivery.unconfirmed', {
            outboxIds: ids.map(Number), kind: row.kind, error: String(result.error || 'openclaw timeout').slice(0, 200),
          });
          await spendRoomInvite();
          outcomes.delivered++;
          outcomes.unconfirmed = (outcomes.unconfirmed || 0) + 1;
          if (ids.length > 1) outcomes.batched = (outcomes.batched || 0) + ids.length - 1;
        } else {
          // 5s, 15s, 45s, 2m15s, then capped at 10 minutes. The first retry has
          // to be seconds: the most common failure is a welcome racing the
          // gateway's config reload, a transient measured in seconds — a flat
          // 2-minute first backoff was what turned a 3-second setup into the
          // 2-minute wait new users actually experienced.
          //
          // The cap matters for the opposite case, an outage rather than a race:
          // when the Anthropic account ran out of credit every send failed for
          // as long as it took to notice. Uncapped tripling would have pushed a
          // waiting user's welcome days out, so it would still be unsent long
          // after the account was topped up. Capped, everything queued goes out
          // within ten minutes of service returning.
          //
          // The exponent is capped BEFORE it is multiplied, not after. least()
          // evaluates both of its arguments, so `interval '5 seconds' *
          // power(3, attempts)` was computed in full and only then compared to
          // the cap — and an interval holds microseconds in an int64, so at
          // attempts = 26 (5s x 3^26 = 1.3e19us > 9.2e18) the multiplication
          // itself threw `interval out of range`, and the row could no longer
          // even record its own failure.
          //
          // That turned the very outage this cap was written for into a
          // permanent one: the Anthropic account ran dry on 2026-08-23, every
          // send failed, attempts climbed for a day, and once two rows crossed
          // 26 each tick aborted on them — oldest-first, so they sat at the head
          // of the queue with 28 healthy messages stuck behind them. Topping the
          // account back up would not have cleared it; only this line does.
          // Every row the send was carrying, not just the one that led it: a
          // batch is one send, so a failure is one failure for all of them.
          await client.query(
            `UPDATE outbox SET attempts = attempts + 1, last_error = $2,
                    release_after = now() + least(
                      interval '10 minutes',
                      interval '5 seconds' * power(3, least(attempts, 6)))
             WHERE id = ANY($1::bigint[])`,
            [ids, String(result.error || 'delivery failed').slice(0, 500)]
          );
          outcomes.failed++;
          // Counted apart from `failed` on the heartbeat, because the two read
          // differently on the board: `failed` is sends that were attempted and
          // did not land, `channelDown` is sends nobody attempted. A check that
          // declines to act has to say so somewhere or it is indistinguishable
          // from one that found nothing to do.
          if (channels.status === 'down') outcomes.channelDown = (outcomes.channelDown || 0) + 1;
        }
      });
    } catch (e) {
      // Isolated on purpose. Anything escaping the per-row transaction is a
      // defect in OUR handling of THIS row, and the rest of the queue has
      // nothing to do with it — so it is recorded and stepped over, never
      // rethrown. Before this, one unprocessable row aborted the tick and took
      // every healthy message behind it down too, for as long as it sat there.
      // One row failing is a defect; one row silencing the system is an outage.
      errored.push({ id: row.id, error: String((e && e.message) || e).slice(0, 200) });
    }
  }
  if (errored.length) outcomes.errored = errored;
  return outcomes;
}

module.exports = { drainOnce, MAX_DELIVERIES_PER_TICK, MAX_BATCH };
