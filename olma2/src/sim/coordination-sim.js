'use strict';
// A room coordination, simulated — to CHOOSE a policy before a real room pays
// for trying it (owner, 2026-09-28: "simulator to pick the policy, only real
// rooms count toward the ten"). Pure and seeded: the same seed is the same
// room, whatever the policy, so two policies are compared on identical people.
//
// Every number a person does is a CALIBRATION, read off the box on 2026-09-28
// (`scripts/coordination-report.js` plus one read-only query) and named below
// so a later run can replace it with a newer reading:
//  - 36% ever answer the first private ask; of those, the median answer comes
//    23 minutes after it and one in five takes over eleven hours;
//  - a second private ask is answered by about half of whoever it reaches;
//  - of the people a room line TAGGED, 1 in 16 answered within two hours;
//  - people differ more than asks do: of eleven asked twice or more, three
//    have never answered and one always has.
// The simulator grades by its own assumptions. That is why it only picks
// what to TRY; the real rooms are what count.
const { scoreCoordination } = require('../domain/coordination-score');

const MIN = 60_000;
const H = 60 * MIN;

const CALIBRATION = {
  personas: [
    // share of people, chance an ask moves them, and how fast when it does
    { name: 'never', share: 0.27, p: 0.03 },
    { name: 'sometimes', share: 0.46, p: 0.35 },
    { name: 'reliable', share: 0.27, p: 0.85 },
  ],
  fastMedianMin: 23, // the answers that come soon
  slowShare: 0.25, // …and the ones that come the next day
  slowMedianMin: 11 * 60,
  secondAskFactor: 0.6, // a second private ask moves `p * this`
  roomLineP: 0.06, // a room line moving one silent person
  dropOfferP: 0.25, // an offer to drop it is SALIENT: it moves more people
  coldRoomShare: 0.25, // rooms that do not really want it
  coldFactor: 0.3,
  yesPerOption: 0.55, // an answering person can make a given time
  nudgeOptOutP: 0.04, // a private nudge beyond the first ask costs this
  closeByHandAfterH: 3, // a room with enough yes and quiet for this long writes "סגור"
  nightStart: 22, nightEnd: 9, // Olma's private messages wait out the night
};

// ---- randomness that does not depend on the policy --------------------------
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// One stream per (room, person, purpose, index), so a policy that sends one
// more message draws from a NEW stream instead of shifting every draw after it.
function draw(seed, ...keys) {
  let h = seed >>> 0;
  for (const k of keys) h = Math.imul(h ^ (typeof k === 'number' ? k : [...String(k)].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)), 2654435761) >>> 0;
  return mulberry32(h)();
}
const logNormal = (u1, u2, medianMin) => {
  const z = Math.sqrt(-2 * Math.log(Math.max(u1, 1e-9))) * Math.cos(2 * Math.PI * u2);
  return medianMin * Math.exp(0.9 * z) * MIN;
};

// ---- the room ----------------------------------------------------------------
function makeRoom(seed, cal = CALIBRATION) {
  const size = 3 + Math.floor(draw(seed, 'size') * 8); // 3..10
  const cold = draw(seed, 'cold') < cal.coldRoomShare;
  const people = [];
  for (let i = 0; i < size; i++) {
    const u = draw(seed, 'persona', i);
    let acc = 0;
    const persona = cal.personas.find((p) => (acc += p.share) >= u) || cal.personas[cal.personas.length - 1];
    people.push({ id: i + 1, persona: persona.name, p: persona.p * (cold ? cal.coldFactor : 1) });
  }
  const leadH = 24 + Math.floor(draw(seed, 'lead') * 144); // a thing 1..7 days out
  const startHour = 8 + Math.floor(draw(seed, 'hour') * 14); // opened 08..21
  const options = 2 + Math.floor(draw(seed, 'options') * 3); // 2..4 times on the table
  const game = draw(seed, 'game') < 0.3;
  return { seed, size, cold, people, leadH, startHour, options, target: game ? Math.min(4, size) : null };
}

// ---- policies ----------------------------------------------------------------
// What the room does today (group-voice, 2026-09-28): one chase an hour after
// the last invite, nothing private after the first ask, no offer to drop it.
const CURRENT = { name: 'current', roomChaseAfterH: 1, secondRoomChaseAfterH: null, privateNudgeAfterH: null, dropOfferAfterQuietH: null, dropGraceH: 6 };

