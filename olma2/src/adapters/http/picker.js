'use strict';
// The availability-picker page: GET renders, POST submits. Public by token —
// the token in the path is the whole credential, same trust model as the
// OAuth callback one route up (random, user-bound, time-limited), except
// deliberately multi-use until expiry so a person can reopen and update.
//
// House rules kept: server-rendered, zero dependencies, one inline stylesheet.
// The one deliberate departure from the dashboard's no-JS rule is the page's
// own interactivity (tapping dates, building a list) — vanilla inline JS, no
// network calls of its own; the ONLY request it ever makes is the form POST
// back to this same URL. Anything the viewer sees was fetched server-side
// under their own identity.
const { withTx } = require('../../db/pool');
const availability = require('../../domain/availability');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
// Embedded JSON must not be able to close its own <script> tag.
const jsonForScript = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

const HEB_DAY_LETTERS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];
const GRID_WEEKS = 6;

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
<title>אולמה</title><style>${BASE_CSS}</style></head>
<body><div class="card center"><h1>${esc(title)}</h1><p>${esc(body)}</p></div></body></html>`;
}

// ---- the picker page --------------------------------------------------------

const PAGE_CSS = `${BASE_CSS}
.card{user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent}
h2{font-size:13px;font-weight:600;color:var(--dim);margin:18px 0 8px}
.others .person{font-size:13px;color:var(--dim);margin:8px 0 4px}
.chip{display:inline-flex;align-items:center;gap:6px;background:var(--accent-soft);
border:1px solid var(--line);border-radius:999px;padding:6px 12px;font-size:13px;margin:0 0 6px 6px;cursor:pointer}
.chip .x{color:var(--dim);font-weight:700;padding:0 2px}
.chip.adopt{background:transparent}
.grid{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;margin-top:6px}
.dow{font-size:11px;color:var(--dim);text-align:center;padding:2px 0}
.day{position:relative;aspect-ratio:1;display:flex;align-items:center;justify-content:center;
border-radius:9px;font-size:13px;cursor:pointer;border:1px solid transparent}
.day:not(.off):not(.past):hover{border-color:var(--line)}
.day.past,.day.off{color:#3d4655;cursor:default}
.day.today{border-color:var(--line)}
.day.sel{background:var(--accent);color:#0b1420;font-weight:600}
.day.inrange{background:var(--accent-soft)}
.day .dot{position:absolute;bottom:4px;right:50%;transform:translateX(50%);
width:4px;height:4px;border-radius:2px;background:var(--danger)}
.mon{grid-column:1/-1;font-size:12px;color:var(--dim);padding:8px 2px 0}
.busyline{font-size:12px;color:var(--dim);margin:8px 0 0;line-height:1.7;min-height:18px}
.busyline b{color:var(--text);font-weight:600}
.parts{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.part{border:1px solid var(--line);border-radius:999px;padding:7px 14px;font-size:13px;cursor:pointer;background:transparent;color:var(--text)}
.part.sel{background:var(--accent);border-color:var(--accent);color:#0b1420;font-weight:600}
input[type=time]{background:var(--bg);border:1px solid var(--line);color:var(--text);
border-radius:8px;padding:7px 10px;font-size:14px;margin-top:8px;display:none}
input[type=time].show{display:block}
.btn{width:100%;border:0;border-radius:10px;padding:12px;font-size:14px;font-weight:600;cursor:pointer;margin-top:10px}
.btn.add{background:var(--accent-soft);color:var(--text);border:1px solid var(--line)}
.btn.send{background:var(--ok);color:#0b1a10}
.btn:disabled{opacity:.45;cursor:default}
.count{font-size:12px;color:var(--dim);margin-top:10px}
.mine{min-height:20px;margin-top:6px}`;

const HEB_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

function renderGrid(today) {
  // 6 weeks, starting the Sunday of the viewer's current week, dates as data
  // attributes — all selection logic is client-side. A week that contains the
  // 1st gets a month caption row above it, so "1" is never an unlabelled
  // mystery mid-grid.
  const [y, m, d] = today.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, d));
  const gridStart = new Date(start.getTime() - start.getUTCDay() * 86_400_000);
  let html = `<div class="mon">${HEB_MONTHS[start.getUTCMonth()]}</div>`
    + HEB_DAY_LETTERS.map((l) => `<div class="dow">${l}</div>`).join('');
  for (let w = 0; w < GRID_WEEKS; w += 1) {
    const week = Array.from({ length: 7 }, (_, i) =>
      new Date(gridStart.getTime() + (w * 7 + i) * 86_400_000));
    const first = week.find((day) => day.getUTCDate() === 1);
    if (w > 0 && first) html += `<div class="mon">${HEB_MONTHS[first.getUTCMonth()]}</div>`;
    for (const day of week) {
      const iso = day.toISOString().slice(0, 10);
      const cls = ['day', iso < today ? 'past' : '', iso === today ? 'today' : ''].filter(Boolean).join(' ');
      html += `<div class="${cls}" data-d="${iso}">${day.getUTCDate()}</div>`;
    }
  }
  return html;
}

const PAGE_JS = `
'use strict';
const P = window.PICK;
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
let selStart = null, selEnd = null, part = null, list = P.mine.map((o) => ({...o}));

const PART_HE = { morning:'בוקר', noon:'צהריים', evening:'ערב', all_day:'כל היום', hour:'שעה' };
const HEB = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];
function dLabel(d){ const [y,m,dd]=d.split('-').map(Number);
  return 'יום '+HEB[new Date(Date.UTC(y,m-1,dd)).getUTCDay()]+' '+dd+'.'+m; }
function sLabel(d){ const [,m,dd]=d.split('-').map(Number); return dd+'.'+m; }
function optLabel(o){
  const when = o.part==='hour' ? 'בשעה '+o.hour : PART_HE[o.part];
  return (o.start_date===o.end_date ? dLabel(o.start_date) : sLabel(o.start_date)+'–'+sLabel(o.end_date))+' — '+when;
}

function paintGrid(){
  $$('.day').forEach((el)=>{
    const d = el.dataset.d;
    el.classList.toggle('sel', d===selStart || d===selEnd);
    el.classList.toggle('inrange', !!(selStart&&selEnd&&d>selStart&&d<selEnd));
  });
}
function paintBusy(day){
  const el = $('.busyline');
  if(!day){ el.innerHTML=''; return; }
  const items = P.busy[day]||[];
  el.innerHTML = '<b>'+dLabel(day)+'</b>'+(items.length? '' : ' — פנוי ביומן');
  for(const it of items){ const div=document.createElement('div'); div.textContent='• '+it; el.appendChild(div); }
}
function paintList(){
  const box = $('.mine'); box.innerHTML='';
  list.forEach((o,i)=>{
    const c=document.createElement('span'); c.className='chip';
    const t=document.createElement('span'); t.textContent=o.label||optLabel(o);
    const x=document.createElement('span'); x.className='x'; x.textContent='✕';
    x.onclick=()=>{ list.splice(i,1); paintList(); };
    c.append(t,x); box.appendChild(c);
  });
  $('.count').textContent = list.length+' / '+P.max+' אופציות';
  $('.send').disabled = list.length===0;
  $('.add').disabled = list.length>=P.max;
}
function addOption(o){
  if(list.length>=P.max) return;
  o.label = optLabel(o);
  if(list.some((x)=>x.label===o.label)) return;
  list.push(o); paintList();
}

$$('.day').forEach((el)=>{ el.onclick=()=>{
  const d=el.dataset.d;
  if(el.classList.contains('past')) return;
  if(!selStart || (selStart&&selEnd)){ selStart=d; selEnd=null; }
  else if(d<selStart){ selStart=d; }
  else if(d!==selStart){ selEnd=d; }
  paintGrid(); paintBusy(selEnd||selStart);
};});
$$('.part').forEach((el)=>{ el.onclick=()=>{
  part=el.dataset.p;
  $$('.part').forEach((x)=>x.classList.toggle('sel',x===el));
  $('#hour').classList.toggle('show', part==='hour');
};});
$('.add').onclick=()=>{
  if(!selStart||!part) return;
  if(part==='hour' && !$('#hour').value) return;
  addOption({ start_date:selStart, end_date:selEnd||selStart, part, hour: part==='hour'?$('#hour').value:null });
  selStart=null; selEnd=null; paintGrid(); paintBusy(null);
};
$$('.adopt').forEach((el)=>{ el.onclick=()=>{
  addOption(JSON.parse(el.dataset.o));
};});
$('#form').onsubmit=()=>{
  $('#options').value = JSON.stringify(list.map((o)=>({start_date:o.start_date,end_date:o.end_date,part:o.part,hour:o.hour})));
  $('.send').disabled = true;
  return true;
};
$$('.day').forEach((el)=>{
  if(P.busy[el.dataset.d] && P.busy[el.dataset.d].length) el.insertAdjacentHTML('beforeend','<span class="dot"></span>');
});
paintList(); paintGrid();
`;

function renderPicker(page, busy) {
  const { title, viewerName, today, mine, others } = page;
  const othersHtml = others.filter((o) => o.options.length).map((o) => `
    <div class="person">${esc(o.name)} כבר סימנ/ה — אפשר ללחוץ כדי לאמץ:</div>
    <div>${o.options.map((opt) => `<span class="chip adopt" data-o="${esc(JSON.stringify({
    start_date: opt.start_date, end_date: opt.end_date, part: opt.part, hour: opt.hour,
  }))}">${esc(opt.label)}</span>`).join('')}</div>`).join('');

  return `<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>מתי נוח לך? — אולמה</title><style>${PAGE_CSS}</style></head><body><div class="card">
<h1>מתי נוח לך${viewerName ? `, ${esc(viewerName)}` : ''}?</h1>
<p class="sub">${esc(title)}</p>
${othersHtml ? `<div class="others"><h2>ההצעות שכבר על השולחן</h2>${othersHtml}</div>` : ''}
<h2>בחירת תאריך או טווח</h2>
<div class="grid">${renderGrid(today)}</div>
<div class="busyline"></div>
<h2>באיזה חלק של היום</h2>
<div class="parts">
  <button type="button" class="part" data-p="morning">בוקר</button>
  <button type="button" class="part" data-p="noon">צהריים</button>
  <button type="button" class="part" data-p="evening">ערב</button>
  <button type="button" class="part" data-p="all_day">כל היום</button>
  <button type="button" class="part" data-p="hour">שעה מסוימת</button>
</div>
<input type="time" id="hour">
<button type="button" class="btn add">הוספת אופציה +</button>
<h2>האופציות שלך</h2>
<div class="mine"></div>
<div class="count"></div>
<form id="form" method="POST"><input type="hidden" name="options" id="options">
<button class="btn send" type="submit">שליחה ✓</button></form>
</div><script>window.PICK=${jsonForScript({
    max: availability.MAX_OPTIONS, today, mine, busy,
  })};${PAGE_JS}</script></body></html>`;
}

// ---- the viewer's own calendar, best-effort ---------------------------------
// The overlay only ever shows the LINK OWNER their own events, fetched under
// their own stored credential — nothing here crosses users. Any failure
// (not connected, needs reauth, Google down) renders the page without it.
async function busyByDate(client, page, calendarDomain) {
  try {
    const cal = calendarDomain || require('../../domain/calendar');
    const res = await cal.listEvents(client, page.userId, GRID_WEEKS * 7);
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
    return res.end(messagePage('הקישור פג', 'קישורי סימון תקפים לשבוע. אפשר לבקש מאולמה קישור חדש בוואטסאפ.'));
  }
  if (error.reason === 'closed') {
    res.writeHead(410, headers());
    return res.end(messagePage('התיאום הסתיים', 'הפגישה הזו כבר לא בשלב איסוף זמינות. אם משהו השתנה — אולמה בוואטסאפ.'));
  }
  res.writeHead(404, headers());
  return res.end(messagePage('הקישור לא נמצא', 'ייתכן שהקישור שגוי או נמחק. אפשר לבקש מאולמה קישור חדש.'));
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
      `${saved}. אולמה תמשיך את התיאום בוואטסאפ — אפשר לסגור את הדף.`));
  }
  res.writeHead(405, headers({ Allow: 'GET, POST' }));
  return res.end(messagePage('שגיאה', 'הפעולה לא נתמכת.'));
}

module.exports = { handle, TOKEN_RE: /^\/pick\/([a-f0-9]{48})$/ };
