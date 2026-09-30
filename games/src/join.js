'use strict';
// The two things brokerd asks for on a person's behalf with no model in
// between (olma2 domain/game-shortcut.js): open a night for somebody who wrote
// "ערב משחק חדש" and then gave the price, and seat somebody who sent a night's
// join code ("משחק K7M2Q"). Box-only, like POST /api/nights (server.js), and
// brokerd has already said who the person is — the user id here is its word,
// not a claim from the internet.
//
// Every write goes through store.write, the page's own door, so a join is a
// player row and a log line like any other, and the page redraws.
const crypto = require('crypto');
const store = require('./store');
const { Refused } = require('./validate');
const { TOOLS } = require('./tools');

const CODE_RE = /^[2-9A-HJKMNP-Z]{5}$/;
const RECENT = "interval '3 days'";
const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
const newId = () => 'o' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');

// A person's own way in: the night's link with their seat on it. The page
// reads `#me-<player>` once, remembers the seat on that phone and drops the
// hash (public/night.html), so they never pick a chair. Anybody holding the
// night's link can already sit anywhere; this only saves the tap.
const personalUrl = (publicBase, n, pid) => `${publicBase}/night/${n.token}#me-${pid}`;
const describe = n => ({ name: n.name, price: n.price_ag / 100, chips: n.chips_per_buyin, code: n.code });

const userIdOf = v => { const id = Number(v); return Number.isSafeInteger(id) && id > 0 ? id : null; };

async function buyinsOf(pool, nightId, pid) {
  const { rows: [r] } = await pool.query(
    'SELECT coalesce(sum(n), 0)::float AS n FROM buyins WHERE night_id = $1 AND player_id = $2', [nightId, pid]);
  return Number(r.n);
}

// Their open night from the last three days, the one the tools would pick.
async function openNightOf(pool, userId) {
  const { rows: [n] } = await pool.query(
    `SELECT n.*, p.id AS my_pid FROM nights n
       JOIN players p ON p.night_id = n.id AND p.user_id = $1
      WHERE n.closed_at IS NULL AND n.created_at > now() - ${RECENT}
      ORDER BY n.created_at DESC, p.ord LIMIT 1`, [userId]);
  return n || null;
}

// → { ok, opened|already, night, url } or { ok: false, error }.
// A night of theirs already open is handed back rather than a second one
// opened: two open nights is the one state every tool has to ask about.
async function openFor(pool, body = {}, { publicBase = '' } = {}) {
  const userId = userIdOf(body.userId);
  if (!userId) return { ok: false, error: 'bad_user' };
  const open = await openNightOf(pool, userId);
  if (open) return { ok: true, already: true, night: describe(open), url: personalUrl(publicBase, open, open.my_pid) };
  // Asked before she asks the price: is there one already? Nothing is opened.
  if (body.probe === true) return { ok: true, none: true };
  const user = { id: userId, name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : null, locale: body.locale === 'en' ? 'en' : 'he' };
  try {
    await TOOLS.start_game_night({ pool, user, publicBase }, { price: body.price, chips: body.chips, name: body.nightName || undefined });
  } catch (e) {
    // Refused: a price or chips the page would refuse too. A ToolError
    // 'already_open' is a second "ערב משחק חדש" racing the first.
    if (e instanceof Refused || e.code === 'already_open') return { ok: false, error: e.code };
    throw e;
  }
  const n = await openNightOf(pool, userId);
  return { ok: true, opened: true, night: describe(n), url: personalUrl(publicBase, n, n.my_pid) };
}

// → { ok, joined|already, night, name, buyins, url } or { ok: false, error }:
//   no_night    no OPEN night has that code (closed, or never was)
//   name_taken  every name offered belongs to somebody else already linked
//   full        the night is at its player cap
//   need_name   no name was offered (nothing on file); the night is named so
//               the question can say which one
//
// `names` is tried in order — their first name, then with their surname's
// initial — and a name already at the table that nobody has claimed is TAKEN
// OVER rather than duplicated: the host typing "דני" in advance and Dani
// sending the code are one person arriving, not two.
async function joinByCode(pool, body = {}, { publicBase = '', onState } = {}) {
  const userId = userIdOf(body.userId);
  if (!userId) return { ok: false, error: 'bad_user' };
  const code = String(body.code || '').trim().toUpperCase();
  if (!CODE_RE.test(code)) return { ok: false, error: 'no_night' };
  const { rows: [n] } = await pool.query('SELECT * FROM nights WHERE code = $1 AND closed_at IS NULL', [code]);
  if (!n) return { ok: false, error: 'no_night' };

  const { rows: mine } = await pool.query(
    'SELECT id, name FROM players WHERE night_id = $1 AND user_id = $2 ORDER BY ord LIMIT 1', [n.id, userId]);
  if (mine.length) {
    return { ok: true, already: true, night: describe(n), name: mine[0].name,
      buyins: await buyinsOf(pool, n.id, mine[0].id), url: personalUrl(publicBase, n, mine[0].id) };
  }

  const names = (Array.isArray(body.names) ? body.names : []).filter(s => typeof s === 'string' && s.trim()).map(s => s.trim());
  // No name to try: they are asked for one, so say which night it is.
  if (!names.length) return { ok: false, error: 'need_name', night: describe(n) };
  const { rows: players } = await pool.query('SELECT id, name, user_id FROM players WHERE night_id = $1', [n.id]);
  for (const want of names) {
    const hit = players.find(p => norm(p.name) === norm(want));
    if (hit && hit.user_id) continue;
    let pid = hit && hit.id;
    try {
      if (!pid) {
        pid = newId();
        await store.write(pool, n.token, { op: 'set', col: 'players', id: pid, data: { name: want, order: Date.now() } });
      }
      // user_id IS NULL, so two people racing for one unclaimed name cannot
      // both have it: the loser tries their next name.
      const { rowCount } = await pool.query(
        `UPDATE players SET user_id = $3, linked_at = now(), linked_via = 'invite'
          WHERE night_id = $1 AND id = $2 AND user_id IS NULL`, [n.id, pid, userId]);
      if (!rowCount) continue;
      const { state } = await store.write(pool, n.token, { op: 'add', col: 'log', data: { t: `${want} בשולחן`, via: 'olma' } });
      if (onState) onState(n.token, state);
    } catch (e) {
      if (e instanceof Refused) return { ok: false, error: e.code === 'too_many' ? 'full' : 'bad_name', night: describe(n) };
      throw e;
    }
    const row = (await pool.query('SELECT name FROM players WHERE night_id = $1 AND id = $2', [n.id, pid])).rows[0];
    return { ok: true, joined: true, night: describe(n), name: row.name, buyins: await buyinsOf(pool, n.id, pid), url: personalUrl(publicBase, n, pid) };
  }
  return { ok: false, error: 'name_taken', name: names[0], night: describe(n) };
}

module.exports = { openFor, joinByCode, personalUrl, CODE_RE };
