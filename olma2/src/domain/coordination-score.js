'use strict';
// How well one coordination went, as a number the owner can hold a policy to
// (owner, 2026-09-28: "find the best way to run a room coordination … done
// when ten have gone well"). Pure: it reads a timeline
// (`coordination-timeline.timelineFor`) and nothing else, so the report, the
// simulator and any later nightly job score by the SAME function — a second
// copy of this arithmetic is how two numbers for one thing drift apart.
//
// Nothing a model SAID goes in. Every input is a row: an answer, a touch that
// reached somebody, an exit, a close.
//
// Two readings the owner settled, and why they are here rather than guessed:
//  - A graceful exit is a success too ("הצלחה יכולה להיות גם כשידעת שהקבוצה
//    כבר לא מעוניינת והצעת את זה לפני שהם התייאשו"): a close that FOLLOWED
//    our offer to drop it scores as one, a silent expiry does not. But only
//    "אם זה באמת מה שהם רצו ולא התחרטו עליו" (owner, the same day): a room
//    that opens a new coordination within `REGRET_WINDOW_MS` of the drop still
//    wanted to meet, so the drop was a mistake and scores nothing; and until
//    that window has passed the exit is `pending`, neither a success nor a
//    failure. A room that SAID to drop it (`cancelled`) and one that only went
//    quiet (`no_match`, `expired`) both count, and `exit.kind` keeps them apart,
//    because silence is weaker evidence than a word.
//  - A room that agreed among themselves without tagging her leaves ONE yes in
//    the data, the one who told her (coordination 57: שבת 18:00, settled by
//    hand, three people's agreement nowhere in `meeting_option_answers`). The
//    owner confirmed that was the room agreeing. So a hand-settle in a ROOM is
//    counted as everybody still in it who did not decline that time, and the
//    result says it was counted that way (`breadthFrom: 'room_talk'`).

const HOUR = 3600_000;
// An answer this soon after a touch is credited to it.
const EFFECT_WINDOW_MS = 2 * HOUR;
// Leaving this soon after something of ours reached them is read as caused by it.
const IRRITATION_WINDOW_MS = 12 * HOUR;
// A settle undone this soon was not settled.
const STABILITY_WINDOW_MS = 24 * HOUR;
const SUCCESS_FLOOR = 0.7;
// A new coordination in the same room this soon after a drop is regret. A
// PROXY, and a coarse one: a weekly game opening next week's game reads the
// same. Chosen short for that reason, and the report shows each case.
const REGRET_WINDOW_MS = 72 * HOUR;

// The kinds of room line that offer to drop it. `manual_drop_offer` is the
// hand-sent one of 2026-09-28; `drop_offer` is the one the policy will say.
const DROP_OFFER_KINDS = new Set(['drop_offer', 'manual_drop_offer']);

const ms = (t) => (t == null ? null : new Date(t).getTime());
const clamp01 = (x) => Math.max(0, Math.min(1, x));

// What became of it. `graceful` needs the drop offer to come BEFORE the end.
function outcomeOf(tl) {
  const endMs = ms(tl.closedAt);
  const offered = (tl.touches || []).some((t) => t.channel === 'room' && DROP_OFFER_KINDS.has(t.kind)
    && (endMs == null || ms(t.at) <= endMs));
  if (tl.status === 'confirmed') return { outcome: 'confirmed', value: 1, dropOffered: offered };
  if (tl.status === 'negotiating') return { outcome: 'open', value: null, dropOffered: offered };
  if (offered && ['cancelled', 'no_match', 'expired'].includes(tl.status)) {
    const exit = exitOf(tl);
    return { outcome: 'graceful_exit', value: exit.regret ? 0 : 0.6, dropOffered: true, exit };
  }
  if (tl.status === 'cancelled') return { outcome: 'cancelled', value: 0.2, dropOffered: false };
  return { outcome: 'expired', value: 0, dropOffered: false };
}