// ---- one run -----------------------------------------------------------------
function simulate(room, policy, cal = CALIBRATION) {
  const t0 = Date.UTC(2030, 0, 7, room.startHour - 2, 0, 0); // Israel = UTC+2 in January
  const end = t0 + room.leadH * H;
  const localHour = (t) => (new Date(t).getUTCHours() + 2) % 24;
  const awake = (t) => { const h = localHour(t); return h >= cal.nightEnd && h < cal.nightStart; };
  const nextMorning = (t) => { let x = t; while (!awake(x)) x += 10 * MIN; return x; };

  const touches = [];
  const answers = [];
  const exits = [];
  const st = new Map(room.people.map((p) => [p.id, { answeredAt: null, pendingAt: null, asks: 0, out: false }]));
  const people = room.people.map((p) => p.id);
  const initiator = people[0];

  // The initiator's own times are on the table from the start, with their yes.
  for (let o = 1; o <= room.options; o++) answers.push({ optionId: o, userId: initiator, answer: 'y', at: new Date(t0).toISOString(), byAdding: true });
  st.get(initiator).answeredAt = t0;

  // A touch reaching a silent person may schedule their answer.
  const reach = (t, uid, pMove, idx) => {
    const s = st.get(uid);
    if (s.out || s.answeredAt != null) return;
    if (draw(room.seed, 'move', uid, idx) >= pMove) return;
    const slow = draw(room.seed, 'slow', uid, idx) < cal.slowShare;
    const lat = logNormal(draw(room.seed, 'lat1', uid, idx), draw(room.seed, 'lat2', uid, idx), slow ? cal.slowMedianMin : cal.fastMedianMin);
    const at = t + lat;
    if (s.pendingAt == null || at < s.pendingAt) s.pendingAt = at;
  };
  const person = (uid) => room.people.find((p) => p.id === uid);
  let touchIdx = 0;
  const privateAsk = (t, uid, kind) => {
    const at = awake(t) ? t : nextMorning(t);
    const s = st.get(uid);
    s.asks += 1;
    touches.push({ at: new Date(at).toISOString(), channel: 'private', kind, userIds: [uid] });
    const p = person(uid).p * (s.asks > 1 ? cal.secondAskFactor : 1);
    reach(at, uid, p, touchIdx++);
    if (s.asks > 1 && draw(room.seed, 'annoyed', uid, s.asks) < cal.nudgeOptOutP) {
      s.out = true; s.pendingAt = null;
      exits.push({ userId: uid, at: new Date(at + 30 * MIN).toISOString(), cause: 'user_choice' });
    }
    return at;
  };
  const roomLine = (t, kind, pMove) => {
    const at = awake(t) ? t : nextMorning(t);
    const silent = people.filter((u) => st.get(u).answeredAt == null && !st.get(u).out);
    touches.push({ at: new Date(at).toISOString(), channel: 'room', kind, userIds: [], taggedIds: silent });
    for (const u of silent) reach(at, u, pMove, touchIdx++);
    return at;
  };

  // Opening: the room hears she started, everybody else is asked privately.
  roomLine(t0, 'started', cal.roomLineP);
  let lastInvite = t0;
  for (const u of people.slice(1)) lastInvite = Math.max(lastInvite, privateAsk(t0, u, 'meeting_invite'));

  let status = 'negotiating';
  let closedAt = null;
  let confirmedOption = null;
  let chased = false; let chased2 = false; let offeredAt = null; let offered = false;
  let lastAnswerAt = t0;

  for (let t = t0; t <= end; t += 10 * MIN) {
    // Answers land.
    for (const u of people) {
      const s = st.get(u);
      if (s.pendingAt != null && s.pendingAt <= t && s.answeredAt == null && !s.out) {
        s.answeredAt = s.pendingAt; s.pendingAt = null; lastAnswerAt = s.answeredAt;
        for (let o = 1; o <= room.options; o++) {
          const yes = draw(room.seed, 'yes', u, o) < cal.yesPerOption;
          answers.push({ optionId: o, userId: u, answer: yes ? 'y' : 'n', at: new Date(s.answeredAt).toISOString() });
        }
      }
    }
    const inIt = people.filter((u) => !st.get(u).out);
    const yesOn = (o) => answers.filter((a) => a.optionId === o && a.answer === 'y' && inIt.includes(a.userId)).length;
    const best = [...Array(room.options).keys()].map((i) => i + 1).sort((a, b) => yesOn(b) - yesOn(a))[0];
    const need = room.target || Math.max(2, Math.ceil(inIt.length * 0.6));
    const everyone = inIt.every((u) => st.get(u).answeredAt != null);

    // Closing: everybody said yes, or enough did and the room went quiet.
    if (yesOn(best) >= inIt.length || (yesOn(best) >= need && (everyone || t - lastAnswerAt >= cal.closeByHandAfterH * H) && awake(t))) {
      status = 'confirmed'; closedAt = t; confirmedOption = best; break;
    }
    // An offer to drop it that nobody answered closes it quietly.
    if (offeredAt != null && lastAnswerAt <= offeredAt && t - offeredAt >= policy.dropGraceH * H && awake(t)) {
      status = 'no_match'; closedAt = t; break;
    }

    // The policy's moves.
    if (!chased && t >= lastInvite + policy.roomChaseAfterH * H && people.some((u) => st.get(u).answeredAt == null)) {
      roomLine(t, 'chase', cal.roomLineP); chased = true;
    }
    if (chased && !chased2 && policy.secondRoomChaseAfterH != null && t >= lastInvite + policy.secondRoomChaseAfterH * H) {
      roomLine(t, 'chase2', cal.roomLineP); chased2 = true;
    }
    if (policy.privateNudgeAfterH != null && awake(t)) {
      for (const u of people.slice(1)) {
        const s = st.get(u);
        if (!s.out && s.answeredAt == null && s.pendingAt == null && s.asks === 1 && t >= lastInvite + policy.privateNudgeAfterH * H) {
          privateAsk(t, u, 'meeting_nudge');
        }
      }
    }
    if (policy.dropOfferAfterQuietH != null && !offered && chased
        && t - lastAnswerAt >= policy.dropOfferAfterQuietH * H && yesOn(best) < need && awake(t)) {
      offeredAt = roomLine(t, 'drop_offer', cal.dropOfferP); offered = true;
    }
    if (offeredAt != null && lastAnswerAt > offeredAt) offeredAt = null; // somebody answered: the offer lapsed
  }
  if (status === 'negotiating') { status = 'expired'; closedAt = end; }

  const tl = {
    meetingId: room.seed, groupId: 1, initiatorId: initiator, status,
    startedAt: new Date(t0).toISOString(), closedAt: new Date(closedAt).toISOString(),
    settledAt: status === 'confirmed' ? new Date(closedAt).toISOString() : null,
    settledByHand: false, undoneAt: [],
    confirmedOptionId: confirmedOption, confirmedStartAt: status === 'confirmed' ? new Date(end).toISOString() : null,
    earliestStartAt: new Date(end).toISOString(),
    roomSize: room.size, target: room.target,
    participants: people.map((u) => ({ userId: u, state: st.get(u).out ? 'opted_out' : 'awaiting' })),
    answers, touches, exits,
  };
  return { room, policy: policy.name, timeline: tl, score: scoreCoordination(tl) };
}

