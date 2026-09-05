'use strict';
// cost — one section of the admin page (see ../index.js).
// Moved verbatim out of adapters/http/dashboard.js on 2026-09-05; the router
// there is what is left of that file.
const flagsDomain = require('../../../../domain/flags');
const infraCost = require('../../../infra-cost');
const { esc } = require('../../html');

// Every dollar figure on the cost page renders in shekels by default, USD
// alongside as the secondary number — the owner's ask, and the natural
// reading for an Israeli-run project where every other figure on the page
// (quiet hours, digest times) is already local. `money()` is built once per
// render from a single fetched rate and closed over by every formatter below,
// so a fetch failure degrades the WHOLE page to USD-only rather than mixing
// currencies row by row depending on which call happened to succeed.
function makeMoney(fx) {
  const rate = fx && fx.configured && !fx.error ? fx.rate : null;
  return (usd, decimals = 2) => {
    const n = Number(usd) || 0;
    const usdStr = `$${n.toFixed(decimals)}`;
    if (!rate) return usdStr;
    // Shekel amounts stay at the same precision as their dollar figure — a
    // $0.003 media generation would round to ₪0 at whole shekels and read as
    // free, which it is not.
    return `₪${(n * rate).toFixed(decimals)} <span class="dim small">(${usdStr})</span>`;
  };
}

// One line per recurring service, or a dim explanatory note when it can't be
// read. colspan spans the purpose column plus both amount columns — a service
// we cannot price still has to occupy its row, so it stays visible as a thing
// being paid for rather than vanishing off the page.
function renderInfraRow(label, state, fmtRow) {
  const note = (text) => `<tr><td>${esc(label)}</td><td class="dim" colspan="3">${esc(text)}</td></tr>`;
  if (!state.configured) return note('לא מוגדר בסביבה');
  if (state.error === 'missing_permission') return note('למפתח אין הרשאה לקרוא נתוני חיוב');
  if (state.error) return note(`שגיאה בשליפת נתונים (${state.error})`);
  return fmtRow(state);
}

// A prepaid balance is "low" when it is close to running out in TIME, not in
// dollars: $2 left is fine on a service nobody uses and an outage tomorrow on
// the one every model call goes through. Where the provider reports its own
// burn rate we use days; where it does not, a flat dollar floor is the honest
// fallback and is labelled as the guess it is.
const LOW_DAYS = 14;

const LOW_USD = 5;

function prepaidLow(s) {
  if (!s.configured || s.error || s.remaining === null || s.remaining === undefined) return false;
  if (s.daysLeft !== null && s.daysLeft !== undefined) return s.daysLeft < LOW_DAYS;
  return s.remaining < LOW_USD;
}

// label · what it is FOR in Olma · how much is left. The purpose column is not
// decoration: a service name alone does not tell the owner whether a line can
// be cancelled, and this page exists to be acted on.
function prepaidRow(label, purpose, s, money) {
  const cell = (inner) => `<tr><td>${esc(label)}</td><td class="dim small">${esc(purpose)}</td>${inner}</tr>`;
  if (!s.configured) return cell('<td class="dim" colspan="2">לא מוגדר בסביבה</td>');
  if (s.error) return cell(`<td class="dim" colspan="2">שגיאה בשליפה (${esc(s.error)})</td>`);
  if (s.remaining === null || s.remaining === undefined) {
    return cell('<td class="dim" colspan="2">לא ניתן לקרוא יתרה</td>');
  }
  const low = prepaidLow(s);
  const left = low
    ? `<td class="warn">⚠ ${money(s.remaining)}</td>`
    : `<td>${money(s.remaining)}</td>`;
  const rate = s.daysLeft !== null && s.daysLeft !== undefined
    ? `<td class="${low ? 'warn' : 'dim'}">≈${Math.floor(s.daysLeft)} ימים בקצב הנוכחי (${money(s.dailyTotal)}/יום)</td>`
    : '<td class="dim">אין קצב שריפה מדווח</td>';
  return cell(left + rate);
}

