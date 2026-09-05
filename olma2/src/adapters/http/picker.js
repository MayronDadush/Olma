'use strict';
// The availability-picker page: GET renders, POST submits. Public by token —
// the token in the path is the whole credential, same trust model as the
// OAuth callback one route up (random, user-bound, time-limited), except
// deliberately multi-use until expiry so a person can reopen and update.
//
// House rules kept: zero dependencies, one inline stylesheet, one inline
// script. The deliberate departure from the dashboard's no-JS rule is this
// page's own interactivity (tapping dates, building a list) — vanilla JS that
// makes NO network calls of its own; the only request it ever sends is the
// form POST back to this same URL. Everything the viewer sees was fetched
// server-side under their own identity, and the server re-validates every
// submitted option regardless of what the page did.
const { withTx } = require('../../db/pool');
const availability = require('../../domain/availability');

const { esc } = require('./html');
// Embedded JSON must not be able to close its own <script> tag.
const jsonForScript = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

function headers(extra = {}) {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex',
    ...extra,
  };
}

const BASE_CSS = `
:root{--bg:#12151a;--card:#1a1f27;--line:#2a3140;--text:#e6eaf0;--dim:#8b95a5;
--accent:#5b9cf5;--accent-soft:#22334d;--ok:#3ddc84;--danger:#e5735f}
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text);
margin:0;padding:16px;display:flex;justify-content:center;min-height:100vh}
.card{background:var(--card);border-radius:14px;padding:20px;max-width:440px;width:100%}
h1{font-size:17px;margin:0 0 2px;font-weight:600}
.sub{color:var(--dim);font-size:13px;margin:0 0 16px}
.center{text-align:center;align-self:center}
p{color:var(--dim);font-size:14px;line-height:1.6;margin:0}`;

function messagePage(title, body) {
  return `<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>עולמה</title><style>${BASE_CSS}</style></head>
<body><div class="card center"><h1>${esc(title)}</h1><p>${esc(body)}</p></div></body></html>`;
}

// ---- the picker page --------------------------------------------------------

