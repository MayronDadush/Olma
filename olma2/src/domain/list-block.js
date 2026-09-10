'use strict';
// The two lists a person asks for by name, drawn by CODE.
//
// `domain/digest-block.js` did this for the morning, and the argument is the
// same one step further out: what a task list LOOKS like is identical every
// time it is read, so a model retyping it each time buys nothing and can lose
// a row. What changes between two readings is the one sentence saying which of
// these matters first, and that is what a model is for.
//
// Two things here are not merely layout, and they are the reason this was
// worth doing at all:
//
//   `list_my_tasks` returns ONE array with `kind` on each row, and the split
//   into "what is on the calendar" and "what is on the plate" was a paragraph
//   of instructions asking the model to do it. A meeting read out as a task is
//   the exact fault `tasks.kind` exists to prevent, and an instruction is a
//   request. Here the two lists cannot mix, because nothing builds a mixed one.
//
//   `list_my_reminders` returned `task_reminders` rows and no title at all, so
//   the model had to go and fetch the tasks to say what a reminder was even
//   about — or say the hour alone. The title is joined on now, and the hour is
//   rendered in THEIR zone rather than handed over as a UTC instant sitting
//   next to a local one, which is how the wrong one gets picked.
//
// `chasing` is deliberately NOT drawn. It is the other half of that answer —
// reminders already climbing, whose next rung depends on when the last one
// landed — and CLAUDE.md's rule is that it is never an hour anybody may say
// out loud. Keeping it out of the block is that rule made structural instead
// of asked for: there is no line for it to be read off.
//
// Same costs as every deterministic sentence in this system: no grammatical
// gender, so nothing below is a verb addressed to anybody, and one set of
// words per language.
const format = require('./message-format');
const digestBlock = require('./digest-block');
const { normalizeRepeatRule } = require('./reminders');

const { WORDS, localeKey, contextFor, line, whenLabel } = digestBlock;

// A list is worth laying out at two items. Below that a heading over a single
// line is heavier than the sentence it replaces — the same threshold the
// layout hint it replaces already used, kept so the two never disagree about
// when a list is a list.
const MIN_LINES = 2;

// Headings only. Everything a LINE needs — weekdays, today, tomorrow, dates —
// is the digest's vocabulary and is read from there, so a day is named the
// same way in every message Olma sends.
const HEADINGS = {
  he: { reminders: 'תזכורות', done: 'הושלמו' },
  en: { reminders: 'Reminders', done: 'Completed' },
};

// The cadence of a repeating reminder, in words — the five canonical forms of
// `reminders.normalizeRepeatRule`, which the rule is put through first rather
// than matched raw. That is not belt and braces: on 2026-08-18 four of five
// reminders on the live database were storing RRULE-style 'FREQ=WEEKLY'
// because the model wrote it and nothing normalised it, and a row like that
// still exists somewhere until it does not. Anything the normaliser refuses
// renders as nothing at all rather than as a guess — a wrong cadence said out
// loud is worse than a missing one, and the next occurrence is on the line
// either way.
const DAY_INDEX = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

// "the 1th of every month" is the shape of a number formatted by somebody who
// was not reading it. Hebrew needs none of this — "כל 1 בחודש" is how it is
// said — so it sits on the English side only.
function ordinal(n) {
  const d = Number(n);
  const teen = d % 100 >= 11 && d % 100 <= 13;
  const suffix = teen ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[d % 10] || 'th');
  return `${d}${suffix}`;
}

const REPEAT = {
  he: {
    daily: 'כל יום',
    weekly: 'כל שבוע',
    oneDay: (name) => `כל יום ${name}`,
    days: (names) => `כל ${names.slice(0, -1).join(', ')} ו${names[names.length - 1]}`,
    monthlyLast: 'בסוף כל חודש',
    monthlyDay: (d) => `כל ${d} בחודש`,
  },
  en: {
    daily: 'every day',
    weekly: 'every week',
    oneDay: (name) => `every ${name}`,
    days: (names) => `every ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`,
    monthlyLast: 'the last day of every month',
    monthlyDay: (d) => `the ${ordinal(d)} of every month`,
  },
};

