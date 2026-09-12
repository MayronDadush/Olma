'use strict';
// planned — one section of the admin page (see ../index.js).
// Moved verbatim out of adapters/http/dashboard.js on 2026-09-05; the router
// there is what is left of that file.
const { ago } = require('../html');
const { esc } = require('../../html');
const dt = require('../../../../domain/datetime');
const remindersDomain = require('../../../../domain/reminders');
const proactiveText = require('../../../../domain/proactive-text');
const templatesDomain = require('../../../../domain/message-templates');
const usersDomain = require('../../../../domain/users');
const flagsDomain = require('../../../../domain/flags');

const OUTBOX_STATE = {
  sent: 'נשלחו', ready: 'ממתינות לשליחה',
  night: 'ממתינות לשעה מתאימה', blocked: 'ממתינות (המשתמש במכסה)',
  budget: 'יצטרפו לסיכום הבא', expired: 'פג תוקפן',
  quiet: 'נעצרו — לא עונה', moved: 'המשימה זזה', superseded: 'הוחלפו בשלב הבא',
  awaiting_introduction: 'ממתינות להיכרות',
  settling: 'ממתינות לייצוב המערכת',
  cancelled_by_admin: 'בוטל ע"י מנהל', cancelled: 'התזכורת בוטלה',
};

// Cancelling is a WRITE, never a DELETE. The row carries the idempotency_key
// that stops the sweep which created it from creating it again — delete the
// row and the next tick simply re-queues the same message. So a cancellation
// marks it as already handled (sent_at set, reason recorded) and it stays
// visible as cancelled rather than vanishing.
const CANCELLED_BY_ADMIN = 'cancelled_by_admin';

// Plain-Hebrew name per outbox kind. The dashboard should never make anyone
// learn an internal identifier to understand what Olma is about to say.
const KIND_LABELS = {
  checkin: 'פנייה יזומה',
  introduction: 'היכרות ראשונה',
  reminder: 'תזכורת',
  digest: 'סיכום יומי',
  unblock_summary: 'סיכום אחרי מכסה',
  registration_reopened: 'ההרשמה נפתחה',
  connection_intro: 'הצגה למוזמן',
  connection_request: 'בקשת חברות',
  connection_response: 'תשובה לבקשת חברות',
  share_offer: 'הצעת שיתוף משימה',
  share_response: 'תשובה להצעת שיתוף',
  meeting_invite: 'תיאום פגישה',
  meeting_slot_proposed: 'הצעת מועד לפגישה',
  meeting_confirmed: 'פגישה אושרה',
  meeting_slot_declined: 'מועד נדחה',
  meeting_opt_out: 'יציאה מפגישה',
  tasks_auto_archived: 'משימות שנסגרו מעצמן',
  meeting_rejoined: 'חזרה לתיאום פגישה',
  meeting_withdrawn: 'ביטול הגעה לפגישה',
  meeting_no_match: 'לא נמצא מועד',
  meeting_cancelled: 'פגישה בוטלה',
  calendar_connected: 'יומן חובר',
  calendar_scope_missing: 'חיבור יומן בלי הרשאה — צריך שוב',
  calendar_needs_reauth: 'צריך לחבר יומן מחדש',
  contacts_connected: 'אנשי קשר חוברו',
  contacts_scope_missing: 'חיבור אנשי קשר בלי הרשאה — צריך שוב',
  contacts_needs_reauth: 'צריך לחבר אנשי קשר מחדש',
  google_connect_incomplete: 'חיבור גוגל משולב — חלק לא אושר',
};

// Why a proactive message was chosen — the checkin ladder's rung.
const RUNG_LABELS = {
  onboarding_15m: 'היכרות · 15 דקות',
  onboarding_2h: 'היכרות · שעתיים',
  onboarding_5h: 'היכרות · 5 שעות',
  stuck_meeting: 'פגישה שממתינה לו',
  deadline_risk: 'דדליין מתקרב',
  overload: 'עומס משימות',
  silence: 'שקט ממושך',
  unanswered_repair: 'תיקון הודעה שלא נענתה',
  admin: 'נכתב ידנית מלוח הבקרה',
};

