'use strict';
// The scheduled digest, composed with NO model (owner, 2026-09-15).
//
// Since 2026-09-09 the list in a digest has been drawn in code
// (digest-block.js) and the model's whole job was to relay it and add one
// sentence. Measured over the seven days before this: 60 digest turns, 167
// model calls (2.78 a turn), ~51k prompt tokens a call, 22% of every prompt
// token the bot spent — to send a list that was already finished, a greeting,
// and a line about who has not answered yet. All three are code now.
//
// What still needs a model, and still gets one — `forDelivery` answers null
// and the caller takes the old path, unchanged:
//   * queued updates folded into the digest (`payload.folded`) — those are
//     other rows' sentences, and weaving them in is composition. Measured: 0
//     of 121 digests ever carried one, so this is the rare morning;
//   * a digest merged with another row at delivery (`mergedParts`), a batch
//     (`items`), or a row with its own `instruction`;
//   * a card-sized morning for a phone not yet on
//     `digest_card_without_model_phones` (flags.js says why that starts shut);
//   * anything that throws. A digest the model writes is the old behaviour,
//     never a broken one.
//
// What it costs is what every drawn sentence costs: no grammatical gender and
// no question — so no "what first?" at the end — and one set of words per
// language, which the owner rewords from the admin page (message-templates.js,
// the `digest_*` families).
const format = require('./message-format');
const dt = require('./datetime');
const digest = require('./digest');
const digestBlock = require('./digest-block');
const listBlock = require('./list-block');
const templates = require('./message-templates');
const flags = require('./flags');

// '' = nobody, 'all' = everybody, or E.164s — the shape every phone-list flag
// here has (google-connect-gate.js). No admin exception: this is a rollout,
// not a permission.
function phoneOnList(raw, phone) {
  const s = String(raw ?? '').trim();
  if (s.toLowerCase() === 'all') return true;
  return Boolean(phone) && s.split(/[,\s]+/).filter(Boolean).includes(phone);
}

// Only the parts of the payload a model would have to COMPOSE with. The
// `mayAsk` bit is irrelevant here — nothing drawn ever asks.
function needsModel(row) {
  const p = row && row.payload && typeof row.payload === 'object' ? row.payload : {};
  return Boolean(
    (Array.isArray(p.folded) && p.folded.length)
    || p.mergedParts || p.items || p.instruction || p.pausedNotice
  );
}

const GREETINGS = {
  he: { morning: 'בוקר טוב', afternoon: 'צהריים טובים', evening: 'ערב טוב' },
  en: { morning: 'Good morning', afternoon: 'Good afternoon', evening: 'Good evening' },
};

// Off the hour where THEY are. Never "לילה טוב": in Hebrew that is goodbye.
function greetingFor(localeKey, hour) {
  const g = GREETINGS[localeKey];
  if (hour >= 4 && hour < 12) return g.morning;
  if (hour >= 12 && hour < 17) return g.afternoon;
  return g.evening;
}

// A name only once they said it is theirs (`name_confirmed`) — the column the
// 60-second name rung reads for the same reason. A guessed name, drawn, is a
// guess nobody can take back.
function nameFor(user) {
  if (!user.name_confirmed || !user.first_name) return '';
  return format.stripUserMarkup(String(user.first_name).replace(/\s+/g, ' ').trim());
}

// A placeholder rendered empty leaves its neighbour's space behind; tidy the
// spaces and nothing else — inner line breaks are the owner's.
function tidy(text) {
  return String(text).split('\n').map((l) => l.replace(/ {2,}/g, ' ').trim()).join('\n').trim();
}

function cleanWords(s) {
  return format.stripUserMarkup(String(s || '').replace(/\s+/g, ' ').trim());
}

// The cross-user lines, in the order the old instruction weighed them: being
// owed an answer first ("someone they are waiting on has not answered yet"),
// then owing one. Statements, never questions.
function crossUserLines(cross, lang, wording) {
  const out = [];
  const suffix = lang === 'en' ? '_en' : '';
  const waiting = (cross && cross.awaitingOthers || [])
    .map((m) => {
      const title = cleanWords(m.title || m.proposed_slot);
      const who = (Array.isArray(m.waiting_on) ? m.waiting_on : []).map(cleanWords).filter(Boolean);
      if (!title) return null;
      return who.length ? `${title} (${who.join(', ')})` : title;
    }).filter(Boolean);
  if (waiting.length) out.push(templates.render(`digest_waiting${suffix}`, { items: waiting.join(', ') }, wording));
  const owed = (cross && cross.pendingMeetings || [])
    .map((m) => {
      const title = cleanWords(m.title || m.proposed_slot);
      const who = cleanWords(m.initiator_name);
      if (!title) return null;
      return who ? `${title} (${who})` : title;
    }).filter(Boolean);
  if (owed.length) out.push(templates.render(`digest_owed${suffix}`, { items: owed.join(', ') }, wording));
  return out;
}

