'use strict';
// Deterministic text for proactive messages that need no model turn.
//
// A reminder is the one proactive kind whose content the person chose
// themselves — their words, their time. Composing it through a full agent turn
// meant every reminder cost a cold-cache model call, and worse, DEPENDED on
// one: during the 2026-08-23 credit outage a daily medication reminder failed
// for 13 hours because the model behind it had no credit. A reminder must not
// be downstream of an LLM billing account.
//
// Tested live 2026-08-24 before building this: `openclaw message send` on the
// raw pipe delivered to a real user with zero model involvement while the
// Anthropic account was still dry. The one real cost is that a raw send never
// enters the person's agent session history (it lands under the DEFAULT
// agent's log — the v1 "--to runs on the main agent" lesson, re-verified), so
// a bare reply like "סיימתי" would reach an agent that never saw the
// reminder. turn_start closes that gap from the DB side: it returns the
// reminders delivered in the last day, because brokerd knows exactly what was
// sent without needing the session to remember it.

// Titles are the user's own words; bound them to one message-safe line.
function cleanTitle(title) {
  return String(title || '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

// Rungs 2 and 3 of the escalation ladder ride this same raw pipe, for the same
// reason — a follow-up about medication must not be downstream of a billing
// account either. What they must NOT be is the same sentence twice: a repeat
// identical to the first message is the drum this system keeps removing. Each
// says what it is and carries its own way out.
//
// Written without grammatical gender on purpose. Deterministic text cannot
// know who it is addressing, and in Hebrew a guess is wrong for half the
// people who read it — so every verb here is an infinitive or first-person.
const FOLLOW_UP = 'בוצע? אפשר לכתוב לי, או להגיד לי להפסיק להזכיר על זה.';
const LAST_CALL = 'זו התזכורת האחרונה על זה — לא אזכיר שוב מיוזמתי. אם עדיין רלוונטי, אפשר להגיד לי מתי להזכיר.';

function renderReminderText(payload) {
  const p = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
  const title = cleanTitle(p.title);
  if (!title) return null;
  const attempt = Number(p.attempt) || 1;
  if (attempt <= 1) return `⏰ תזכורת: ${title}`;
  return `⏰ תזכורת חוזרת: ${title}\n${p.finalAttempt ? LAST_CALL : FOLLOW_UP}`;
}

// ---- group mode -------------------------------------------------------------
// Every word Olma says in a locked group is written here rather than by a
// model, for the same reason reminders are: the group agent is MUTED at the
// gateway while the group is locked (a sendPolicy deny rule), so there is no
// model output to use even if we wanted one. These go out on the raw pipe.
//
// The no-grammatical-gender rule above still holds for anything aimed at one
// person. Group text may use the Hebrew plural, because a group genuinely is
// plural — what it must never do is guess the gender of a single member.
//
// Wording owned by the owner (2026-09-05); these are his sentences, not a
// paraphrase of them. Change them only when he asks.

// A tag only PINGS when the token is a phone number: the gateway attaches
// native mention metadata for `@+<digits>` tokens that match a current
// participant, and WhatsApp then renders each viewer's own saved name for that
// number. Writing "@דני" would look right in the source and reach the group as
// dead text nobody is notified by.
const MAX_TAGS = 8;

function mentionTokens(phones) {
  const list = (phones || []).map((p) => String(p || '').trim()).filter(Boolean);
  const shown = list.slice(0, MAX_TAGS).map((phone) => `@${phone.replace(/^\+?/, '+')}`);
  const rest = list.length - shown.length;
  // A 25-person group with twenty missing would otherwise produce a wall of
  // tags. Judgement call, not an owner decision — say the rest as a number.
  return rest > 0 ? `${shown.join(' ')} ועוד ${rest}` : shown.join(' ');
}

// Olma's own WhatsApp number, so the intro can tag HER — a tag people can
// actually press, rather than a bare "@" that teaches nothing. Overridable by
// env for a second deployment; the literal is the live account (the same
// number `adapters/http/public-pages.js` puts on the public page).
//
// THE HAZARD THIS OPENS, and the guard that closes it: a message tagging her
// is exactly what wakes her, and her own outbound message tags her. The
// gateway drops the echo of a recent outbound of its own
// (`shouldSkipRecentOutboundEcho`, keyed on the message id), but that
// tracking has a lifetime, and a late echo would arrive as a group message
// that mentions her — through the mention gate, into a turn, whose reply tags
// her again. **Her own number must therefore never appear in
// `groupAllowFrom`**: the sender allowlist is the one check that runs before
// mention gating, and it is what makes the loop unreachable rather than
// merely unlikely. `groupAllowFrom` carries the phone numbers of Olma's
// USERS, and she is not one of them.
const SELF_NUMBER = process.env.OLMA_WA_NUMBER || '972559347282';

// The first thing said in a group, on the first message there from anyone.
function renderGroupIntro() {
  return [
    'נעים מאוד, אני עולמה 👋',
    'אני עוזרת לקבוצות לתאם דברים בלי הפינג-פונג: מי פנוי מתי ומי עוד לא ענה.',
    `כשאתם צריכים אותי - תתייגו אותי ${mentionTokens([SELF_NUMBER])}. בלי תיוג אני לא מתערבת מקווה שכולכם מחוברים 🙌`,
  ].join('\n');
}

// kind comes from groups.decideNotice: 'explain' the first time, 'nudge' after.
function renderGroupGateNotice({ kind, missing }) {
  const tags = mentionTokens(missing);
  if (kind === 'nudge') return `עוד מחכה ל: ${tags}  🧐`;
  return [
    'כדי שאוכל לתאם לכם משהו, אני צריכה שכל אחד כאן ישלח לי הודעה - אחרת אין לי דרך לשאול אותו מתי הוא פנוי.',
    `רק אומרת.. עוד לא שלחו לי: ${tags}`,
    '״היי״ בפרטי וזהו, אני מתחילה לעבוד ☺️',
  ].join('\n');
}

// The cap is a flag (`group_max_members`), so the number is passed in rather
// than written into the sentence — a raised cap must not leave her quoting 25.
function renderGroupTooLarge(maxMembers) {
  return `אני מסתדרת טוב עד ${maxMembers} אנשים, וכאן יש יותר - אז לא אתערב פה. בפרטי אני תמיד זמינה.`;
}

// The single decision point the deliverer consults: a non-null return means
// "send this text on the raw pipe, no agent turn". Deliberately narrow —
// checkins and digests are conversational BY DESIGN (the whole 2026-08-20
// checkin redesign was making them personal enough to answer), and a payload
// carrying its own `instruction` is asking for a model turn by definition.
function rawPipeTextFor(row) {
  if (row.kind !== 'reminder') return null;
  const p = typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload || {});
  if (p.instruction) return null;
  return renderReminderText(p);
}

module.exports = {
  renderReminderText, rawPipeTextFor,
  renderGroupIntro, renderGroupGateNotice, renderGroupTooLarge, mentionTokens, MAX_TAGS, SELF_NUMBER,
};