// One colour per daypart, defined ONCE here and referred to everywhere by
// class name — the option chips, the other side's chips, and the daypart
// buttons themselves all read from these, so the mapping a person learns from
// the buttons is the same one they scan their own list with. Colour is always
// a second cue: every badge carries its Hebrew name too.
const PAGE_CSS = `${BASE_CSS}
.card{user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent}
h2{font-size:13px;font-weight:600;color:var(--dim);margin:20px 0 8px}
h2:first-of-type{margin-top:14px}

.meeting{display:inline-flex;align-items:center;gap:8px;background:var(--accent-soft);
border:1px solid #31465f;border-radius:999px;padding:5px 13px 5px 11px;margin-bottom:11px;
font-size:13px;max-width:100%}
.meeting .mt{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.meeting .mi{font-size:14px;line-height:1;flex:none}

.dp{border-radius:6px;padding:3px 8px;font-size:12px;font-weight:600;white-space:nowrap;display:inline-flex;gap:5px;align-items:baseline}
.dp i{font-style:normal;font-weight:500;font-size:11px;opacity:.72}
.dp-morning{background:rgba(230,192,122,.15);color:#e6c07a}
.dp-noon{background:rgba(232,149,99,.15);color:#e89563}
.dp-evening{background:rgba(157,141,241,.17);color:#a99bf5}
.dp-night{background:rgba(143,163,200,.16);color:#8fa3c8}
.dp-all_day{background:rgba(94,201,160,.15);color:#5ec9a0}
.dp-hour{background:rgba(107,166,245,.15);color:#6ba6f5}

.chip{display:inline-flex;align-items:center;gap:8px;background:#20262f;
border:1px solid var(--line);border-radius:10px;padding:6px 10px;font-size:13px;margin:0 0 6px 6px;cursor:pointer}
/* The body wraps when an option names several dayparts; the ✕ never does —
   a remove button that drifts onto its own line stops looking like it
   belongs to the row above it. */
.chip .cbody{display:flex;align-items:center;flex-wrap:wrap;gap:6px}
.chip .x,.chip .tick{flex:none}
.mine .chip{display:flex;width:100%;justify-content:space-between;margin-left:0}
.chip .cdate{font-weight:500}
.chip .x{color:var(--danger);opacity:.6;font-weight:700;font-size:14px;line-height:1;padding:0 2px}
.chip:hover .x{opacity:1}
.chip.adopt{background:transparent}
.chip.adopt .tick{color:var(--dim);font-weight:700;font-size:13px;line-height:1}
.chip.adopted{border-color:rgba(61,220,132,.5);background:rgba(61,220,132,.08)}
.chip.adopted .tick{color:var(--ok)}
.person{font-size:13px;color:var(--dim);margin:10px 0 6px}
.empty{color:#5c6675;font-size:13px}

.months{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}
.mchip{border:1px solid var(--line);background:transparent;color:var(--dim);
border-radius:8px;padding:5px 12px;font-size:13px;cursor:pointer}
.mchip.sel{background:var(--accent-soft);border-color:var(--accent);color:var(--text);font-weight:600}

.grid{display:grid;grid-template-columns:repeat(7,1fr);gap:4px}
.dow{font-size:11px;color:var(--dim);text-align:center;padding:2px 0}
.day{position:relative;aspect-ratio:1;display:flex;align-items:center;justify-content:center;
border-radius:9px;font-size:13px;cursor:pointer;border:1px solid transparent}
.day.blank{cursor:default}
.day:not(.off):not(.past):not(.blank):hover{border-color:var(--line)}
.day.past,.day.off{color:#3d4655;cursor:default}
.day.today{border-color:var(--line)}
.day.sel{background:var(--accent);color:#0b1420;font-weight:600}
.day.inrange{background:var(--accent-soft)}
.day .dot{position:absolute;bottom:4px;right:50%;transform:translateX(50%);
width:4px;height:4px;border-radius:2px;background:var(--danger);opacity:.85}
.day.sel .dot{background:#0b1420;opacity:.5}

.busyline{font-size:12px;color:var(--dim);margin:10px 0 0;line-height:1.7;min-height:20px}
.busyline b{color:var(--text);font-weight:600}

.parts{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.part{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--line);border-radius:999px;
padding:7px 13px;font-size:13px;cursor:pointer;background:transparent;color:var(--text)}
.part .swatch{width:8px;height:8px;border-radius:50%;background:currentColor;opacity:.9}
.part[data-p=morning]{color:#e6c07a}
.part[data-p=noon]{color:#e89563}
.part[data-p=evening]{color:#a99bf5}
.part[data-p=night]{color:#8fa3c8}
.part[data-p=all_day]{color:#5ec9a0}
.part[data-p=hour]{color:#6ba6f5}
.part .txt{color:var(--text)}
.part.sel{border-color:currentColor;background:rgba(255,255,255,.05);font-weight:600}
.part.sel .txt{color:currentColor}
.partnote{font-size:11.5px;color:var(--dim);margin-top:7px;min-height:15px}
input[type=time]{background:var(--bg);border:1px solid var(--line);color:var(--text);
border-radius:8px;padding:8px 10px;font-size:14px;margin-top:8px;display:none}
input[type=time].show{display:block}

.btn{width:100%;border:0;border-radius:10px;padding:12px;font-size:14px;font-weight:600;cursor:pointer;margin-top:10px}
.btn.add{background:var(--accent-soft);color:var(--text);border:1px solid var(--line)}
.btn.send{background:#34c77b;color:#07160d}
.btn.send:not(:disabled):hover{background:#3ddc84}
.btn:disabled{opacity:.45;cursor:default}
.hint{color:var(--danger);font-size:12.5px;margin-top:7px;min-height:17px;font-weight:500}
.count{font-size:12px;color:var(--dim);margin-top:10px}
.mine{min-height:22px;margin-top:6px}
noscript p{margin-top:12px}`;

// The daypart vocabulary the page displays, derived from the domain's own
// PARTS so the times on screen cannot drift from the times the server
// intersects. `hour` has no fixed window — the badge shows the picked time.
const mm = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
const PART_KEYS = [...availability.SPAN_PARTS, 'all_day', 'hour'];
function partsForClient() {
  const out = {};
  for (const key of PART_KEYS) {
    const p = availability.PARTS[key];
    out[key] = { he: p.he, range: p.from == null ? null : `${mm(p.from)}–${mm(p.to)}` };
  }
  return out;
}