// Their Google calendar for the days this digest describes, or [] — a read
// that fails is left out silently, exactly as a model that got an error from
// my_calendar_events would say nothing about it. An event this person's own
// task already mirrors (tasks.calendar_event_id, migration 028) is dropped:
// it is on the list once already.
async function googleEvents(client, userId, { scope, ctx, listEvents }) {
  const { rows: conn } = await client.query(
    `SELECT 1 FROM integrations WHERE user_id = $1 AND provider = 'google_calendar' AND status = 'connected'`,
    [userId]);
  if (!conn.length) return [];
  let res;
  try {
    res = await listEvents(client, userId, 2);
  } catch {
    return [];
  }
  if (!res || !res.ok || !res.data || !Array.isArray(res.data.events)) return [];
  const { rows: mirrored } = await client.query(
    `SELECT calendar_event_id FROM tasks WHERE owner_id = $1 AND calendar_event_id IS NOT NULL`, [userId]);
  const known = new Set(mirrored.map((r) => r.calendar_event_id));
  const lastDay = scope === 'today' ? 0 : 1;
  return res.data.events.filter((ev) => {
    if (known.has(ev.id)) return false;
    const parts = ev.allDay ? listBlock.dateOnlyParts(ev.start) : (ev.start ? dt.partsInZone(ctx.tz, new Date(ev.start)) : null);
    if (!parts) return false;
    const away = digestBlock.daysAway(parts, ctx.todayParts);
    return away >= 0 && away <= lastDay;
  });
}

// When a calendar entry starts, as an instant, for ordering ours and Google's
// into one list. An all-day event sorts at the start of its day where they are.
function startMs(entry, tz) {
  if (entry.google) {
    const ev = entry.google;
    if (ev.allDay) {
      const p = listBlock.dateOnlyParts(ev.start);
      return p ? dt.instantInZone(tz, { ...p, hh: 0, mi: 0, ss: 0 }).getTime() : Infinity;
    }
    return Date.parse(ev.start);
  }
  return entry.task.due_at ? new Date(entry.task.due_at).getTime() : Infinity;
}

const CATEGORY_ICONS = {
  home: 'home', work: 'work', family: 'family', health: 'health', money: 'money', errands: 'shopping', other: 'task',
};
const CARD_WORDS = {
  he: { title: 'תמונת מצב', calendarTag: 'יומן' },
  en: { title: 'Your day', calendarTag: 'Calendar' },
};

function chunked(title, items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push({ title, items: items.slice(i, i + size) });
  return out;
}

// The card's spec, built from the same rows the block is — the calendar
// first, then the dated to-dos in due order, then the undated ones grouped by
// category (the block's own order, digest-block.CATEGORY_ORDER).
function cardSpec({ calendar, tasks, ctx, lang, itemsPerSection }) {
  const w = ctx.w;
  const words = CARD_WORDS[lang];
  const calItems = calendar.map((entry) => {
    if (entry.google) {
      const when = listBlock.calendarEventWhen(entry.google, ctx);
      const text = cleanWords(entry.google.title);
      return when === null || !text ? null
        : { date: when, text, icon: 'calendar', tag: words.calendarTag };
    }
    const text = cleanWords(entry.task.title);
    return text ? { date: digestBlock.rangeLabel(entry.task, ctx), text, icon: 'calendar' } : null;
  }).filter(Boolean);
  const top = tasks.filter((t) => !t.parent_id);
  const todoItem = (t) => {
    const text = cleanWords(t.title);
    return text ? { date: digestBlock.whenLabel(t.due_at, ctx), text, icon: CATEGORY_ICONS[t.category] || 'task' } : null;
  };
  const dated = top.filter((t) => t.due_at).map(todoItem).filter(Boolean);
  const undated = digestBlock.CATEGORY_ORDER
    .flatMap((cat) => top.filter((t) => !t.due_at && (t.category || 'other') === cat))
    .map(todoItem).filter(Boolean);
  const parts = ctx.todayParts;
  return {
    title: words.title,
    subtitle: `${w.day(w.weekdays[dt.weekdayOfParts(parts)])} ${w.date(parts)}`,
    sections: [
      ...chunked(w.calendar, calItems, itemsPerSection),
      ...chunked(w.todo, [...dated, ...undated], itemsPerSection),
    ],
  };
}

