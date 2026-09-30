'use strict';
// `/i/<code>` — a friend's short invite link (owner, 2026-09-30), served
// ahead of Basic Auth like every other route a stranger may reach.
//
// A person-looking GET is counted (`referral.clicked`, on the INVITER's id,
// which no weekly-active count reads) and redirected straight to the wa.me
// chat link with the friend's first words typed. A link-preview fetch gets a
// tiny page with our card and is NOT counted: on WhatsApp the SENDING phone
// fetches the link to draw the card (link-card.js), so without this every
// share would count as a tap by the person who shared it.
//
// Matched on the exact shape (referral.SHORT_PATH_RE) and Caddy must match the
// same shape, never `/i/*` — a malformed code that fell through would meet the
// admin password prompt on the public domain (dashboard-and-domains rules,
// "Match /pick/ on the exact token shape").
const referral = require('../../domain/referral');
const audit = require('../../domain/audit');
const { withTx } = require('../../db/pool');
const { linkCard } = require('./link-card');
const { esc } = require('./html');

// Chat apps, social crawlers and command-line fetchers. A browser a person
// tapped into says none of these.
const PREVIEW_RE = /whatsapp|facebookexternalhit|facebot|telegrambot|twitterbot|slackbot|discordbot|linkedinbot|skypeuripreview|embedly|bot\b|crawler|spider|preview|curl|wget/i;
const isPreviewFetch = (ua) => !ua || PREVIEW_RE.test(String(ua));

function cardPage(code, lang, url) {
  const dir = lang === 'en' ? 'ltr' : 'rtl';
  return `<!doctype html><html lang="${lang}" dir="${dir}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${linkCard({ lang, path: `/i/${code}` })}
<title>${lang === 'en' ? 'Allma' : 'עולמה'}</title>
<meta http-equiv="refresh" content="0;url=${esc(url)}"></head>
<body><a href="${esc(url)}">${lang === 'en' ? 'Open the chat with Allma' : 'לפתיחת הצ׳אט עם עולמה'}</a></body></html>`;
}

// True when it answered the request; false leaves it to the next route.
async function handle(req, res, pool, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const m = referral.SHORT_PATH_RE.exec(pathname);
  if (!m) return false;
  const code = m[1];
  const preview = req.method === 'HEAD' || isPreviewFetch(req.headers['user-agent']);
  const landing = await withTx(pool, async (client) => {
    const l = await referral.landingFor(client, code);
    if (l.referrerId && !preview) await audit.record(client, l.referrerId, 'referral.clicked', { code });
    return l;
  });
  const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
  if (preview) {
    res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' });
    res.end(req.method === 'HEAD' ? undefined : cardPage(code, landing.lang, landing.url));
    return true;
  }
  res.writeHead(302, { ...headers, Location: landing.url });
  res.end();
  return true;
}

module.exports = { handle, isPreviewFetch };
