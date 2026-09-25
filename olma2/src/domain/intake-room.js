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
// "תכף אשלח" is a promise, so it is said only where something keeps it: a room
// that is open, a coordination still negotiating and not inside its settle
// minute — exactly the conditions `group-meetings.admitLateMembers` lets a
// newly connected member in on, day or night (`jobs/groups.sweepGroupVoice`).
// Anything else gets the line that promises nothing.

const PEER_RE = /^agent:intake:whatsapp:direct:(\+\d{7,15})$/;

const LINES = {
  he: {
    coordination: 'הגעת מהקבוצה «{subject}» — תכף אשלח לך כאן את התיאום שפתוח שם.',
    plain: 'הגעת מהקבוצה «{subject}» — שם אני עוזרת לתאם, וכאן אני בשבילך באופן אישי.',
  },
  en: {
    coordination: 'You came from the group «{subject}» — in a moment I\'ll send you here the plan being arranged there.',
    plain: 'You came from the group «{subject}» — there I help arrange things, and here I\'m here for you personally.',
  },
};

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

function linesFor(room) {
  const shape = room.meetingId ? 'coordination' : 'plain';
  return {
    he: LINES.he[shape].replace('{subject}', room.subject),
    en: LINES.en[shape].replace('{subject}', room.subject),
  };
}

// The block the plugin prepends. It restates the one exception to "add
// nothing to the opening" and bounds it to the first reply, because the
// greeter's own file says the opening is said once.
function contextFor(room) {
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

module.exports = { peerOf, roomFor, linesFor, contextFor, cleanSubject, LINES };