// → null (the model path) or { text, card?: { path }, cardFailed? }.
// `text` is ALWAYS the whole message as words, so a card that cannot be drawn
// or sent is never a morning with nothing in it.
async function compose(client, row, opts) {
  const { wording, channelType, now = new Date() } = opts;
  const listEvents = opts.listEvents || require('./calendar').listEvents;
  const renderPng = opts.renderPng || require('./schedule-card').renderPng;
  const saveCard = opts.saveCard || require('./card-store').saveCard;

  if (row.kind !== 'digest' || needsModel(row)) return null;
  const { rows: users } = await client.query(
    `SELECT id, phone, first_name, name_confirmed, locale, timezone, workspace_path, agent_id, digest_scope
       FROM users WHERE id = $1`, [row.user_id]);
  const user = users[0];
  if (!user || !user.agent_id) return null;
  if (!phoneOnList(await flags.getFlag(client, 'digest_without_model_phones'), user.phone)) return null;

  const p = row.payload || {};
  const scope = (p.scope || user.digest_scope) === 'today' ? 'today' : 'full';
  // `summary` draws the full list. It always said "counts", and in practice
  // the model upgraded it to full every morning the counts read like a wall
  // (the old instruction told it to) — so this is what those people actually
  // got, now without the extra call.
  const res = await digest.assemble(client, user.id, scope);
  if (!res.ok) return null;
  const data = res.data;

  const lang = digestBlock.localeKey(user.locale);
  const ctx = digestBlock.contextFor({ locale: user.locale, timezone: user.timezone, now });
  const f = format.formatterFor(channelType);
  const google = await googleEvents(client, user.id, { scope, ctx, listEvents });

  const calendar = [
    ...(data.events || []).map((task) => ({ task })),
    ...google.map((ev) => ({ google: ev })),
  ].sort((a, b) => startMs(a, ctx.tz) - startMs(b, ctx.tz));
  const tasks = data.tasks || [];
  const count = digestBlock.blockItemCount({ events: data.events, tasks }) + google.length;

  const vars = {
    greeting: greetingFor(lang, dt.partsInZone(ctx.tz, new Date(now)).hh),
    name: nameFor(user),
  };
  const suffix = lang === 'en' ? '_en' : '';
  const cross = crossUserLines(data.crossUser, lang, wording);

  if (count === 0) {
    return { text: tidy([templates.render(`digest_empty${suffix}`, vars, wording), ...cross].join('\n\n')), user, count };
  }

  const calLines = calendar.map((entry) => (entry.google
    ? listBlock.calendarEventLine(entry.google, ctx)
    : digestBlock.line(entry.task, ctx, true))).filter(Boolean);
  const todo = digestBlock.renderDigestBlock({ events: [], tasks }, {
    locale: user.locale, timezone: user.timezone, channelType, now,
  });
  const block = [
    calLines.length ? `${f.bold(ctx.w.calendar)}\n${f.bullets(calLines)}` : null,
    todo,
  ].filter(Boolean).join('\n\n');
  const intro = tidy(templates.render(`digest_intro${suffix}`, vars, wording));
  const text = [intro, block, ...cross].filter(Boolean).join('\n\n');

  const min = await flags.getFlag(client, 'digest_card_min_items');
  if (!digestBlock.drawInsteadOfBlock(count, min)) return { text, user, count };

  // A card-sized morning. Not yet open for this phone: the model draws it, as
  // it did yesterday.
  if (!phoneOnList(await flags.getFlag(client, 'digest_card_without_model_phones'), user.phone)) return null;

  const { LIMITS } = require('./schedule-card');
  const rendered = renderPng(cardSpec({ calendar, tasks, ctx, lang, itemsPerSection: LIMITS.itemsPerSection }));
  if (!rendered || !rendered.ok) return { text, user, count, cardFailed: rendered && rendered.error };
  const saved = saveCard(user, rendered.data.png);
  if (!saved || !saved.ok) return { text, user, count, cardFailed: saved && saved.error };
  // The caption is the greeting and the cross-user lines — the list IS the
  // picture, and the same list beside it is the morning twice.
  return { text, caption: [intro, ...cross].join('\n\n'), card: { path: saved.data.path }, user, count };
}

// The deliverer's entry point: its own connection, released before any send,
// and a failure of any kind is the model path rather than a lost digest.
async function forDelivery(pool, row, opts) {
  if (!row || row.kind !== 'digest' || needsModel(row)) return null;
  const client = await pool.connect();
  try {
    return await compose(client, row, opts);
  } catch (e) {
    console.error(`[digest-message] composing outbox ${row.id} failed, the model writes it instead: ${e && e.message}`);
    return null;
  } finally {
    client.release();
  }
}

module.exports = {
  compose, forDelivery, needsModel, greetingFor, phoneOnList, cardSpec, crossUserLines,
};