async function renderInfraCosts(client, money) {
  const c = await infraCost.getInfraCosts();
  const { anthropic, digitalocean, elevenlabs, openrouter, twilio, deepgram, cartesia } = c;

  // Recomputed here rather than inside getInfraCosts: the overrides live in a
  // flag, getInfraCosts has no DB client and a 10-minute cache, and a rate the
  // operator just corrected must show on the very next page load.
  let subscription = c.subscription;
  try {
    const overrides = (await flagsDomain.getFlag(client, 'claude_subscription_overrides')) || {};
    subscription = infraCost.subscriptionCost(new Date(), overrides);
  } catch { /* a bad flag value must not cost the whole cost page */ }

  const okAmount = (s, field) => (s.configured && !s.error ? Number(s[field] || 0) : 0);
  // OpenRouter joins both totals: since the cutover it is the real model bill,
  // and leaving it out of the headline made the project look ~3x cheaper to
  // run than it is.
  const sinceTotal = okAmount(anthropic, 'sinceTotal') + okAmount(digitalocean, 'paid')
    + okAmount(elevenlabs, 'sinceTotal') + okAmount(subscription, 'sinceTotal')
    + okAmount(openrouter, 'sinceTotal');
  const monthTotal = okAmount(anthropic, 'monthTotal') + okAmount(digitalocean, 'accrued')
    + okAmount(elevenlabs, 'monthTotal') + okAmount(subscription, 'monthTotal')
    + okAmount(openrouter, 'monthTotal');

  const prepaid = [
    ['OpenRouter', 'כל קריאות המודל: סיכומים, תכנון, זיהוי עובדות, יצירת תמונות ווידאו, שופט הבדיקות', openrouter],
    ['Twilio', 'מספר הטלפון שעולמה מתקשרת ממנו', twilio],
    ['Deepgram', 'זיהוי דיבור בשיחות טלפון חיות', deepgram],
  ];
  const anyLow = prepaid.some(([, , s]) => prepaidLow(s));
  const prepaidRows = prepaid.map(([l, p, s]) => prepaidRow(l, p, s, money)).join('');

  const recurring = [
    renderInfraRow('DigitalOcean', digitalocean, (s) => {
      const creditNote = s.credit ? `<div class="dim small">זיכוי פעיל: -${money(Math.abs(s.credit))} (${esc(s.creditNote || '')})</div>` : '';
      return `<tr><td>DigitalOcean</td><td class="dim small">השרת שהכל רץ עליו</td><td>${money(s.paid)}</td><td>${money(s.accrued)}${creditNote}</td></tr>`;
    }),
    renderInfraRow('ElevenLabs', elevenlabs, (s) =>
      `<tr><td>ElevenLabs</td><td class="dim small">תמלול הודעות קוליות בוואטסאפ</td><td>${money(s.sinceTotal)}</td><td>${money(s.monthTotal)} (${esc(s.tier || '—')})</td></tr>`),
    renderInfraRow('Anthropic', anthropic, (s) =>
      `<tr><td>Anthropic</td><td class="dim small">מפתח הבוט — כמעט לא בשימוש מאז המעבר ל-OpenRouter</td><td>${money(s.sinceTotal)}</td><td>${money(s.monthTotal)}</td></tr>`),
    renderInfraRow('מנוי Claude (אישי)', subscription, (s) =>
      `<tr><td>מנוי Claude (אישי)</td><td class="dim small">${money(s.rate, 0)} לחודש, מחויב ב-27 · מכסה גם את Claude Code${s.overridden ? ' · <b>תעריף מיוחד לחודש הזה</b>' : ''}</td><td>${money(s.sinceTotal)} (${s.count} חיובים)</td><td>${money(s.monthTotal)}</td></tr>`),
  ].join('');

  const cartesiaRow = cartesia.configured
    ? `<tr><td>Cartesia</td><td class="dim small">הקול שעולמה מדברת בו בשיחות טלפון</td>
       <td class="dim" colspan="2">אין API חיוב — צריך לבדוק ידנית ב-play.cartesia.ai</td></tr>`
    : '';

  const warnBanner = anyLow
    ? `<p class="warn">⚠ יתרה נמוכה באחד השירותים המסומנים למטה. כשהיא נגמרת — אין תשובות, אין תזכורות, אין דיג׳סטים.</p>`
    : '';

  return `<h4>עלויות תשתית — כל מה שהפרויקט משלם עליו</h4>
    <div class="stats">
      <div class="stat"><div class="num">${money(sinceTotal)}</div><div class="lbl">סה״כ מתחילת הפרויקט (27/06/2026)</div></div>
      <div class="stat"><div class="num">${money(monthTotal)}</div><div class="lbl">החודש</div></div>
    </div>
    ${warnBanner}
    <h4>יתרה מראש — נגמרת, ואז הכל נעצר</h4>
    <table><tr><th>שירות</th><th>בשביל מה</th><th>נשאר</th><th>לכמה זמן</th></tr>${prepaidRows}${cartesiaRow}</table>
    <h4>חיוב שוטף — נצבר, אין מה שייגמר</h4>
    <table><tr><th>שירות</th><th>בשביל מה</th><th>מתחילת הפרויקט</th><th>החודש</th></tr>${recurring}</table>
    <p class="dim small">הסכומים למעלה כוללים את מה שנצבר בפועל בחיוב השוטף ואת מה שנשרף מהיתרות מראש — לא את מה שהוטען אליהן ועוד לא נוצל.
    שימוש Claude Code שלך מעבר לבוט מכוסה במנוי האישי ואינו חיוב נפרד, כדי לא לספור פעמיים.</p>`;
}