const PAGE_JS = `
'use strict';
const P = window.PICK;
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const HEB_DAYS = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];
const HEB_MONTHS = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
const DOW = ['א','ב','ג','ד','ה','ו','ש'];

let selStart = null, selEnd = null;
let picked = [];                       // ticked dayparts, canonical order
let list = P.mine.map((o) => ({ ...o }));
let view = { y: +P.today.slice(0,4), m: +P.today.slice(5,7) };

const pad = (n) => String(n).padStart(2,'0');
const isoOf = (y,m,d) => y+'-'+pad(m)+'-'+pad(d);
const utc = (s) => Date.parse(s+'T00:00:00Z');
const dowOf = (s) => new Date(utc(s)).getUTCDay();
const dLabel = (s) => { const p = s.split('-').map(Number); return 'יום '+HEB_DAYS[dowOf(s)]+' '+p[2]+'.'+p[1]; };
const sLabel = (s) => { const p = s.split('-').map(Number); return p[2]+'.'+p[1]; };
const spanDays = (a,b) => Math.round((utc(b)-utc(a))/86400000)+1;
const keyOf = (o) => [o.start_date,o.end_date,(o.parts||[]).join(','),o.hour||''].join('|');

// The same rules domain/availability.canonicalParts enforces, run here only so
// the buttons answer instantly. The server re-derives this from scratch and
// its answer is the one that gets stored.
function canonical(sel){
  if (sel.includes('hour')) return ['hour'];
  if (sel.includes('all_day')) return ['all_day'];
  const spans = P.spans.filter((k) => sel.includes(k));
  return spans.length === P.spans.length ? ['all_day'] : spans;
}

// The last pickable day — the same horizon the server enforces, so the grid
// can never offer a date the submit would refuse.
const LAST = (() => { const d = new Date(utc(P.today) + P.horizonDays*86400000); return d.toISOString().slice(0,10); })();

// ---- chips ------------------------------------------------------------------

function badge(key, o){
  const meta = P.parts[key];
  const b = document.createElement('span');
  b.className = 'dp dp-'+key;
  b.appendChild(document.createTextNode(key === 'hour' ? o.hour : meta.he));
  if (meta.range) { const i = document.createElement('i'); i.textContent = meta.range; b.appendChild(i); }
  return b;
}
function dateText(o){
  return o.start_date === o.end_date ? dLabel(o.start_date)
    : sLabel(o.start_date)+'–'+sLabel(o.end_date);
}
function chip(o, kind){
  const c = document.createElement('span');
  c.className = 'chip'+(kind === 'adopt' ? ' adopt' : '');
  const body = document.createElement('span'); body.className = 'cbody';
  const d = document.createElement('span'); d.className = 'cdate'; d.textContent = dateText(o);
  body.appendChild(d);
  for (const key of o.parts) body.appendChild(badge(key, o));
  c.appendChild(body);
  return c;
}

function paintMine(){
  const box = $('.mine'); box.innerHTML = '';
  if (!list.length) {
    const e = document.createElement('span'); e.className = 'empty';
    e.textContent = 'עדיין לא סימנת אופציות'; box.appendChild(e);
  }
  list.forEach((o, i) => {
    const c = chip(o, 'mine');
    const x = document.createElement('span'); x.className = 'x'; x.textContent = '✕';
    x.title = 'הסרה';
    c.appendChild(x);
    c.onclick = () => { list.splice(i,1); paintAll(); };
    box.appendChild(c);
  });
  $('.count').textContent = list.length+' / '+P.max+' אופציות';
  $('.send').disabled = list.length === 0;
}

// The other side's options double as buttons: tapping one adopts it, tapping
// it again takes it back off — so the green ✓ always states the truth about
// what is in the list below, not merely that a tap happened.
function paintOthers(){
  const box = $('.others'); if (!box) return;
  box.innerHTML = '';
  const mine = new Set(list.map(keyOf));
  if (P.others.some((p) => p.options.length)) {
    const title = document.createElement('h2');
    title.textContent = 'ההצעות שכבר על השולחן';
    box.appendChild(title);
  }
  for (const person of P.others) {
    if (!person.options.length) continue;
    const h = document.createElement('div'); h.className = 'person';
    h.textContent = person.name+' כבר סימנ/ה — אפשר ללחוץ כדי לאמץ:';
    box.appendChild(h);
    const row = document.createElement('div');
    for (const o of person.options) {
      const c = chip(o, 'adopt');
      const adopted = mine.has(keyOf(o));
      if (adopted) c.classList.add('adopted');
      const t = document.createElement('span'); t.className = 'tick'; t.textContent = adopted ? '✓' : '+';
      c.appendChild(t);
      c.onclick = () => {
        if (adopted) list = list.filter((x) => keyOf(x) !== keyOf(o));
        else if (list.length >= P.max) return say('הגעת ל-'+P.max+' אופציות — אפשר להסיר אחת קודם');
        else list.push({ start_date:o.start_date, end_date:o.end_date, parts:o.parts.slice(), hour:o.hour });
        say(''); paintAll();
      };
      row.appendChild(c);
    }
    box.appendChild(row);
  }
}
const paintAll = () => { paintMine(); paintOthers(); };
const say = (msg) => { $('.hint').textContent = msg ? '✱ '+msg : ''; };

// ---- calendar ---------------------------------------------------------------

function paintMonths(){
  const box = $('.months'); box.innerHTML = '';
  let y = +P.today.slice(0,4), m = +P.today.slice(5,7);
  const endY = +LAST.slice(0,4), endM = +LAST.slice(5,7);
  while (y < endY || (y === endY && m <= endM)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mchip'+(y === view.y && m === view.m ? ' sel' : '');
    b.textContent = HEB_MONTHS[m-1];
    const ty = y, tm = m;
    b.onclick = () => { view = { y:ty, m:tm }; paintMonths(); paintGrid(); };
    box.appendChild(b);
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
}

function paintGrid(){
  const box = $('.grid'); box.innerHTML = '';
  for (const l of DOW) { const d = document.createElement('div'); d.className = 'dow'; d.textContent = l; box.appendChild(d); }
  const first = isoOf(view.y, view.m, 1);
  const days = new Date(Date.UTC(view.y, view.m, 0)).getUTCDate();
  for (let i = 0; i < dowOf(first); i += 1) {
    const b = document.createElement('div'); b.className = 'day blank'; box.appendChild(b);
  }
  for (let d = 1; d <= days; d += 1) {
    const iso = isoOf(view.y, view.m, d);
    const el = document.createElement('div');
    el.className = 'day'+(iso < P.today ? ' past' : '')+(iso > LAST ? ' off' : '')+(iso === P.today ? ' today' : '')
      +(iso === selStart || iso === selEnd ? ' sel' : '')
      +(selStart && selEnd && iso > selStart && iso < selEnd ? ' inrange' : '');
    el.dataset.d = iso;
    el.textContent = d;
    if ((P.busy[iso] || []).length) { const dot = document.createElement('span'); dot.className = 'dot'; el.appendChild(dot); }
    el.onclick = () => pickDay(iso, el);
    box.appendChild(el);
  }
}

function pickDay(iso, el){
  if (el.classList.contains('past') || el.classList.contains('off')) return;
  if (!selStart || (selStart && selEnd)) { selStart = iso; selEnd = null; }
  else if (iso < selStart) { selStart = iso; }
  else if (iso !== selStart) { selEnd = iso; }
  say(''); paintGrid(); paintBusy();
}

function paintBusy(){
  const el = $('.busyline'); el.innerHTML = '';
  if (!selStart) return;
  const head = document.createElement('b');
  head.textContent = selEnd
    ? sLabel(selStart)+'–'+sLabel(selEnd)+' ('+spanDays(selStart,selEnd)+' ימים)'
    : dLabel(selStart);
  el.appendChild(head);
  if (selEnd) return;                     // a range would list too much
  const items = P.busy[selStart] || [];
  if (!items.length) { el.appendChild(document.createTextNode(' — פנוי ביומן')); return; }
  for (const it of items) { const d = document.createElement('div'); d.textContent = '• '+it; el.appendChild(d); }
}

// ---- adding -----------------------------------------------------------------

// Parts are a multi-choice: several spans of one day can suit a person, and
// saying so should cost one option, not three. The two statements that are
// about the WHOLE day — a specific hour, and "all day" — replace a selection
// rather than joining it, and ticking every span silently becomes "all day",
// because that is the same sentence said shorter.
function paintParts(){
  $$('.part').forEach((x) => {
    const on = picked.includes(x.dataset.p);
    x.classList.toggle('sel', on);
    x.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  const hour = picked[0] === 'hour';
  $('#hour').classList.toggle('show', hour);
  $('.partnote').textContent = picked.length > 1
    ? 'נשמר כאופציה אחת עם ' + picked.length + ' חלקי יום'
    : (picked[0] === 'all_day' ? 'סימנת את כל חלקי היום' : '');
}

// Exclusivity has to hold in BOTH directions, and only the second one is
// obvious: ticking "all day" clearly replaces the spans, but ticking a span
// while "all day" (or an hour) is on must replace THAT — otherwise the newest
// tap is the one the page ignores, which is the worst way for a toggle to
// behave.
$$('.part').forEach((el) => { el.onclick = () => {
  const p = el.dataset.p;
  if (picked.includes(p)) picked = canonical(picked.filter((x) => x !== p));
  else if (p === 'hour' || p === 'all_day') picked = [p];
  else picked = canonical(picked.filter((x) => x !== 'hour' && x !== 'all_day').concat([p]));
  say(''); paintParts();
  if (picked[0] === 'hour') $('#hour').focus();
};});

$('.add').onclick = () => {
  if (list.length >= P.max) return say('הגעת ל-'+P.max+' אופציות — אפשר להסיר אחת קודם');
  if (!selStart) return say('בחרו תאריך בלוח');
  if (!picked.length) return say('בחרו חלק של היום');
  if (picked[0] === 'hour' && !$('#hour').value) return say('סמנו שעה');
  const o = { start_date: selStart, end_date: selEnd || selStart, parts: picked.slice(),
    hour: picked[0] === 'hour' ? $('#hour').value : null };
  if (list.some((x) => keyOf(x) === keyOf(o))) return say('האופציה הזו כבר ברשימה');
  list.push(o);
  selStart = null; selEnd = null;
  say(''); paintGrid(); paintBusy(); paintAll();
};

$('#form').onsubmit = () => {
  $('#options').value = JSON.stringify(list.map((o) => (
    { start_date:o.start_date, end_date:o.end_date, parts:o.parts, hour:o.hour })));
  $('.send').disabled = true;
  return true;
};

paintMonths(); paintGrid(); paintParts(); paintAll();
`;

