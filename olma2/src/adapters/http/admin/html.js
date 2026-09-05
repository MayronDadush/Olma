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

const STYLE = `<style>
  :root{
    --bg:#12151a; --surface:#1a1f27; --surface-2:#212832; --border:#2c3441;
    --text:#e6eaf0; --muted:#8b95a5; --accent:#4ade9f; --accent-dim:#1d3d31;
    --warn:#f0a860; --warn-dim:#3a2c17; --bad:#f2766b; --bad-dim:#3a2220;
  }
  @media (prefers-color-scheme: light){
    :root{
      --bg:#f5f6f8; --surface:#fff; --surface-2:#eef0f4; --border:#dce0e7;
      --text:#1a1f27; --muted:#69717f; --accent:#1f9464; --accent-dim:#dcf2e8;
      --warn:#a86a1a; --warn-dim:#faeed9; --bad:#c0392b; --bad-dim:#fbe6e3;
    }
  }
  *{box-sizing:border-box}
  body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;direction:rtl;margin:0;
       background:var(--bg);color:var(--text);font-size:14px;line-height:1.55;
       -webkit-font-smoothing:antialiased}
  header{position:sticky;top:0;z-index:10;background:color-mix(in srgb,var(--bg) 92%,transparent);
         backdrop-filter:blur(10px);border-bottom:1px solid var(--border);padding:14px 28px}
  .brand{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  .brand h1{font-size:17px;margin:0;font-weight:600;letter-spacing:-.01em}
  .brand .dot{width:8px;height:8px;border-radius:50%;background:var(--accent);
              box-shadow:0 0 0 3px var(--accent-dim)}
  .brand .dot.bad{background:var(--bad);box-shadow:0 0 0 3px var(--bad-dim)}
  nav{display:flex;gap:2px;margin-top:10px;flex-wrap:wrap}
  nav a{color:var(--muted);font-size:12.5px;text-decoration:none;padding:5px 10px;border-radius:6px}
  nav a:hover{color:var(--text);background:var(--surface-2)}
  main{max-width:1080px;margin:0 auto;padding:20px 28px 80px}
  section{background:var(--surface);border:1px solid var(--border);border-radius:10px;
          padding:18px 20px;margin:16px 0}
  section h3{margin:0;font-size:15px;font-weight:600}
  section .hint{color:var(--muted);font-size:12.5px;margin:3px 0 14px}
  h4{margin:14px 0 6px;font-size:12.5px;color:var(--muted);font-weight:600}
  table{border-collapse:collapse;width:100%;font-size:13.5px}
  th,td{text-align:right;padding:8px 10px;border-bottom:1px solid var(--border);vertical-align:middle}
  tr:last-child td{border-bottom:0}
  th{color:var(--muted);font-weight:500;font-size:11.5px;text-transform:none;white-space:nowrap}
  tbody tr:hover,table tr:hover{background:var(--surface-2)}
  a{color:var(--accent);text-decoration:none} a:hover{text-decoration:underline}
  .dim{color:var(--muted)} .small{font-size:12px} .mono{font-family:ui-monospace,SFMono-Regular,monospace}
  p.warn{color:var(--warn)}
  td.warn{color:var(--warn);font-weight:600}
  .nowrap{white-space:nowrap}
  tr.bad td{background:var(--bad-dim)}
  .banner{padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:14px}
  .banner.ok{background:var(--accent-dim);color:var(--accent)}
  .banner.bad{background:var(--bad-dim);color:var(--bad)}
  .pill{display:inline-block;padding:2px 9px;border-radius:20px;font-size:11.5px;
        background:var(--surface-2);color:var(--muted)}
  .pill.ok{background:var(--accent-dim);color:var(--accent)}
  .pill.warn{background:var(--warn-dim);color:var(--warn)}
  .stats{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px}
  .stat{flex:1;min-width:120px;background:var(--surface-2);border-radius:8px;padding:12px 14px}
  .stat .num{font-size:22px;font-weight:600;letter-spacing:-.02em}
  .stat .lbl{color:var(--muted);font-size:12px;margin-top:2px}
  .cols{display:flex;gap:24px;flex-wrap:wrap} .cols>div{flex:1;min-width:240px}
  table.settings td:first-child{max-width:520px}
  form.inline{display:inline-flex;gap:6px;align-items:center}
  input,select{font-size:13px;padding:5px 8px;background:var(--bg);color:var(--text);
               border:1px solid var(--border);border-radius:6px;font-family:inherit}
  input:focus,select:focus{outline:2px solid var(--accent);outline-offset:-1px}
  button{cursor:pointer;font-size:12.5px;padding:5px 12px;background:var(--accent);
         color:var(--bg);border:0;border-radius:6px;font-weight:600;font-family:inherit}
  button:hover{filter:brightness(1.1)}
  button.danger{background:var(--bad);color:#fff}
  section.danger{border-color:var(--bad)}
  section.danger ul{margin:6px 0 14px;padding-inline-start:20px;font-size:13px}
  .btn-danger,.btn-quiet{display:inline-block;font-size:12.5px;padding:6px 12px;
    border-radius:6px;text-decoration:none;font-weight:600}
  .btn-danger{color:var(--bad);border:1px solid var(--bad)}
  .btn-danger:hover{background:var(--bad-dim)}
  .btn-quiet{color:var(--muted);margin-inline-start:8px}
  .btn-quiet:hover{color:var(--text)}
  .chat{display:flex;flex-direction:column;gap:8px}
  .msg{max-width:78%;padding:8px 11px;border-radius:10px;font-size:13.5px;line-height:1.5}
  .msg .who{font-size:11px;color:var(--muted);margin-bottom:3px;display:flex;gap:6px;align-items:center}
  .msg.them{align-self:flex-start;background:var(--surface-2)}
  .msg.olma{align-self:flex-end;background:var(--accent-dim)}
  .msg .txt{white-space:pre-wrap;overflow-wrap:anywhere}
  .help{display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;
        border-radius:50%;background:var(--surface-2);color:var(--muted);font-size:10px;cursor:help}
  details.group{margin:18px 0}
  details.group>summary{list-style:none;cursor:pointer;user-select:none;display:flex;align-items:center;gap:10px;
    padding:10px 14px;border-radius:8px;font-size:15px;font-weight:600;color:var(--text)}
  details.group>summary::-webkit-details-marker{display:none}
  details.group>summary::before{content:'◂';color:var(--muted);font-size:12px}
  details.group[open]>summary::before{content:'▾'}
  details.group>summary:hover{background:var(--surface-2)}
  details.group>section{margin:10px 0 0}
  details.sub{margin-top:8px} details.sub>summary{cursor:pointer;padding:6px 0}
  .alerts{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0 4px}
  .alert{display:inline-block;padding:4px 11px;border-radius:20px;font-size:12.5px;text-decoration:none}
  .alert-ok{background:var(--accent-dim);color:var(--accent)}
  .alert-warn{background:var(--warn-dim);color:var(--warn)}
  .alert-bad{background:var(--bad-dim);color:var(--bad);font-weight:600}
  a.alert:hover{text-decoration:none;filter:brightness(1.15)}
  @media(max-width:640px){main,header{padding-inline:16px} .cols{gap:12px}
    details.group>summary{padding:8px 10px;font-size:14px}}
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