async function renderCost(client) {
  // Days and month totals span BOTH ledgers: usage_ledger is per user, and
  // usage_system_ledger holds the agents nobody owns (main, intake) — real
  // spend that the old sweep dropped on the floor, which is part of why the
  // attributed figure read low for a month.
  const days = await client.query(
    `SELECT date, sum(cost) AS cost, bool_or(est) AS estimated FROM (
       SELECT date, cost_usd AS cost, estimated AS est FROM usage_ledger
       UNION ALL
       SELECT date, cost_usd AS cost, estimated AS est FROM usage_system_ledger
     ) x GROUP BY date ORDER BY date DESC LIMIT 14`);
  const top = await client.query(
    `SELECT u.first_name, u.phone, sum(l.total_tokens) AS tokens, sum(l.cost_usd) AS cost
     FROM usage_ledger l JOIN users u ON u.id = l.user_id
     WHERE l.date >= date_trunc('month', CURRENT_DATE)
     GROUP BY u.id ORDER BY cost DESC LIMIT 10`);
  const system = await client.query(
    `SELECT agent_id, sum(cost_usd) AS cost FROM usage_system_ledger
     WHERE date >= date_trunc('month', CURRENT_DATE)
     GROUP BY agent_id ORDER BY cost DESC`);
  // Image+video generation spend — its own ledger and its own block, exactly
  // as asked: this money is billed by OpenRouter per generation (their own
  // usage.cost figure, not token arithmetic), so folding it into the model
  // table would corrupt the Anthropic reconciliation line below.
  const media = await client.query(
    `SELECT u.first_name, u.phone, sum(m.images) AS images, sum(m.videos) AS videos,
            sum(m.cost_usd) AS cost,
            sum(m.cost_usd) FILTER (WHERE m.date = CURRENT_DATE) AS cost_today
     FROM media_usage_ledger m JOIN users u ON u.id = m.user_id
     WHERE m.date >= date_trunc('month', CURRENT_DATE)
     GROUP BY u.id ORDER BY cost DESC`);

  // Fetched once and closed over by every formatter on the page — a fetch
  // failure degrades the WHOLE page to USD-only, never a mix of currencies
  // depending on which call happened to land first.
  const fx = await infraCost.usdIlsRate().catch(() => ({ configured: false }));
  const money = makeMoney(fx);

  const infraHtml = await renderInfraCosts(client, money);

  // Rendered even when empty this month — a cost line that only appears once
  // money was already spent is a cost line nobody was watching.
  const mediaMonth = media.rows.reduce((s, r) => s + Number(r.cost), 0);
  const mediaToday = media.rows.reduce((s, r) => s + Number(r.cost_today || 0), 0);
  const mediaHtml = `<h4>יצירת תמונות ווידאו (OpenRouter)</h4>
    <div class="stats">
      <div class="stat"><div class="num">${money(mediaMonth)}</div><div class="lbl">סה״כ החודש</div></div>
      <div class="stat"><div class="num">${money(mediaToday)}</div><div class="lbl">היום</div></div>
    </div>
    ${media.rows.length
      ? `<table><tr><th>מי</th><th>תמונות</th><th>סרטונים</th><th>עלות</th></tr>
         ${media.rows.map((r) => `<tr><td>${esc(r.first_name || r.phone)}</td><td>${Number(r.images)}</td><td>${Number(r.videos)}</td><td>${money(Number(r.cost), 3)}</td></tr>`).join('')}</table>`
      : '<p class="dim small">לא נוצרו תמונות או סרטונים החודש.</p>'}
    <p class="dim small">חיוב לפי הדיווח של OpenRouter על כל יצירה — נפרד מעלות המודל של השיחות, ולא נכלל בשורת ההתאמה מול Anthropic.</p>`;

  // Voice calls — per-call rows from jobs/voice-usage.js. Twilio's figure is
  // the provider's own (authoritative once settled; a null price is "not
  // settled yet" and is summed as 0 with the count shown). STT/TTS/LLM have
  // no per-call billing API, so their share is an estimate at a fixed rate
  // per MINUTE, labelled as such: Deepgram measured from a real balance drop
  // ($0.100 over 25.5 min of calls, 2026-08-31), Cartesia and the LLM from
  // list prices. Estimates multiply measured minutes — never guessed usage.
  const EST_STT_PER_MIN = 0.0039, EST_TTS_PER_MIN = 0.027, EST_LLM_PER_MIN = 0.006;
  const voice = await client.query(
    `SELECT count(*) AS calls, count(*) FILTER (WHERE twilio_usd IS NULL) AS unsettled,
            COALESCE(sum(duration_sec), 0) AS seconds, COALESCE(sum(twilio_usd), 0) AS twilio
     FROM voice_usage_ledger
     WHERE started_at >= date_trunc('month', CURRENT_DATE) AND duration_sec > 0`);
  const v = voice.rows[0];
  const vMinutes = Number(v.seconds) / 60;
  const vEst = vMinutes * (EST_STT_PER_MIN + EST_TTS_PER_MIN + EST_LLM_PER_MIN);
  const voiceHtml = `<h4>שיחות קול</h4>
    <div class="stats">
      <div class="stat"><div class="num">${Number(v.calls)}</div><div class="lbl">שיחות החודש</div></div>
      <div class="stat"><div class="num">${vMinutes.toFixed(1)}</div><div class="lbl">דקות</div></div>
      <div class="stat"><div class="num">${money(Number(v.twilio), 3)}</div><div class="lbl">Twilio (מדוד)</div></div>
      <div class="stat"><div class="num">≈${money(vEst, 3)}</div><div class="lbl">STT+TTS+מודל (הערכה)</div></div>
    </div>
    <p class="dim small">Twilio לפי המחיר שהוא עצמו מדווח לכל שיחה${Number(v.unsettled) ? ` (${Number(v.unsettled)} שיחות עוד לא תומחרו אצלו — יתעדכן)` : ''};
    ל-Deepgram/Cartesia/מודל אין חיוב פר-שיחה, לכן הערכה לפי דקה מדודה: ‎$${EST_STT_PER_MIN}+$${EST_TTS_PER_MIN}+$${EST_LLM_PER_MIN} לדקה.</p>`;

  if (!days.rows.length) return infraHtml + mediaHtml + voiceHtml + '<p class="dim">עדיין אין נתוני עלות למשתמשים — החישוב רץ כל שעה.</p>';
  const usersTotal = top.rows.reduce((s, r) => s + Number(r.cost), 0);
  const systemTotal = system.rows.reduce((s, r) => s + Number(r.cost), 0);
  const monthTotal = usersTotal + systemTotal;
  const todayRow = days.rows[0];

  // The reconciliation line. Anthropic's own usage_report is the billing
  // truth; this table is our attribution of it. They should track closely, and
  // when they do not that is the signal — a silent gap between the two is
  // exactly how a gauge-read-as-a-counter went unnoticed for a month, with the
  // ledger reporting cents against a real $17.77. Shown always, not only when
  // it breaks, because a check nobody sees passing is a check nobody trusts.
  let reconcile = '';
  try {
    const { anthropic } = await infraCost.getInfraCosts();
    if (anthropic && anthropic.configured && !anthropic.error) {
      const billed = Number(anthropic.monthTotal || 0);
      const diff = billed > 0 ? Math.abs(billed - monthTotal) / billed : 0;
      const ok = diff <= 0.15;
      reconcile = `<p class="${ok ? 'dim' : 'warn'} small">${ok ? '✓' : '⚠'} התאמה מול Anthropic:
        שויך כאן ${money(monthTotal)} · חויב בפועל ${money(billed)}
        (פער ${(diff * 100).toFixed(0)}%)${ok ? '' : ' — מישהו צריך להסתכל על זה'}</p>`;
    }
  } catch { /* the reconciliation is a nicety; never let it break the page */ }

  const anyEstimated = days.rows.some((r) => r.estimated);
  return infraHtml + mediaHtml + voiceHtml + `<h4>עלות מודל לפי משתמש</h4><div class="stats">
      <div class="stat"><div class="num">${money(monthTotal)}</div><div class="lbl">סה״כ החודש</div></div>
      <div class="stat"><div class="num">${money(Number(todayRow.cost))}</div><div class="lbl">היום</div></div>
      <div class="stat"><div class="num">${top.rows.length}</div><div class="lbl">משתמשים פעילים החודש</div></div>
    </div>
    ${reconcile}
    <div class="cols"><div><h4>לפי יום</h4><table><tr><th>תאריך</th><th>עלות</th></tr>
    ${days.rows.map((r) => `<tr><td class="nowrap">${esc(String(r.date).slice(0, 10))}</td><td>${money(Number(r.cost), 3)}${r.estimated ? ' <span class="dim">≈</span>' : ''}</td></tr>`).join('')}</table></div>
    <div><h4>לפי משתמש (החודש)</h4><table><tr><th>מי</th><th>עלות</th></tr>
    ${top.rows.map((r) => `<tr><td>${esc(r.first_name || r.phone)}</td><td>${money(Number(r.cost), 3)}</td></tr>`).join('')}
    ${system.rows.map((r) => `<tr><td class="dim">${esc(r.agent_id)} (מערכת)</td><td class="dim">${money(Number(r.cost), 3)}</td></tr>`).join('')}</table></div></div>
    <p class="dim small">מחושב מהתמלילים עצמם — סכימת הטוקנים בפועל לפי התעריף של כל מודל.
    ${anyEstimated ? 'שורות עם ≈ כוללות מודל בלי תעריף ידוע, שתומחר בתעריף ממוצע. ' : ''}החיוב האמיתי מגיע מ-Anthropic. שער דולר-שקל: ${fx.configured && fx.rate ? `₪${fx.rate.toFixed(3)} ל-$1` : 'לא זמין כרגע'}.</p>`;
}

module.exports = { makeMoney, renderInfraRow, LOW_DAYS, LOW_USD, prepaidLow, prepaidRow, renderInfraCosts, renderCost };