function userLink(u) {
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.phone;
  return `<a href="/user?id=${u.user_id || u.id}">${esc(name)}</a>`;
}

// What a queued row is ABOUT. The payload holds an instruction for the agent,
// never the finished text (the v1 stale-digest rule), so this is deliberately
// a subject line and not a preview — claiming otherwise would be a lie the
// moment the agent words it differently.
function plannedSubject(row) {
  const p = typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload || {});
  if (row.kind === 'reminder' && p.title) return esc(p.title);
  // An operator-written message is the one case where the payload IS worth
  // showing: a person typed it minutes ago and wants to check what they typed.
  // Everything else is an instruction the agent will reword, so showing it
  // would promise wording we cannot keep.
  if (p.rung === 'admin' && p.checkinInstruction) return esc(String(p.checkinInstruction).slice(0, 90));
  // The second case, and the only other one: a reply our own pipe lost, queued
  // to go out on the raw pipe word for word (jobs/unanswered.js). The sentence
  // above about wording we cannot keep is exactly what does NOT apply here —
  // no agent will reword it, because no agent is in the path.
  if (p.verbatimReply) return esc(String(p.verbatimReply).slice(0, 90));
  if (row.kind === 'checkin' && p.rung) return RUNG_LABELS[p.rung] || esc(p.rung);
  if (p.title) return esc(String(p.title).slice(0, 60));
  return '<span class="dim">—</span>';
}

// The 7-day outbox rollup and the failures table used to be their own section
// ("הודעות יוצאות"); they are about the same queue this section shows, so they
// lead it as one block. renderOutbox is unchanged below.
// A SECTIONS entry is called as render(client, csrf, gateway, opts) — four
// positional arguments — so nothing may be added to this signature: a third
// parameter here silently receives the cached gateway. The clock a test needs
// to pin is injected into `renderPlannedQueue`, which is what production calls
// one line down.
async function renderPlanned(client) {
  return `<h4>הודעות יוצאות — 7 ימים אחרונים</h4>${await renderOutbox(client)}${await renderPlannedQueue(client)}`;
}