// Whether a drop held. `readAt` is when the timeline was read — the report's
// now; a timeline without one (the simulator's) is never pending.
function exitOf(tl) {
  const closed = ms(tl.closedAt);
  const later = ms(tl.laterInRoomAt);
  const regret = closed != null && later != null && later > closed && later - closed <= REGRET_WINDOW_MS;
  const readAt = ms(tl.readAt);
  const pending = !regret && closed != null && readAt != null && readAt - closed < REGRET_WINDOW_MS;
  return { kind: tl.status === 'cancelled' ? 'said' : 'quiet', regret, pending };
}

// Who is counted in. The initiator is a participant row like anybody.
function peopleOf(tl) {
  return (tl.participants || []).filter((p) => p.state !== 'opted_out').map((p) => Number(p.userId));
}

// Yes on the time that won. See the header for the room-talk reading.
function breadthOf(tl) {
  const people = (tl.participants || []).map((p) => Number(p.userId));
  // Against ENOUGH when they said how many is enough (a padel game is four, and
  // the other three in the room are not a shortfall), else against everybody.
  const size = tl.target ? Math.max(1, Math.min(tl.target, Math.max(tl.roomSize || 0, people.length)))
    : Math.max(tl.roomSize || 0, people.length, 1);
  if (tl.status !== 'confirmed') return { yes: 0, of: size, value: 0, breadthFrom: null };
  const onIt = (tl.answers || []).filter((a) => tl.confirmedOptionId != null && Number(a.optionId) === Number(tl.confirmedOptionId));
  const said = new Set(onIt.filter((a) => a.answer === 'y').map((a) => Number(a.userId)));
  let yes = said.size;
  let from = 'answers';
  if (tl.settledByHand && tl.groupId != null) {
    const declined = new Set(onIt.filter((a) => a.answer === 'n').map((a) => Number(a.userId)));
    const talk = peopleOf(tl).filter((u) => !declined.has(u)).length;
    if (talk > yes) { yes = talk; from = 'room_talk'; }
  }
  // A small bonus for a big group, capped: eight yeses is worth more than two
  // even when both are the whole room.
  const value = clamp01(0.85 * Math.min(1, yes / size) + 0.15 * clamp01(Math.log2(Math.max(yes, 1)) / 3));
  return { yes, of: size, value, breadthFrom: from };
}

// From start to close, against the time there was: closing a day before a
// game three days out is good, an hour before is not.
function speedOf(tl) {
  const start = ms(tl.startedAt);
  const end = ms(tl.closedAt);
  const thing = ms(tl.confirmedStartAt) ?? ms(tl.earliestStartAt);
  if (tl.status !== 'confirmed' || start == null || end == null || thing == null || thing <= start) {
    return { closeHours: end != null && start != null ? (end - start) / HOUR : null, value: 0 };
  }
  return { closeHours: (end - start) / HOUR, leadHours: (thing - start) / HOUR, value: clamp01(1 - (end - start) / (thing - start)) };
}

function answerRateOf(tl) {
  const people = peopleOf(tl);
  if (!people.length) return { answered: 0, of: 0, value: 0 };
  const answered = new Set((tl.answers || []).map((a) => Number(a.userId)).filter((u) => people.includes(u)));
  // The initiator's own first time is a yes by construction, not an answer.
  if (tl.initiatorId != null && !(tl.answers || []).some((a) => Number(a.userId) === Number(tl.initiatorId) && !a.byAdding)) {
    answered.delete(Number(tl.initiatorId));
  }
  return { answered: answered.size, of: people.length, value: answered.size / people.length };
}

// Leaving within twelve hours of something of ours reaching them.
//
// Leaving the COORDINATION and leaving OLMA are two signals, and only the
// first is read against this coordination (2026-09-28). In 57 the one who
// paused her had a private exchange that went badly and stopped her entirely;
// nothing says the room line before it was the cause, and a success cancelled
// on a guess is the overstated alarm this project keeps paying for. The pause
// is not dropped: it comes back as `lost`, where a run of them shows.
// Both causes `group-meetings` writes when a pause takes somebody out: they
// asked her to stop, or the silence ladder paused them. Neither is a choice
// about this coordination.
const LEFT_OLMA = new Set(['paused_by_request', 'paused_no_answer']);

function lostOf(tl) {
  return (tl.exits || []).filter((e) => LEFT_OLMA.has(e.cause)).map((e) => ({ userId: Number(e.userId), at: e.at }));
}