function renderPicker(page, busy) {
  const { title, viewerName, today, mine, others } = page;
  const partButtons = PART_KEYS.map((k) => {
    const p = availability.PARTS[k];
    return `<button type="button" class="part" data-p="${k}" aria-pressed="false" aria-label="${esc(p.he)}">`
      + `<span class="swatch"></span><span class="txt">${esc(p.he)}</span></button>`;
  }).join('');

  return `<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>מתי נוח לך? — עולמה</title><style>${PAGE_CSS}</style></head><body><div class="card">
<div class="meeting"><span class="mi">🗓</span><span class="mt">${esc(title)}</span></div>
<h1>מתי נוח לך${viewerName ? `, ${esc(viewerName)}` : ''}?</h1>
<p class="sub">סמנו כמה אפשרויות שנוח לכם — עולמה תמצא מה מתאים לכולם.</p>
<noscript><p>הדף הזה צריך JavaScript כדי לעבוד. אפשר פשוט לכתוב לעולמה בוואטסאפ מתי נוח לך — זה עובד בדיוק אותו דבר.</p></noscript>
<div class="others"></div>
<h2>בחירת תאריך או טווח</h2>
<div class="months"></div>
<div class="grid"></div>
<div class="busyline"></div>
<h2>באילו חלקים של היום</h2>
<div class="parts">${partButtons}</div>
<input type="time" id="hour" aria-label="שעה">
<div class="partnote"></div>
<button type="button" class="btn add">הוספת אופציה +</button>
<div class="hint" role="status" aria-live="polite"></div>
<h2>האופציות שלך</h2>
<div class="mine"></div>
<div class="count"></div>
<form id="form" method="POST"><input type="hidden" name="options" id="options">
<button class="btn send" type="submit">שליחה ✓</button></form>
</div><script>window.PICK=${jsonForScript({
    max: availability.MAX_OPTIONS,
    horizonDays: availability.HORIZON_DAYS,
    parts: partsForClient(),
    spans: availability.SPAN_PARTS,
    today, mine, others, busy,
  })};${PAGE_JS}</script></body></html>`;
}

