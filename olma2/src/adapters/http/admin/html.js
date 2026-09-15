'use strict';
// The page shell and the small formatting helpers every admin section shares.
// Moved verbatim out of adapters/http/dashboard.js on 2026-09-05; the router
// there is what is left of that file.
const { esc } = require('../html');

const fmt = (n) => Number(n).toLocaleString('en-US');

// Relative time in Hebrew — "לפני 3 דק׳" beats a raw timestamp for scanning.
function ago(ts) {
  if (!ts) return '—';
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return 'הרגע';
  if (s < 3600) return `לפני ${Math.round(s / 60)} דק׳`;
  if (s < 86400) return `לפני ${Math.round(s / 3600)} שע׳`;
  return `לפני ${Math.round(s / 86400)} ימים`;
}

// ---- sections (named, not positional — the v1 pitfall) ----------------------
// Each carries a one-line explanation shown under its title: this is a tool
// looked at daily, not a diagnostics dump. Nothing unlabelled, nothing cryptic.

const STYLE = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Assistant:wght@400;500;600;700&family=Rubik:wght@500;600;700&display=swap" rel="stylesheet">
<style>
  /* The personal dashboard's palette (docs/design/user-dashboard.html), under
     the variable names every admin section already uses inline. */
  :root{
    --bg:#F4F3F8; --surface:#FFFFFF; --surface-2:#FAF9FE; --border:#E7E5F0; --border-2:#D9D6E6;
    --text:#141322; --muted:#6C6982; --faint:#A29FB5;
    --accent:#5B2FD6; --accent-dim:#EEE8FC; --on-accent:#FFFFFF;
    --ok:#1B9B6B; --ok-dim:#E4F4EE;
    --warn:#B57509; --warn-dim:#F8EFDC; --bad:#DC3A31; --bad-dim:#FCEBE9;
    --gold:#B07A0B; --gold-dim:#FBF1DA;
    --shadow-s:0 1px 2px rgba(20,19,34,.05);
    --shadow-m:0 1px 2px rgba(20,19,34,.05), 0 10px 28px -16px rgba(20,19,34,.28);
    --radius:16px;
  }
  @media (prefers-color-scheme: dark){
    :root{
      --bg:#0C0B11; --surface:#181720; --surface-2:#1F1D29; --border:#2A2836; --border-2:#3A3749;
      --text:#F4F3FA; --muted:#9D9AB2; --faint:#6E6B83;
      --accent:#A38CFF; --accent-dim:#291D4C; --on-accent:#0C0B11;
      --ok:#41CB94; --ok-dim:#12352A;
      --warn:#F0AE3E; --warn-dim:#332616; --bad:#FF6B60; --bad-dim:#33191A;
      --gold:#E3B45C; --gold-dim:#2C2412;
      --shadow-s:0 1px 2px rgba(0,0,0,.4);
      --shadow-m:0 1px 2px rgba(0,0,0,.4), 0 10px 28px -16px rgba(0,0,0,.7);
    }
  }
  *{box-sizing:border-box}
  body{font-family:'Assistant','Heebo',system-ui,-apple-system,"Segoe UI",sans-serif;direction:rtl;margin:0;
       background:var(--bg);color:var(--text);font-size:15px;line-height:1.55;
       -webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
  h1,h2,h3,.kpi-value,.mini-stats b,.stat .num{font-family:'Rubik','Assistant',system-ui,sans-serif}
  header{position:sticky;top:0;z-index:10;background:color-mix(in srgb,var(--bg) 88%,transparent);
         backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border-bottom:1px solid var(--border);padding:12px 28px 0}
  .brand{display:flex;align-items:center;gap:12px;flex-wrap:wrap;max-width:1180px;margin:0 auto}
  .brand h1{font-size:18px;margin:0;font-weight:700;letter-spacing:-.01em}
  .brand .dot{width:9px;height:9px;border-radius:50%;background:var(--ok);
              box-shadow:0 0 0 4px var(--ok-dim)}
  .brand .dot.bad{background:var(--bad);box-shadow:0 0 0 4px var(--bad-dim)}
  nav{display:flex;gap:4px;margin:10px auto 0;flex-wrap:nowrap;overflow-x:auto;max-width:1180px;scrollbar-width:none}
  nav::-webkit-scrollbar{display:none}
  nav a{color:var(--muted);font-size:14px;font-weight:600;text-decoration:none;padding:8px 14px 10px;
        border-bottom:2.5px solid transparent;white-space:nowrap}
  nav a:hover{color:var(--text);text-decoration:none}
  nav a.active{color:var(--accent);border-bottom-color:var(--accent)}
  main{max-width:1180px;margin:0 auto;padding:22px 28px 80px}
  .page-title{font-size:26px;font-weight:700;margin:6px 2px 4px;letter-spacing:-.015em}
  section{background:var(--surface);border:0;border-radius:var(--radius);box-shadow:var(--shadow-m);
          padding:20px 22px;margin:16px 0}
  section h3{margin:0;font-size:17px;font-weight:600}
  section .hint{color:var(--muted);font-size:13px;margin:3px 0 14px}
  h4{margin:16px 0 8px;font-size:13px;color:var(--muted);font-weight:600}
  table{border-collapse:collapse;width:100%;font-size:14px}
  th,td{text-align:right;padding:9px 10px;border-bottom:1px solid var(--border);vertical-align:middle}
  tr:last-child td{border-bottom:0}
  th{color:var(--faint);font-weight:600;font-size:12px;text-transform:none;white-space:nowrap}
  tbody tr:hover,table tr:hover{background:var(--surface-2)}
  a{color:var(--accent);text-decoration:none} a:hover{text-decoration:underline}
  .dim{color:var(--muted)} .small{font-size:12.5px} .mono{font-family:ui-monospace,SFMono-Regular,monospace}
  p.warn{color:var(--warn)}
  td.warn{color:var(--warn);font-weight:600}
  .nowrap{white-space:nowrap}
  /* A message shown as the text that will actually be sent keeps its own line
     breaks — a reminder batch is a list, and collapsed to one line it stops
     being the thing the reader is checking. */
  .verbatim{white-space:pre-wrap}
  tr.bad td{background:var(--bad-dim)}
  .banner{padding:10px 14px;border-radius:11px;font-size:13.5px;margin-bottom:14px}
  .banner.ok{background:var(--ok-dim);color:var(--ok)}
  .banner.bad{background:var(--bad-dim);color:var(--bad)}
  .pill{display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;
        background:var(--surface-2);color:var(--muted);border:1px solid var(--border)}
  .pill.ok{background:var(--ok-dim);color:var(--ok);border-color:transparent}
  .pill.warn{background:var(--warn-dim);color:var(--warn);border-color:transparent}
  .stats{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px}
  .stat{flex:1;min-width:120px;background:var(--surface-2);border:1px solid var(--border);border-radius:13px;padding:12px 14px}
  .stat .num{font-size:22px;font-weight:600;letter-spacing:-.02em}
  .stat .lbl{color:var(--muted);font-size:12.5px;margin-top:2px}
  .cols{display:flex;gap:24px;flex-wrap:wrap} .cols>div{flex:1;min-width:240px}
  table.settings td:first-child{max-width:520px}
  table.templates td:first-child{width:50%}
  table.templates.bilingual td:first-child{width:18%}
  table.templates.bilingual td{vertical-align:top}
  table.templates.bilingual td:nth-child(3){direction:ltr;text-align:left}
  pre.tpl{white-space:pre-wrap;font:inherit;font-size:13px;margin:6px 0 0;padding:6px 8px;background:var(--surface-2);border-radius:8px;color:var(--muted)}
  textarea.tpl{width:100%;box-sizing:border-box;font:inherit;font-size:13.5px;padding:7px 9px;background:var(--surface);color:var(--text);border:1px solid var(--border-2);border-radius:9px;resize:vertical}
  textarea.tpl:focus{outline:2px solid var(--accent);outline-offset:-1px}
  .warn.small{color:var(--warn)}
  form.inline{display:inline-flex;gap:6px;align-items:center}
  .emoji-big{font-size:1.4em;line-height:1}
  input,select{font-size:14px;padding:6px 9px;background:var(--surface);color:var(--text);
               border:1px solid var(--border-2);border-radius:9px;font-family:inherit}
  input:focus,select:focus{outline:2px solid var(--accent);outline-offset:-1px}
  button{cursor:pointer;font-size:13.5px;padding:6px 14px;background:var(--accent);
         color:var(--on-accent);border:0;border-radius:999px;font-weight:600;font-family:inherit}
  button:hover{filter:brightness(1.08)}
  button.danger{background:var(--bad);color:#fff}
  section.danger{box-shadow:var(--shadow-m),inset 0 0 0 1.5px var(--bad)}
  section.danger ul{margin:6px 0 14px;padding-inline-start:20px;font-size:13.5px}
  .btn-danger,.btn-quiet{display:inline-block;font-size:13.5px;padding:6px 14px;
    border-radius:999px;text-decoration:none;font-weight:600}
  .btn-danger{color:var(--bad);border:1px solid var(--bad)}
  .btn-danger:hover{background:var(--bad-dim);text-decoration:none}
  .btn-quiet{color:var(--muted);margin-inline-start:8px}
  .btn-quiet:hover{color:var(--text)}
  .chat{display:flex;flex-direction:column;gap:8px}
  .msg{max-width:78%;padding:8px 12px;border-radius:14px;font-size:14px;line-height:1.5}
  .msg .who{font-size:11.5px;color:var(--muted);margin-bottom:3px;display:flex;gap:6px;align-items:center}
  .msg.them{align-self:flex-start;background:var(--surface-2);border:1px solid var(--border)}
  .msg.olma{align-self:flex-end;background:var(--accent-dim)}
  .msg .txt{white-space:pre-wrap;overflow-wrap:anywhere}
  .help{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;
        border-radius:50%;background:var(--surface-2);color:var(--muted);font-size:10px;cursor:help}
  details.sub{margin-top:8px} details.sub>summary{cursor:pointer;padding:6px 0}
  .alerts{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0 4px}
  .alert{display:inline-block;padding:5px 12px;border-radius:999px;font-size:13px;font-weight:600;text-decoration:none}
  .alert-ok{background:var(--ok-dim);color:var(--ok)}
  .alert-warn{background:var(--warn-dim);color:var(--warn)}
  .alert-bad{background:var(--bad-dim);color:var(--bad)}
  a.alert:hover{text-decoration:none;filter:brightness(1.05)}

  /* ---- home page ---- */
  .home-head{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;margin:4px 2px 18px}
  .home-head h2{font-size:32px;font-weight:700;margin:0;letter-spacing:-.015em;line-height:1.1}
  .home-head p{margin:6px 0 0;font-size:14px}
  .home-head .alerts{margin:0}
  .kpi-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px}
  .kpi{background:var(--surface);border-radius:var(--radius);box-shadow:var(--shadow-m);padding:16px 18px 14px;
       display:flex;flex-direction:column;min-width:0}
  .kpi.focus{box-shadow:var(--shadow-m),inset 0 3px 0 var(--accent)}
  .kpi-label{font-size:13.5px;font-weight:600;color:var(--muted)}
  .kpi-value{font-size:34px;font-weight:700;letter-spacing:-.02em;line-height:1.15;margin-top:4px;overflow-wrap:anywhere}
  .kpi-sub{font-size:12.5px;color:var(--faint);margin-top:1px}
  .kpi-periods{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:14px;padding-top:12px;border-top:1px solid var(--border)}
  .kpi-period{display:flex;flex-direction:column;align-items:flex-start;min-width:0}
  .kpi-p-num{font-family:'Rubik','Assistant',system-ui,sans-serif;font-size:17px;font-weight:600;overflow-wrap:anywhere}
  .kpi-p-lbl{font-size:11.5px;color:var(--faint)}
  .kpi-note{font-size:11.5px;color:var(--muted);margin-top:10px;line-height:1.45}
  .kpi-warn{color:var(--warn);font-weight:600;margin-top:3px}
  .focus-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:14px;margin-top:22px}
  .focus-grid section.panel{margin:0}
  .panel-head h3{font-size:20px;font-weight:700}
  .mini-stats{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin:4px 0 6px}
  .mini-stats>div{background:var(--surface-2);border:1px solid var(--border);border-radius:13px;padding:10px 12px;display:flex;flex-direction:column}
  .mini-stats b{font-size:21px;font-weight:600}
  .mini-stats span{font-size:12px;color:var(--muted)}
  .funnel{display:flex;flex-direction:column;gap:7px}
  .funnel-row{display:grid;grid-template-columns:minmax(110px,38%) 1fr 44px;align-items:center;gap:10px;font-size:13.5px}
  .funnel-track{height:10px;background:var(--surface-2);border:1px solid var(--border);border-radius:999px;overflow:hidden}
  .funnel-fill{height:100%;border-radius:999px;min-width:0}
  .funnel-num{text-align:left;font-weight:600}
  .funnel-fill.accent,.bar.accent,.legend i.accent{background:var(--accent)}
  .funnel-fill.ok,.bar.ok,.legend i.ok{background:var(--ok)}
  .funnel-fill.warn,.bar.warn,.legend i.warn{background:var(--warn)}
  .funnel-fill.muted,.bar.muted,.legend i.muted{background:var(--faint)}
  .bar.gold,.legend i.gold{background:var(--gold)}
  .bars{display:grid;grid-template-columns:repeat(8,1fr);gap:8px;align-items:end;height:150px;padding-top:8px}
  .bar-col{display:flex;flex-direction:column;align-items:stretch;height:100%;min-width:0}
  .bar-stack{flex:1;display:flex;align-items:flex-end;justify-content:center;gap:2px}
  .bar{flex:1;max-width:16px;border-radius:5px 5px 2px 2px;position:relative;min-height:2px}
  .bar span{position:absolute;top:-17px;left:50%;transform:translateX(-50%);font-size:10.5px;color:var(--muted);white-space:nowrap}
  .bar-lbl{text-align:center;font-size:11px;color:var(--faint);margin-top:5px}
  .legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--muted);margin-top:8px}
  .legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-inline-end:5px;vertical-align:-1px}
  table.compact th,table.compact td{padding:6px 8px;font-size:13.5px}
  .home-foot{margin-top:18px}
  @media(max-width:640px){main,header{padding-inline:14px} .cols{gap:12px}
    .focus-grid{grid-template-columns:1fr} .kpi-grid{grid-template-columns:1fr 1fr;gap:10px}
    .kpi{padding:13px 13px 11px} .kpi-value{font-size:26px} .kpi-p-num{font-size:14.5px}
    .home-head h2{font-size:26px} section{padding:16px}
    .bars{gap:4px} .bar span{display:none}}
  @media(max-width:380px){.kpi-grid{grid-template-columns:1fr}}
</style>`;

// The page Google sends the user's browser back to. Deliberately plain: they
// are standing in a browser they only opened to approve something, and the
// real conversation continues in WhatsApp.
function oauthResultPage(title, body) {
  return `<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>עולמה</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;background:#12151a;color:#e6eaf0;
display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:24px}
.card{background:#1a1f27;padding:28px 32px;border-radius:12px;max-width:420px}
h1{font-size:18px;margin:0 0 8px;font-weight:600}p{color:#8b95a5;font-size:14px;margin:0;line-height:1.6}</style>
</head><body><div class="card"><h1>${esc(title)}</h1><p>${esc(body)}</p></div></body></html>`;
}

module.exports = { fmt, ago, STYLE, oauthResultPage };