// The cross-user review screen: everything Olma plans to say, to everybody,
// grouped by the person who will read it. Grouped rather than one flat
// stream, because the question this page is opened with is "is the product
// behaving for this person" — a person's whole upcoming plan has to be
// readable in one block, and a duplicate is only obvious beside its twin.
// Ordered by whose message lands first.
async function renderPlannedQueue(client, now = new Date()) {
  const ctx = await planContext(client, now);
  // Anyone with something planned, from all three places at once — a person
  // whose only upcoming message is a digest has no outbox row and no pending
  // reminder, and a queue-driven list would leave them off entirely.
  const { rows: people } = await client.query(
    `SELECT u.*,
            (SELECT count(DISTINCT o.sent_at) FROM outbox o
              WHERE o.user_id = u.id AND o.sent_at > now() - interval '7 days'
                AND o.hold_reason IS NULL) AS sent_7d
       FROM users u
      WHERE EXISTS (SELECT 1 FROM outbox o WHERE o.user_id = u.id AND o.sent_at IS NULL)
         OR EXISTS (SELECT 1 FROM task_reminders r JOIN tasks t ON t.id = r.task_id
                     WHERE t.owner_id = u.id AND r.sent_at IS NULL AND r.cancelled_at IS NULL)
         OR (u.digest_times IS NOT NULL AND u.digest_times <> '' AND u.status = 'active')`);

  const blocks = [];
  for (const u of people) {
    const rows = await planFor(client, u, ctx);
    if (!rows.length) continue;
    const shown = rows.slice(0, NEXT_LIMIT);
    const more = rows.length - shown.length;
    blocks.push({
      sortAt: shown[0].sortAt,
      html: `<h4>${userLink(u)} <span class="dim small">${esc(u.timezone || 'UTC')}
        · ${Number(u.sent_7d)} הודעות יזומות ב-7 ימים${
        Number(u.checkin_misses) > 0 ? ` · לא ענה על ${Number(u.checkin_misses)} פניות` : ''}</span></h4>
      <table><tr><th>ההודעה</th><th>קשור ל</th><th>מתי תגיע</th><th>מצב</th></tr>
      ${shown.map((r) => `<tr${r.bad ? ' class="bad"' : ''}>${planCells(r)}</tr>`).join('')}</table>
      ${more > 0 ? `<p class="dim small">ועוד ${more} מתוכננות אחריו.</p>` : ''}`,
    });
  }
  blocks.sort((a, b) => a.sortAt - b.sortAt);

  return `${blocks.length ? blocks.map((b) => b.html).join('')
    : '<p class="dim">אין כרגע שום דבר מתוכנן לאף אחד.</p>'}
    <p class="hint">עד ${NEXT_LIMIT} הודעות לאדם, בשעון המקומי שלו, לפי מי שההודעה
      הבאה שלו מוקדמת יותר. שורה עם ✓ יוצאת כלשונה — זה בדיוק הטקסט שיגיע, בלי מודל
      בדרך; בלי ✓ מודל ינסח אותה ברגע השליחה, ולכן מופיע הנושא בלבד.
      השעות עשויות לזוז: הודעה שנופלת בשעות השקט שלו תמתין לבוקר, ומי שכבר קיבל מספיק
      היום — שלו תצטרף לסיכום הבא. פנייה יזומה שהסריקות מחליטות עליה בזמן אמת נולדת רק
      ברגע ההחלטה, ולכן אינה כאן. הספירה של 7 הימים היא המספר היחיד כאן שמסתכל אחורה.</p>`;
}

// ---- what Olma is about to say, to one person ------------------------------
// Built once and read by both views: the cross-user review screen and one
// person's own page. They differ in what they wrap around it (a name, the
// reschedule controls), never in what they believe is coming — two readers
// answering the same question differently is how this page lost twelve
// people off the bottom of its cost table.
//
// It is decided in three separate places, and a reader of only one of them
// sees an empty page: the outbox holds what is already queued (minutes
// away), `task_reminders` holds the moments people asked for and gets an
// outbox row only when the sweep brings it due, and the daily digest has no
// row anywhere until its minute arrives.
const NEXT_LIMIT = 10;

