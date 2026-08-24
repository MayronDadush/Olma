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

function renderReminderText(payload) {
  const p = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
  const title = cleanTitle(p.title);
  if (!title) return null;
  return `⏰ תזכורת: ${title}`;
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

module.exports = { renderReminderText, rawPipeTextFor };