function irritationOf(tl) {
  const hits = [];
  for (const e of (tl.exits || []).filter((x) => !LEFT_OLMA.has(x.cause))) {
    const at = ms(e.at);
    // The LAST thing that reached them before they left is the one it is read against.
    const cause = (tl.touches || []).filter((t) => {
      const tAt = ms(t.at);
      const reached = t.channel === 'room' || (t.userIds || []).map(Number).includes(Number(e.userId));
      return reached && tAt <= at && at - tAt <= IRRITATION_WINDOW_MS;
    }).pop();
    if (cause) hits.push({ userId: Number(e.userId), afterKind: cause.kind, hours: (at - ms(cause.at)) / HOUR });
  }
  return hits;
}

function stabilityOf(tl) {
  const settled = ms(tl.settledAt);
  if (settled == null) return { unstable: false };
  const undone = (tl.undoneAt || []).map(ms).find((t) => t != null && t > settled && t - settled <= STABILITY_WINDOW_MS);
  return { unstable: undone != null };
}

// Per touch: who answered anything within two hours of it. A private touch is
// credited only with its own addressee's answer; a room line with anybody's.
function touchEffects(tl) {
  return (tl.touches || []).map((t) => {
    const at = ms(t.at);
    const inWindow = (tl.answers || []).filter((a) => {
      const aAt = ms(a.at);
      return aAt > at && aAt - at <= EFFECT_WINDOW_MS && !a.byAdding;
    });
    const who = new Set(inWindow
      .filter((a) => t.channel === 'room' || (t.userIds || []).map(Number).includes(Number(a.userId)))
      .map((a) => Number(a.userId)));
    const firstMs = inWindow.length ? Math.min(...inWindow.map((a) => ms(a.at))) : null;
    // Of the people a room line TAGGED, how many answered: whether naming
    // somebody in front of the room is what moves them, or anybody at all.
    const taggedIds = (t.taggedIds || []).map(Number);
    const taggedAnswered = taggedIds.filter((u) => who.has(u)).length;
    return {
      at: t.at, channel: t.channel, kind: t.kind, reached: (t.userIds || []).length || null,
      answeredBy: who.size, firstAnswerMinutes: firstMs == null ? null : (firstMs - at) / 60_000,
      tagged: taggedIds.length, taggedAnswered,
    };
  });
}

function scoreCoordination(tl) {
  const out = outcomeOf(tl);
  const breadth = breadthOf(tl);
  const speed = speedOf(tl);
  const rate = answerRateOf(tl);
  const irritation = irritationOf(tl);
  const stability = stabilityOf(tl);
  const touches = (tl.touches || []).length;
  const cost = touches / Math.max(1, rate.answered);

  let total = null;
  if (out.value != null) {
    total = out.value * (0.5 + 0.2 * speed.value + 0.2 * breadth.value + 0.1 * rate.value);
    if (out.outcome === 'graceful_exit') total = out.value; // an exit is not faster or wider
    total -= 0.2 * Math.min(irritation.length, 2);
    if (stability.unstable) total -= 0.2;
    total = Math.round(clamp01(total) * 100) / 100;
  }
  const beforeThing = tl.confirmedStartAt == null || tl.closedAt == null || ms(tl.closedAt) <= ms(tl.confirmedStartAt);
  const success = total != null && !irritation.length && !stability.unstable && (
    (out.outcome === 'confirmed' && total >= SUCCESS_FLOOR && beforeThing)
    || (out.outcome === 'graceful_exit' && !out.exit.regret && !out.exit.pending));

  return {
    meetingId: tl.meetingId, room: tl.groupId != null, outcome: out.outcome, dropOffered: out.dropOffered,
    exit: out.exit || null,
    total, success,
    speed, breadth, answerRate: rate, cost: Math.round(cost * 100) / 100, touches,
    irritation, lost: lostOf(tl), unstable: stability.unstable,
  };
}

module.exports = {
  scoreCoordination, touchEffects,
  EFFECT_WINDOW_MS, IRRITATION_WINDOW_MS, STABILITY_WINDOW_MS, SUCCESS_FLOOR, DROP_OFFER_KINDS, LEFT_OLMA,
};
