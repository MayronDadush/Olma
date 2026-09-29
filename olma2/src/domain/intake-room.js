'use strict';
// The greeter's one line about the room a newcomer came from.
//
// A room asks a member who has never written to Olma to send "היי" in private,
// and until 2026-09-25 what came back was the owner's opening copy and nothing
// else — the same words a stranger off an ad reads, with no sign she knew why
// they were there. Dana and ORGETZ both answered with a second "היי" before they
// heard anything about "Shabi OG", and at 02:25 the coordination itself waited
// for that second message (`incidents.md`, "Twice 'היי' before a word about
// the room").
//
// The greeter is a model with no tools and no database, so the room is handed
// to it: the gateway plugin sends brokerd the intake session key, whose last
// part is the sender's number, and prepends what comes back. The LINE is ours
// and fixed — two shapes, chosen by whether the room has a live coordination
// this person will be let into — and the model is told to say it word for word
// under the opening, in their language. Gender-neutral on purpose: the greeter
// knows nothing about who is writing, and slashed forms are banned there.
//
// "שולחת לך עכשיו" is a promise, so it is said only where something keeps it: a room
// that is open, a coordination still negotiating and not inside its settle
// minute — exactly the conditions `group-meetings.admitLateMembers` lets a
// newly connected member in on, day or night (`jobs/groups.sweepGroupVoice`).
// Anything else gets the line that promises nothing.
//
// Since 2026-09-29 a room with a coordination waiting for them does not get
// the opening at all, with a line under it. It gets a SHORT opening of its
// own — who she is (an AI, said on the first line), that the coordination is
// on its way, and the privacy link, which is the whole of what the law asks
// of a first message (message-templates, `opening_he`) — and what she helps
// with is said AFTER the coordination: by their own agent's first turn if they
// answer, or by the welcome follow-up the next morning if they do not
// (owner, 2026-09-29: "אפשר להתחיל איתו מהתיאום ואז אחר כך להציג את עצמה").
// Before this, a newcomer read the full introduction, the welcome follow-up
// and the invite inside two minutes — three messages before the one they came
// for. `jobs/intake.js` recognises this opening by its room line
// (`saidRoomOpening`), because the owner's opening's own second line is not in
// it.

const PEER_RE = /^agent:intake:whatsapp:direct:(\+\d{7,15})$/;

const LINES = {
  he: {
    plain: 'הגעת מהקבוצה «{subject}» — שם אני עוזרת לתאם, וכאן אני בשבילך באופן אישי.',
  },
  en: {
    plain: 'You came from the group «{subject}» — there I help arrange things, and here I\'m here for you personally.',
  },
};

// The whole first reply, for the coordination shape. The middle line is the
// one `saidRoomOpening` looks for, so it carries no variable before the dash
// that is not the subject.
const ROOM_OPENING = {
  he: 'היי, אני עולמה 👋 עוזרת AI\n'
    + 'הגעת מהקבוצה «{subject}» — שולחת לך עכשיו את התיאום שפתוח שם.\n'
    + 'מה אני שומרת ואיך מוחקים: https://allma.world/privacy',
  en: "Hey, I'm Allma \u{1F44B} an AI assistant\n"
    + 'You came from the group «{subject}» — I\'m sending you the plan being arranged there now.\n'
    + 'What I keep and how to delete it: https://allma.world/privacy',
};
// What survives the model saying the block: the tail of the room line, after
// the subject — which is somebody else's text and may have been trimmed.
const ROOM_OPENING_MARKS = [
  '— שולחת לך עכשיו את התיאום שפתוח שם',
  "— I'm sending you the plan being arranged there now",
];

function saidRoomOpening(text) {
  if (!text) return false;
  const t = String(text).replace(/\u2019/g, "'");
  return ROOM_OPENING_MARKS.some((m) => t.includes(m));
}

function peerOf(sessionKey) {
  const m = PEER_RE.exec(String(sessionKey || ''));
  return m ? m[1] : null;
}

// Another person's text, going into a line the model is told to repeat
// exactly: one line, no guillemets of its own, short.
function cleanSubject(subject) {
  const s = String(subject || '')
    .replace(/[\p{Cc}«»]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > 60 ? s.slice(0, 60).trim() + '…' : s;
}

// The newest room this number is on, preferring one with a coordination they
// will be let into. The ROSTER, not a user row: the person writing to the
// greeter usually has none yet. A LID-only roster row does not match a phone
// and gets no line — silence is the honest answer to a room we cannot place.
async function roomFor(client, phone) {
  if (!phone) return null;
  const { rows } = await client.query(
    `SELECT g.id, g.subject, g.state, m.id AS meeting_id
       FROM chat_group_members cm
       JOIN chat_groups g ON g.id = cm.group_id AND g.state <> 'retired'
       LEFT JOIN LATERAL (
         SELECT id FROM meetings
          WHERE group_id = g.id AND status = 'negotiating' AND settle_due_at IS NULL
          ORDER BY id DESC LIMIT 1) m ON g.state = 'open'
      WHERE cm.phone = $1 AND cm.left_at IS NULL
      ORDER BY (m.id IS NOT NULL) DESC, g.id DESC
      LIMIT 1`, [phone]);
  const r = rows[0];
  if (!r) return null;
  const subject = cleanSubject(r.subject);
  if (!subject) return null;
  return { groupId: Number(r.id), subject, meetingId: r.meeting_id ? Number(r.meeting_id) : null };
}

// The line under the owner's opening, for a room with no coordination to
// join. A room with one gets ROOM_OPENING instead (contextFor).
function linesFor(room) {
  return {
    he: LINES.he.plain.replace('{subject}', room.subject),
    en: LINES.en.plain.replace('{subject}', room.subject),
  };
}

// The block the plugin prepends. It restates the one exception to "add
// nothing to the opening" and bounds it to the first reply, because the
// greeter's own file says the opening is said once. With a coordination
// waiting, the exception is bigger: the short opening REPLACES the owner's.
function contextFor(room) {
  if (room.meetingId) {
    const he = ROOM_OPENING.he.replace('{subject}', room.subject);
    const en = ROOM_OPENING.en.replace('{subject}', room.subject);
    return [
      'Room: this person reached Olma from a WhatsApp group she is in, and a',
      'coordination there is waiting for them. In your FIRST reply only, say',
      'THIS text INSTEAD of the opening text in your instructions — not beside',
      'it — exactly as written, every character, on its own lines: the Hebrew',
      'one if they wrote Hebrew, otherwise the English one. Add nothing about',
      'what Olma does; that is said after the coordination. If they asked for',
      'something, one short line below it; otherwise stop there.',
      'Hebrew:',
      he,
      'English:',
      en,
    ].join('\n');
  }
  const l = linesFor(room);
  return [
    'Room: this person reached Olma from a WhatsApp group she is in.',
    'In your FIRST reply only, put this one line directly under the opening text,',
    'exactly as written — the Hebrew one if they wrote Hebrew, otherwise the English one.',
    'Say nothing else about the group; the line is the whole of it.',
    `Hebrew: ${l.he}`,
    `English: ${l.en}`,
  ].join('\n');
}

module.exports = {
  peerOf, roomFor, linesFor, contextFor, cleanSubject, saidRoomOpening, LINES, ROOM_OPENING,
};