// One formatter for all three sources, so a moment reads the same way whether
// Postgres or Node produced it. Their zone, never the operator's.
// Wrapped, like nextDigest below: `Intl` throws a RangeError on a zone string
// it does not know and on an invalid instant alike, and one bad `users` row
// must not 500 the whole admin page. A moment that cannot be read prints as
// unknown — never as now, and never as nothing.
function localStamp(tz, at) {
  try {
    const p = dt.partsInZone(tz || 'UTC', new Date(at));
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(p.d)}/${pad(p.m)} ${pad(p.hh)}:${pad(p.mi)}`;
  } catch { return '?'; }
}

// The next digest slot that is still ahead of them, in their own zone. The
// conditions are sweepDigests' own: a paused, inactive, eval or not-yet-
// onboarded person is never visited by it, and printing an hour for one would
// promise a message that is never coming.
function nextDigest(u, now) {
  try { return nextDigestAt(u, now); } catch { return null; }
}

function nextDigestAt(u, now) {
  if (!u.digest_times || u.status !== 'active' || u.paused_at || u.is_eval || !u.onboarded_at) return null;
  const tz = u.timezone || 'UTC';
  const p = dt.partsInZone(tz, now);
  let best = null;
  for (const raw of String(u.digest_times).split(',')) {
    const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(raw);
    if (!m) continue;
    const hh = Number(m[1]), mi = Number(m[2]);
    // Today's slot if it has not passed, otherwise tomorrow's. Day 32 of a
    // month is what Date.UTC rolls over for us, so no month-end special case.
    for (const plus of [0, 1]) {
      const at = dt.instantInZone(tz, { y: p.y, m: p.m, d: p.d + plus, hh, mi, ss: 0 });
      if (at > now) {
        if (!best || at < best.at) best = { at, slot: `${String(hh).padStart(2, '0')}:${m[2]}` };
        break;
      }
    }
  }
  return best;
}

// The sentence that will actually arrive, WHERE THERE IS ONE. Most rows carry
// an instruction a model will word at send time, and showing that as the
// message would promise wording we cannot keep — the rule this section has
// always followed. But a reminder and a re-sent lost reply go out on the raw
// pipe with no model in the path, so their text is already decided and can be
// read now, which is the whole point of a page someone reviews the product
// on. `rawPipeTextFor` is the deliverer's own decision point, not a copy of
// it: a non-null return is exactly the string the pipe will carry.
function verbatimFor(row, ctx) {
  try { return proactiveText.rawPipeTextFor(row, ctx.wording, ctx.channelType) || null; }
  catch { return null; }
}

// Everything Olma plans to say to one person, in the order it lands. `ctx`
// carries what is read once per PAGE rather than once per person: the owner's
// rewordings, the escalation ceiling, and the clock.
async function planFor(client, u, ctx) {
  const tz = u.timezone || 'UTC';
  const rows = [];
  const chan = await usersDomain.primaryChannel(client, u.id);
  const one = { ...ctx, channelType: chan.ok ? chan.data.channel.channel_type : null };

  const { rows: queued } = await client.query(
    `SELECT o.id, o.kind, o.hold_reason, o.attempts, o.payload, o.release_after,
            to_char(o.release_after AT TIME ZONE COALESCE($2, 'UTC'), 'YYYY-MM-DD"T"HH24:MI') AS release_input,
            to_char(o.expires_at   AT TIME ZONE COALESCE($2, 'UTC'), 'YYYY-MM-DD"T"HH24:MI') AS expires_input
     FROM outbox o WHERE o.user_id = $1 AND o.sent_at IS NULL
     -- No LIMIT: the caller caps what it SHOWS and then prints how many it did
     -- not, and a limit here would silently understate that count. The set is
     -- small by construction — the daily proactive budget and row expiry both
     -- bound it.
     ORDER BY COALESCE(o.release_after, o.created_at)`, [u.id, u.timezone]);

  for (const r of queued) {
    const text = verbatimFor({ ...r, locale: u.locale }, one);
    rows.push({
      // A row with no release_after goes on the next tick, so it sorts ahead
      // of everything with a stated hour rather than to the end.
      sortAt: r.release_after ? new Date(r.release_after).getTime() : 0,
      message: text ? esc(text) : plannedSubject(r),
      verbatim: Boolean(text),
      source: KIND_LABELS[r.kind] || esc(r.kind),
      when: r.release_after ? esc(localStamp(tz, r.release_after)) : '<span class="dim">מיד</span>',
      state: r.hold_reason ? (OUTBOX_STATE[r.hold_reason] || esc(r.hold_reason))
        : (r.attempts > 0 ? `נסיון ${r.attempts}` : '<span class="dim">בדרך</span>'),
      bad: r.attempts > 0,
      outbox: r,
    });
  }

  // The domain function production itself calls, not a copy of its WHERE
  // clause: it is the one place that knows both "still going to fire"
  // (attempts = 0) and "already climbing and still going to reach them"
  // (chasing), and a hand-copied replica here could not fail when it drifts.
  const rem = (await remindersDomain.listReminders(client, u.id)).data;

  // Reminders that come due together leave as ONE message, so they are ONE
  // row here — three lines under one hour, which is also the shape in which a
  // duplicate is obvious. The worker groups by rung template within a tick;
  // this groups by rung template within a MINUTE, which is the one honest
  // approximation available to a page with no tick: it can only ever show as
  // two what will arrive as one, never the reverse.
  const batches = new Map();
  for (const r of rem.reminders || []) {
    const base = { title: r.title, rung: 1, auto: r.auto };
    const at = new Date(r.remind_at);
    const key = `${at.toISOString().slice(0, 16)}|${proactiveText.reminderTemplateKey(base)}`;
    const b = batches.get(key) || { at, titles: [], repeat: r.repeat_rule, base };
    b.titles.push(r.title);
    batches.set(key, b);
  }
  for (const b of batches.values()) {
    const text = verbatimFor(
      { kind: 'reminder', locale: u.locale, payload: { ...b.base, items: b.titles } }, one);
    rows.push({
      sortAt: b.at.getTime(),
      message: text ? esc(text) : esc(b.titles.join(' · ')),
      verbatim: Boolean(text),
      source: `תזכורת${b.titles.length > 1 ? ` <span class="dim">· ${b.titles.length} ביחד</span>` : ''}${
        b.repeat ? ` <span class="dim">· חוזרת ${esc(b.repeat)}</span>` : ''}`,
      when: esc(localStamp(tz, b.at)),
      state: b.at <= ctx.now ? '<span class="pill">באיחור</span>' : '<span class="dim">תיכנס לתור בזמנה</span>',
    });
  }

  // A reminder mid-ladder has one or two messages still to send and was
  // invisible in every reader that asked `attempts = 0` — the row Olma was
  // asked to stop was the one row nothing could name. It belongs here for
  // exactly that reason, and its HOUR does not: the next rung is due a gap
  // after the previous one was DELIVERED, so any time printed for it would be
  // a guess. The SENTENCE is not a guess, and it is the one worth reading
  // before it goes out — "זו התזכורת האחרונה" is what seven people got wrongly
  // once already.
  for (const r of rem.chasing || []) {
    const attempt = Number(r.rungsSent) + 1;
    const payload = { title: r.title, rung: attempt, attempt, finalAttempt: attempt >= ctx.maxAttempts };
    const text = verbatimFor({ kind: 'reminder', locale: u.locale, payload }, one);
    rows.push({
      // Finite on purpose: two Infinities subtract to NaN, and a comparator
      // that returns NaN orders nothing.
      sortAt: Number.MAX_SAFE_INTEGER,
      message: text ? esc(text) : esc(r.title),
      verbatim: Boolean(text),
      source: `תזכורת <span class="dim">· רדיפה, שלב ${attempt}</span>`,
      when: '<span class="dim">אחרי שהשלב הקודם נמסר</span>',
      state: `<span class="dim">נשלחה ${r.rungsSent}×</span>`,
    });
  }

  const digest = nextDigest(u, ctx.now);
  if (digest) {
    rows.push({
      sortAt: digest.at.getTime(),
      message: 'סיכום יומי',
      source: `<span class="dim">קבוע · כל יום ב-${esc(digest.slot)}</span>`,
      when: esc(localStamp(tz, digest.at)),
      state: '<span class="dim">לפי השעה שהוא בחר</span>',
    });
  }

  rows.sort((a, b) => a.sortAt - b.sortAt);
  return rows;
}

// Read once per page, not once per person: the owner's rewordings and the
// escalation ceiling are one setting each, and a value that changed mid-loop
// would render two people's plans under two different rules.
async function planContext(client, now) {
  return {
    now,
    wording: await templatesDomain.load(client),
    maxAttempts: Number(await flagsDomain.getFlag(client, 'reminder_escalation_max'))
      || remindersDomain.ESCALATION_MAX_ATTEMPTS,
  };
}

// A row's three review columns. The ✓ is not a judgement about the message —
// it says only that this text is already decided and no model will touch it,
// which is the difference between reading what will arrive and reading a
// summary of what it will be about.
function planCells(r) {
  return `<td class="small${r.verbatim ? ' verbatim' : ''}">${
    r.verbatim ? '<span class="dim" title="יוצא כלשונו — אין מודל בדרך">✓</span> ' : ''}${r.message}</td>
      <td class="small">${r.source}</td>
      <td class="nowrap small">${r.when}</td>
      <td class="small">${r.state}</td>`;
}

// The same question narrowed to one person, off the same builder, with the
// controls the review screen has no room for: reschedule and cancel, and the
// box for writing a proactive message by hand.
async function renderPlannedForUser(client, u, csrf = '', now = new Date()) {
  const back = `/user?id=${u.id}`;
  const hidden = `<input type="hidden" name="csrf" value="${csrf}">
      <input type="hidden" name="back" value="${back}">`;
  const rows = await planFor(client, u, await planContext(client, now));
  const shown = rows.slice(0, NEXT_LIMIT);
  // Never a silent cut: the same page had a top-ten on its cost table for
  // months and nothing on it said so.
  const more = rows.length - shown.length;

  const { rows: cancelled } = await client.query(
    `SELECT id, kind, payload, sent_at FROM outbox
      WHERE user_id = $1 AND hold_reason = $2 ORDER BY id DESC LIMIT 5`, [u.id, CANCELLED_BY_ADMIN]);

  // Only a row that really is in the outbox can be moved or cancelled; a
  // reminder that has not been queued yet and a digest that has no row at all
  // have nothing for these forms to address.
  const actionsFor = (r) => (r.outbox ? `<form method="post" action="/outbox/reschedule" class="inline">${hidden}
      <input type="hidden" name="id" value="${r.outbox.id}">
      <input type="datetime-local" name="release_after" value="${esc(r.outbox.release_input || '')}"
             title="ריק = לשלוח בהזדמנות הקרובה">
      <input type="datetime-local" name="expires_at" value="${esc(r.outbox.expires_input || '')}"
             title="אחרי המועד הזה ההודעה כבר לא תישלח. ריק = בלי תפוגה.">
      <button>שמור מועד</button></form>
      <form method="post" action="/outbox/cancel" class="inline">${hidden}
      <input type="hidden" name="id" value="${r.outbox.id}">
      <button class="danger">בטל</button></form>` : '');

  const nextHtml = shown.length ? `<table>
    <tr><th>ההודעה</th><th>קשור ל</th><th>מתי תגיע</th><th>מצב</th><th></th></tr>
    ${shown.map((r) => `<tr${r.bad ? ' class="bad"' : ''}>${planCells(r)}
      <td>${actionsFor(r)}</td>
    </tr>`).join('')}</table>
    ${more > 0 ? `<p class="dim small">ועוד ${more} מתוכננות אחריהן.</p>` : ''}`
    : '<p class="dim">אין כרגע שום דבר מתוכנן אליו.</p>';

  const cancelledHtml = cancelled.length ? `<h4>בוטלו ע"י מנהל</h4>
    <table><tr><th>סוג</th><th>בנושא</th><th>מתי בוטל</th></tr>
    ${cancelled.map((r) => `<tr><td class="dim">${KIND_LABELS[r.kind] || esc(r.kind)}</td>
      <td class="small dim">${plannedSubject(r)}</td>
      <td class="dim small nowrap">${ago(r.sent_at)}</td></tr>`).join('')}</table>
    <p class="hint">שורה שבוטלה נשארת במקומה בכוונה — היא זו שמונעת מהתהליך שיצר אותה
      ליצור אותה שוב. היא לא נשלחה ואינה נספרת במכסת ההודעות היומית שלו.</p>` : '';

  const composeHtml = `<h4>לכתוב הודעה יזומה</h4>
    <form method="post" action="/outbox/new">${hidden}
      <input type="hidden" name="user_id" value="${u.id}">
      <p><textarea name="instruction" rows="2" style="width:100%"
         placeholder="מה עולמה צריכה לעשות — למשל: שאלי אותו איך הלך הראיון אתמול"></textarea></p>
      <p class="small">
        <label>דחיפות
          <select name="urgency">
            <option value="normal">רגילה — מכבדת את המכסה היומית</option>
            <option value="urgent">דחופה — עוקפת מכסה, לא עוקפת שעות שקט</option>
          </select></label>
        <label>מתי <input type="datetime-local" name="release_after" title="ריק = בהקדם"></label>
        <button>הוסף לתור</button>
      </p>
      <p class="hint">זו הנחיה לעולמה, לא טקסט שיישלח כלשונו — היא תנסח בעצמה, בשפה שלו.
        ההודעה עוברת את אותו שער כיבוד כמו כל הודעה יזומה: אם השעה אצלו שעת שקט
        היא תמתין לבוקר, ואם הוא כבר קיבל מספיק היום היא תצטרף לסיכום הבא.</p>
    </form>`;

  return `<section><h3>מה מתוכנן להישלח אליו</h3>
    <p class="hint">${NEXT_LIMIT} ההודעות היזומות הבאות, בשעון המקומי שלו (${esc(u.timezone || 'UTC')}).
      שורה עם ✓ יוצאת כלשונה — זה בדיוק הטקסט שיגיע; בלי ✓ מודל ינסח אותה ברגע השליחה,
      ולכן מופיע הנושא בלבד. השעות עשויות לזוז: הודעה שנופלת בשעות השקט שלו תמתין לבוקר,
      ומי שכבר קיבל מספיק היום — שלו תצטרף לסיכום הבא.
      פנייה יזומה שהסריקות מחליטות עליה בזמן אמת נולדת רק ברגע ההחלטה, ולכן אינה כאן.</p>
    ${nextHtml}
    ${cancelledHtml}
    ${composeHtml}
  </section>`;
}

// ---- what Olma learned, editable ---------------------------------------------
// Preferences and facts are two different things and are shown as two tables,
// because confusing them is the most likely operator mistake: a preference
// steers how Olma behaves, a fact is something true about the person.

async function renderOutbox(client) {
  const { rows } = await client.query(
    `SELECT coalesce(hold_reason, CASE WHEN sent_at IS NULL THEN 'ready' ELSE 'sent' END) AS state, count(*) AS n
     FROM outbox WHERE created_at > now() - interval '7 days' GROUP BY 1 ORDER BY 1`);
  const failures = await client.query(
    `SELECT id, kind, attempts, last_error FROM outbox
     WHERE sent_at IS NULL AND attempts > 0 ORDER BY attempts DESC LIMIT 5`);
  if (!rows.length) return '<p class="dim">לא נשלחו הודעות יזומות בשבוע האחרון.</p>';
  return `<div class="stats">${rows.map((r) =>
      `<div class="stat"><div class="num">${r.n}</div><div class="lbl">${OUTBOX_STATE[r.state] || esc(r.state)}</div></div>`).join('')}</div>
    ${failures.rows.length ? `<div class="banner bad">⚠ הודעות שנכשלו בשליחה</div><table>
      <tr><th>סוג</th><th>נסיונות</th><th>שגיאה</th></tr>
      ${failures.rows.map((f) => `<tr class="bad"><td>${esc(f.kind)}</td><td>${f.attempts}</td>
        <td class="dim small">${esc((f.last_error || '').slice(0, 80))}</td></tr>`).join('')}</table>` : ''}`;
}

module.exports = { OUTBOX_STATE, CANCELLED_BY_ADMIN, KIND_LABELS, RUNG_LABELS, userLink, plannedSubject, renderPlanned, renderPlannedQueue, renderPlannedForUser, renderOutbox };