// ---- a grid ------------------------------------------------------------------
function summarise(runs) {
  const n = runs.length;
  const by = (f) => runs.filter(f).length / n;
  const closeH = runs.filter((r) => r.score.outcome === 'confirmed').map((r) => r.score.speed.closeHours).sort((a, b) => a - b);
  return {
    n,
    success: by((r) => r.score.success),
    confirmed: by((r) => r.score.outcome === 'confirmed'),
    graceful: by((r) => r.score.outcome === 'graceful_exit'),
    expired: by((r) => r.score.outcome === 'expired'),
    meanScore: runs.reduce((a, r) => a + (r.score.total || 0), 0) / n,
    irritated: by((r) => r.score.irritation.length > 0),
    messages: runs.reduce((a, r) => a + r.score.touches, 0) / n,
    medianCloseH: closeH.length ? closeH[Math.floor(closeH.length / 2)] : null,
    wrongDrop: by((r) => r.wrongDrop === true),
    coldConfirmed: runs.filter((r) => r.room.cold && r.score.outcome === 'confirmed').length,
    coldGraceful: runs.filter((r) => r.room.cold && r.score.outcome === 'graceful_exit').length,
  };
}

// The one thing a real room can never tell us and a simulated one can: would
// it have closed WITHOUT the offer to drop it? A graceful exit scores as a
// success (the owner's own criterion), which makes "offer to drop everything"
// look perfect unless an exit from a room that would have confirmed is counted
// as what it is — a coordination we talked people out of. So every run with a
// drop offer is replayed without one, on the same people, and a graceful exit
// whose twin CONFIRMED is a `wrongDrop` and not a success.
function runPolicy(policy, { rooms = 1000, seed0 = 1 } = {}, cal = CALIBRATION) {
  const runs = [];
  for (let i = 0; i < rooms; i++) {
    const room = makeRoom(seed0 + i, cal);
    const run = simulate(room, policy, cal);
    if (run.score.outcome === 'graceful_exit') {
      const twin = simulate(room, { ...policy, dropOfferAfterQuietH: null }, cal);
      if (twin.score.outcome === 'confirmed') { run.wrongDrop = true; run.score = { ...run.score, success: false }; }
    }
    runs.push(run);
  }
  return summarise(runs);
}

module.exports = { CALIBRATION, CURRENT, makeRoom, simulate, runPolicy, summarise, draw };