function repeatLabel(rule, k) {
  const r = String(normalizeRepeatRule(rule) || '').trim().toLowerCase();
  if (!r) return '';
  const words = REPEAT[k];
  if (r === 'daily') return words.daily;
  if (r === 'weekly') return words.weekly;
  if (r === 'monthly:last') return words.monthlyLast;
  const monthDay = /^monthly:(\d{1,2})$/.exec(r);
  if (monthDay) return words.monthlyDay(monthDay[1]);
  if (r.startsWith('weekly:')) {
    const names = r.slice('weekly:'.length).split(',')
      .map((d) => DAY_INDEX[d.trim().toUpperCase()])
      .filter((i) => i !== undefined)
      .map((i) => WORDS[k].weekdays[i]);
    if (!names.length) return words.weekly;
    return names.length === 1 ? words.oneDay(names[0]) : words.days(names);
  }
  return '';
}

function section(f, heading, lines) {
  return `${f.bold(heading)}\n${f.bullets(lines)}`;
}

// `null` and an empty block stay different answers here exactly as they do in
// the digest: an empty list is a real answer and the sentence about it is the
// model's, never an empty heading.
function renderTaskListBlock(data, opts = {}) {
  const f = format.formatterFor(opts.channelType);
  const k = localeKey(opts.locale);
  const w = WORDS[k];
  const ctx = contextFor(opts);
  // A subtask reads as an orphan out of its parent's context ("להביא מטען"),
  // so the list stays at the top level — the same choice the digest and the
  // schedule card already made. The rows are still on the result for a
  // follow-up question about one of them.
  const rows = (Array.isArray(data && data.tasks) ? data.tasks : []).filter((r) => !r.parent_id);

  // What is finished is one list: an event that has already happened is not
  // "on your calendar" any more, and splitting it as though it were would be
  // the tense of the heading arguing with the tense of the row.
  if (opts.status === 'done') {
    const done = rows.map((r) => line(r, ctx, false)).filter(Boolean);
    return done.length >= MIN_LINES ? section(f, HEADINGS[k].done, done) : null;
  }

  const events = rows.filter((r) => r.kind === 'event').map((r) => line(r, ctx, true)).filter(Boolean);
  const tasks = rows.filter((r) => r.kind !== 'event').map((r) => line(r, ctx, false)).filter(Boolean);
  if (events.length + tasks.length < MIN_LINES) return null;

  const sections = [];
  if (events.length) sections.push(section(f, w.calendar, events));
  if (tasks.length) sections.push(section(f, w.todo, tasks));
  return sections.join('\n\n');
}

// One heading, because these are all one kind of thing. The line is the moment
// first and the title after it, the same order and the same separator the
// digest uses — a person reading both in one day should not have to learn two
// layouts.
function renderReminderListBlock(data, opts = {}) {
  const f = format.formatterFor(opts.channelType);
  const k = localeKey(opts.locale);
  const ctx = contextFor(opts);
  const lines = (Array.isArray(data && data.reminders) ? data.reminders : []).map((r) => {
    const title = format.stripUserMarkup(String(r.title || '').replace(/\s+/g, ' ').trim());
    if (!title) return null;
    const when = whenLabel(r.remind_at, ctx, { alwaysTime: true });
    const repeat = repeatLabel(r.repeat_rule, k);
    const head = [when, title].filter(Boolean).join(' — ');
    return repeat ? `${head}, ${repeat}` : head;
  }).filter(Boolean);
  if (lines.length < MIN_LINES) return null;
  return section(f, HEADINGS[k].reminders, lines);
}

module.exports = { renderTaskListBlock, renderReminderListBlock, repeatLabel, MIN_LINES };
