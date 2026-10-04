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

const { withoutPrivacyLine } = require('./onboarding');

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
// The same reply for somebody the room's COLD INVITE already reached
// (`group-meetings.coldInvite`): that message said who she is, that she is an
// AI and which room, and promised "if you reply here I'll add you". Their
// reply is the yes, and the greeter's short opening was then a second
// introduction a minute after the first — to every newcomer in
// "חייב קבוצה לפוקר" (`incidents.md`, "Introduced twice, by the invite and the
// greeter"). So it keeps the promise and the privacy link, which the invite
// did not carry, and drops the hello.
const INVITED_ANSWER = {
  he: 'מעולה, מצרפת אותך ושולחת לך עכשיו את התיאום מ«{subject}» ☺️\n'
    + 'מה אני שומרת ואיך מוחקים: https://allma.world/privacy',
  en: 'Great, adding you and sending you the plan from «{subject}» now ☺️\n'
    + 'What I keep and how to delete it: https://allma.world/privacy',
};
// What survives the model saying the block: the tail of the room line, after
// the subject — which is somebody else's text and may have been trimmed. The
// invited answer puts the subject at the END, so its mark is the part before.
const ROOM_OPENING_MARKS = [
  '— שולחת לך עכשיו את התיאום שפתוח שם',
  "— I'm sending you the plan being arranged there now",
  'מצרפת אותך ושולחת לך עכשיו את התיאום',
  'adding you and sending you the plan from',
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
//
// "Will be let into" is `group-meetings.admitLateMembers`' own condition: a
// coordination still negotiating, OR one already settled whose start is still
// ahead. Until 2026-10-03 this read negotiating only, so הוד, sent by a room
// whose poker night was set for that evening, got the owner's long opening,
// the welcome follow-up at once, and the poker 35 seconds behind it — three
// messages in a minute, where the room design is the coordination first and
// what Olma is the next morning (`incidents.md`, "Three messages in a minute,
// to somebody a settled room sent").
async function roomFor(client, phone) {
  if (!phone) return null;
  const { rows } = await client.query(
    `SELECT g.id, g.subject, g.state, m.id AS meeting_id
       FROM chat_group_members cm
       JOIN chat_groups g ON g.id = cm.group_id AND g.state <> 'retired'
       LEFT JOIN LATERAL (
         SELECT id FROM meetings
          WHERE group_id = g.id AND settle_due_at IS NULL
            AND (status = 'negotiating'
                 OR (status = 'confirmed' AND confirmed_start_at > now()))
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
//
// `introduced` is somebody the greeter (or their own agent) already opened
// for, on an earlier day whose session the gateway has since reset: the room
// is still news to them, the opening and its privacy link are not
// (introducedBlock below). The short opening loses its privacy line for them.
//
// `invited` is somebody this room's cold invite reached: the reply is the
// INVITED_ANSWER, never a second hello.
function contextFor(room, { introduced = false, invited = false } = {}) {
  if (room.meetingId) {
    const strip = (t) => (introduced ? withoutPrivacyLine(t) : t);
    const words = invited ? INVITED_ANSWER : ROOM_OPENING;
    const he = strip(words.he.replace('{subject}', room.subject));
    const en = strip(words.en.replace('{subject}', room.subject));
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
    introduced
      ? 'In your FIRST reply only, say this one line, exactly as written —'
      : 'In your FIRST reply only, put this one line directly under the opening text,',
    'exactly as written — the Hebrew one if they wrote Hebrew, otherwise the English one.',
    'Say nothing else about the group; the line is the whole of it.',
    `Hebrew: ${l.he}`,
    `English: ${l.en}`,
  ].join('\n');
}

// The privacy link reaches each person ONCE, ever (owner, 2026-10-01), and
// the greeter is the one voice with no database: its session resets daily, so
// somebody it opened for yesterday — and who has no agent of their own yet — is
// a stranger to it today, and would read the whole opening, link and all, a
// second time. brokerd reads the stamps on their row and hands it this.
const INTRODUCED_BLOCK = [
  'Introduced: this person has ALREADY been introduced to Olma, on an earlier',
  'day. Do NOT say the opening text in your instructions, in any reply, and do',
  'not give the privacy link (allma.world/privacy) unless they ask for it —',
  'they have both. Answer what they wrote, in your own words.',
].join('\n');

// Whether this room's cold invite REACHED them: sent, and not dropped by the
// gate. Keyed on the room, because the answer names it and promises to add
// them to it; an invite from another room introduced her, and the
// `introduced` stamps are what speak for that.
async function coldInviteReached(client, userId, groupId) {
  if (!userId || !groupId) return false;
  const { rows } = await client.query(
    `SELECT 1 FROM outbox
      WHERE user_id = $1 AND kind = 'room_cold_invite' AND idempotency_key = $2
        AND sent_at IS NOT NULL AND hold_reason IS NULL
      LIMIT 1`, [userId, `coldinvite:g${groupId}:u${userId}`]);
  return rows.length > 0;
}

// Whether their row says an introduction already reached them: the owner's
// words recognised (`opening_sent_at`) or the privacy link said by any voice
// (`privacy_link_sent_at`, migration 104).
function wasIntroduced(user) {
  return !!(user && (user.opening_sent_at || user.privacy_link_sent_at));
}

module.exports = {
  INTRODUCED_BLOCK, wasIntroduced, coldInviteReached,
  peerOf, roomFor, linesFor, contextFor, cleanSubject, saidRoomOpening, LINES, ROOM_OPENING, INVITED_ANSWER,
};