// ---- the viewer's own calendar, best-effort ---------------------------------
// The overlay only ever shows the LINK OWNER their own events, fetched under
// their own stored credential — nothing here crosses users. Any failure
// (not connected, needs reauth, Google down) renders the page without it.
async function busyByDate(client, page, calendarDomain) {
  try {
    const cal = calendarDomain || require('../../domain/calendar');
    const res = await cal.listEvents(client, page.userId, availability.HORIZON_DAYS);
    if (!res.ok) return {};
    const out = {};
    const fmtDate = new Intl.DateTimeFormat('en-CA', { timeZone: page.tz });
    const fmtTime = new Intl.DateTimeFormat('en-GB', { timeZone: page.tz, hour: '2-digit', minute: '2-digit', hour12: false });
    for (const e of res.data.events || []) {
      if (!e.start) continue;
      const allDay = !String(e.start).includes('T');
      const date = allDay ? String(e.start) : fmtDate.format(new Date(e.start));
      const label = allDay
        ? `כל היום — ${String(e.title).slice(0, 40)}`
        : `${fmtTime.format(new Date(e.start))}${e.end ? `–${fmtTime.format(new Date(e.end))}` : ''} ${String(e.title).slice(0, 40)}`;
      (out[date] = out[date] || []).push(label);
    }
    return out;
  } catch { return {}; }
}

