'use strict';
// ── Several things due at the same moment are ONE message ───────────────────
// The outbox drains a row at a time, so everything that comes due together
// arrives as a run of separate WhatsApp messages seconds apart. Reminders
// already coalesce (outbox/worker.js, MAX_BATCH), but only with each other and
// only when they render with the same rung template. Everything else is still
// one message per row: measured on the box 2026-09-08, fifteen runs in a day
// and a bit — a reminder and the morning digest forty seconds apart, a
// check-in behind a digest, an introduction and a check-in fifty-two seconds
// apart.
//
// This file decides ONLY whether a row may travel in company. How the joint
// message reads is the channel's business (channels/openclaw.js), and WHEN the
// batch is formed is the worker's — at DELIVERY, never at enqueue, for the
// reason already written out over the reminder batch: a batch built by a sweep
// would share one idempotency key, and cancelling one member would let the
// sweep re-create the whole group.
//
// Two boundaries this never crosses, both of them load-bearing:
//
//   1. A REMINDER is not merged into a model turn. Every rung rides the raw
//      pipe with the owner's own wording (domain/proactive-text.js) and no
//      model in the path. Folding one into a composed turn would hand the one
//      sentence a person actually asked for to a model that may reword it or
//      drop it, and the row would still be stamped delivered. Reminders merge
//      with reminders, where they already do, and with nothing else.
//
//   2. At most ONE ASK per message. Two questions in one message get one
//      answer, and neither the model nor the tool behind it can tell which was
//      answered — a connection request and a travel question in the same
//      breath is a wrong tool call waiting to happen. This is the doctrine's
//      own "never more than one ask", applied to a message assembled from
//      parts rather than written as one.

// What each mergeable kind IS, which is the whole basis of the one-ask rule:
//   'tells' — a statement. Nothing is expected back, any number may travel.
//   'asks'  — expects an answer, and something acts on that answer. One only.
//
// Everything absent from this map is unmergeable BY DEFAULT, which is the safe
// direction: a kind added next month arrives alone until somebody reads it and
// decides. The exclusions worth naming, because each was considered:
//   reminder                     — boundary 1 above
//   introduction, *_apology,     — a row carrying its own `instruction` is
//   voice_call_summary             hand-written or exact copy; see mergeRoleFor
//   connection_intro,            — "say the following EXACTLY as written";
//   registration_reopened          there is nothing to compose with
//   media_ready, image, video    — the reply is a sentence plus a MEDIA line
//   meeting_*, relayed_message,  — carry ANOTHER person's text behind a
//   connection_request, share_*    data-only fence; several fences in one
//                                  prompt is a wider injection surface than
//                                  this feature is worth. Revisit deliberately.
const MERGEABLE = {
  // The morning picture. `folded` already exists on this payload for exactly
  // this purpose (jobs/sweeps.js hands it the rows the budget held), so a
  // digest leading a batch reuses that mechanism rather than a new one — which
  // is also why the drawn card needs no special case: a folded digest with a
  // card is a combination that already ships.
  digest: 'asks',
  // The ladder's own rung. Some rungs ask and some are a one-liner with no
  // question mark, and nothing on the payload says which — `checkinInstruction`
  // is prose. Declared 'asks', which costs a merge and never a wrong answer.
  checkin: 'asks',
  // Their calendar suggests they are travelling; ends in one question and
  // set_my_timezone acts on it.
  travel: 'asks',
  // Statements. Nothing is expected back from any of them.
  tasks_auto_archived: 'tells',
  calendar_connected: 'tells',
  contacts_connected: 'tells',
  email_connected: 'tells',
};

// A merged message is still one message a person reads in one breath. Three
// parts is already a lot; past that the run is better as two sends.
const MAX_MERGE = 3;

function payloadOf(row) {
  const p = row && row.payload;
  return (typeof p === 'string' ? JSON.parse(p) : p) || {};
}

// 'tells' | 'asks' | null. Null means "goes alone", and every null here is a
// deliberate decision recorded above.
function mergeRoleFor(row) {
  if (!row) return null;
  const role = MERGEABLE[row.kind];
  if (!role) return null;
  // A payload carrying its own instruction was written by hand for one moment
  // — the introduction ג.ב was owed, a night-message apology — and several of
  // them say in their own words to add nothing and send no second message.
  // Honouring that is the point; composing around it would break it.
  if (payloadOf(row).instruction) return null;
  // Urgency is a claim on the person's attention right now. Folding an urgent
  // row into a warm summary spends exactly the thing that made it urgent.
  if (row.urgency === 'urgent') return null;
  return role;
}

// Given a lead row and the rows locked beside it (already filtered to those
// the gate would deliver), the ids that travel together. Pure, so the whole
// policy is testable without a database.
//
// Order is tells-then-ask: a message that ends on its one question reads as a
// question, and one that buries it in the middle reads as a monologue.
function planMerge(lead, siblings, max = MAX_MERGE) {
  const leadRole = mergeRoleFor(lead);
  if (!leadRole) return null;
  const tells = [];
  const asks = leadRole === 'asks' ? [lead] : [];
  if (leadRole === 'tells') tells.push(lead);
  for (const sib of siblings) {
    if (tells.length + asks.length >= max) break;
    const role = mergeRoleFor(sib);
    if (!role) continue;
    if (role === 'asks') {
      if (asks.length) continue; // the one-ask rule
      asks.push(sib);
      continue;
    }
    tells.push(sib);
  }
  const parts = [...tells, ...asks];
  if (parts.length < 2) return null;
  return parts;
}

// The kinds worth locking at all. The worker narrows its sibling query to
// these so a row that could never merge — a reminder, a cross-user relay — is
// not held locked for the length of a model turn it is not part of.
const MERGEABLE_KINDS = Object.keys(MERGEABLE);

module.exports = { MERGEABLE, MERGEABLE_KINDS, MAX_MERGE, mergeRoleFor, planMerge };
