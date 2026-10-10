'use strict';
// The apps on the home screen of somebody's own page (/me): one icon per pack
// they hold (`user_packs`), in place of the invitation to a friend (owner,
// 2026-10-08). Somebody with food only sees food; somebody with both sees both;
// somebody with none sees the invitation, as before.
//
// Each app is its own service with its own database (food/, games/), and
// olma2 never reads either. So the page is given only WHICH apps, from our
// own table, inside the /me/data transaction; everything that has to ask a
// service happens after that transaction, or on the tap itself:
//   - badges(): the games icon's count of open nights, best-effort and short,
//     so a slow gamesd costs the badge and never the page;
//   - openUrl(): the link the tap goes to, asked for at the moment of the tap,
//     because a night's link changes from one night to the next and the food
//     page is made on the first ask.
//
// The pack row is the permission, the same row gamesd and foodd ask brokerd
// about (identity_resolve). The session says who; the row says whether.
const { err } = require('./results');
const { WA_NUMBER } = require('./referral');
const { OPEN_PHRASES } = require('./game-shortcut');

// The order on the home screen. A pack the page has no icon for is not shown.
const APPS = ['food', 'games'];

async function appsOf(client, userId) {
  const { rows } = await client.query('SELECT pack FROM user_packs WHERE user_id = $1', [userId]);
  const held = new Set(rows.map((r) => r.pack));
  return APPS.filter((a) => held.has(a));
}

const BADGE_TIMEOUT_MS = 600;

// → [{ id, badge }] for the ids given. A badge is a number of things waiting,
// or 0; a service that did not answer is 0, never a guess.
async function badges(apps, userId, { gamesd = require('../channels/gamesd') } = {}) {
  return Promise.all(apps.map(async (id) => {
    if (id !== 'games') return { id, badge: 0 };
    try {
      const r = await gamesd.mine({ userId }, { timeoutMs: BADGE_TIMEOUT_MS });
      const open = r && r.ok && Array.isArray(r.nights) ? r.nights.filter((n) => n.status === 'open').length : 0;
      return { id, badge: open };
    } catch {
      return { id, badge: 0 };
    }
  }));
}

// A chat with Olma holding the words that open a night, which brokerd answers
// by code (domain/game-shortcut.js). For somebody with no night to go back to.
const newNightLink = (locale) =>
  `https://wa.me/${WA_NUMBER}?text=${encodeURIComponent(OPEN_PHRASES[locale === 'en' ? 'en' : 'he'][0])}`;

// → { ok, data: { url } } — where the tap on an app goes. `user` is the
// session's row (id, first_name, timezone, locale).
async function openUrl(client, user, app, {
  foodd = require('../channels/foodd'), gamesd = require('../channels/gamesd'),
} = {}) {
  if (!APPS.includes(app)) return err('invalid', 'unknown app');
  if (!(await appsOf(client, user.id)).includes(app)) return err('forbidden', 'this app is not open for them', { reason: 'not_enabled' });
  try {
    if (app === 'food') {
      const r = await foodd.page({
        user: { id: Number(user.id), name: user.first_name || null, timezone: user.timezone || null, locale: user.locale || 'he' },
      });
      if (!r || !r.ok || typeof r.url !== 'string') return err('unavailable', 'food did not answer with a page');
      return { ok: true, data: { url: r.url } };
    }
    // games: the open night first, then the newest one still in its three
    // days (a settled night is worth seeing), then a way to start one.
    const r = await gamesd.mine({ userId: Number(user.id), links: true }, { timeoutMs: 2000 });
    const nights = r && r.ok && Array.isArray(r.nights) ? r.nights : null;
    if (!nights) return err('unavailable', 'games did not answer');
    // A night with no link is a gamesd from before `links` (a deploy apart),
    // never "no night": sending them to start one would be the wrong door.
    if (nights.some((n) => typeof n.url !== 'string')) return err('unavailable', 'games answered without links');
    const pick = nights.find((n) => n.status === 'open') || nights[0];
    return { ok: true, data: { url: pick ? pick.url : newNightLink(user.locale) } };
  } catch (e) {
    return err('unavailable', `${app} did not answer (${e.message})`);
  }
}

module.exports = { APPS, appsOf, badges, openUrl, newNightLink };