// ---- HTTP -------------------------------------------------------------------

function readForm(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (d) => { b += d; if (b.length > 64_000) req.destroy(); });
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(b))));
  });
}

function deadLinkPage(res, error) {
  if (error.reason === 'expired') {
    res.writeHead(410, headers());
    return res.end(messagePage('הקישור פג', 'קישורי סימון תקפים לשבוע. אפשר לבקש מעולמה קישור חדש בוואטסאפ.'));
  }
  if (error.reason === 'closed') {
    res.writeHead(410, headers());
    return res.end(messagePage('התיאום הסתיים', 'הפגישה הזו כבר לא בשלב איסוף זמינות. אם משהו השתנה — עולמה בוואטסאפ.'));
  }
  res.writeHead(404, headers());
  return res.end(messagePage('הקישור לא נמצא', 'ייתכן שהקישור שגוי או נמחק. אפשר לבקש מעולמה קישור חדש.'));
}

async function handle(req, res, pool, token, opts = {}) {
  if (req.method === 'GET') {
    const client = await pool.connect();
    try {
      const page = await availability.loadPage(client, token);
      if (!page.ok) return deadLinkPage(res, page.error);
      const busy = await busyByDate(client, page.data, opts.calendarDomain);
      res.writeHead(200, headers());
      return res.end(renderPicker(page.data, busy));
    } finally { client.release(); }
  }
  if (req.method === 'POST') {
    const body = await readForm(req);
    let raw;
    try { raw = JSON.parse(body.options || ''); } catch { raw = null; }
    const result = await withTx(pool, (client) => availability.submit(client, token, raw));
    if (!result.ok) {
      if (result.error.reason) return deadLinkPage(res, result.error);
      res.writeHead(400, headers());
      return res.end(messagePage('משהו לא הסתדר', result.error.message || 'נסו שוב.'));
    }
    res.writeHead(200, headers());
    const saved = result.data.saved === 1 ? 'אופציה אחת נשמרה' : `${result.data.saved} אופציות נשמרו`;
    return res.end(messagePage('נשלח ✓',
      `${saved}. עולמה תמשיך את התיאום בוואטסאפ — אפשר לסגור את הדף.`));
  }
  res.writeHead(405, headers({ Allow: 'GET, POST' }));
  return res.end(messagePage('שגיאה', 'הפעולה לא נתמכת.'));
}

module.exports = { handle, TOKEN_RE: /^\/pick\/([a-f0-9]{48})$/ };
