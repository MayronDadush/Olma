'use strict';
const crypto = require('crypto');
const { withTx } = require('./db');
const v = require('./validate');
const { pokerOf } = require('./money');

const { refuse } = v;

// Caps per night. A real night has 4-12 players, a few dozen buy-ins and a
// couple of orders; these only stop a link in the wrong hands from filling
// the database.
const LIMITS = { players: 30, buyins: 400, food: 60, log: 300, successors: 5 };

const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const CODE_ABC = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';   // no 0 O 1 I L
const pick = (abc, n) => { const b = crypto.randomBytes(n * 2); let s = ''; for (let i = 0; i < n; i++) s += abc[b.readUInt16BE(i * 2) % abc.length]; return s; };
const makeToken = () => pick(B62, 22);
const makeCode = () => pick(CODE_ABC, 5);
const newId = () => Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
const TOKEN = /^[A-Za-z0-9]{22}$/;
// What the page sees of the phone holding a seat: enough to tell "this is my
// phone" from "another phone", never the tag itself. The tag is what the
// server checks a host's writes against (migration 004), so publishing it
// would hand the lock to anybody who reads the night's state.
const seatTag = d => crypto.createHash('sha256').update(d).digest('hex').slice(0, 16);
const HOST_KEY_MS = 10 * 60_000;

async function freeCode(c, exceptId) {
  for (let i = 0; i < 20; i++) {
    const code = makeCode();
    const { rowCount } = await c.query('SELECT 1 FROM nights WHERE code = $1 AND closed_at IS NULL AND id <> $2', [code, exceptId || 0]);
    if (!rowCount) return code;
  }
  throw new Error('no free join code after 20 tries');
}

async function insertNight(c, { name, price, chips, players = [], prevId = null, foodMode = 'merge' }) {
  const patch = v.gamePatch({ name, price, chips });
  const code = await freeCode(c);
  const { rows: [n] } = await c.query(
    `INSERT INTO nights (token, code, name, price_ag, chips_per_buyin, food_mode, prev_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, token, code`,
    [makeToken(), code, patch.name, patch.price_ag, patch.chips_per_buyin, foodMode, prevId]);
  const names = [...new Set(players.map(p => (typeof p === 'string' ? p : p.name)).map(s => String(s || '').trim().slice(0, 24)).filter(Boolean))];
  if (names.length > LIMITS.players) refuse('too_many');
  const t = Date.now();
  for (const [i, nm] of names.entries()) {
    await c.query('INSERT INTO players (night_id, id, name, ord) VALUES ($1, $2, $3, $4)', [n.id, newId(), v.player({ name: nm }).name, t + i]);
  }
  return n;
}

// Opening a night is not something the public page can do from nothing: in
// stage 1 it is the CLI (bin/new-night.js) or the next-night button on a
// night you already hold. Olma's tool (stage 2) calls this same function.
function createNight(pool, opts) {
  return withTx(pool, c => insertNight(c, opts));
}

async function lockNight(c, token) {
  if (!TOKEN.test(String(token || ''))) refuse('not_found');
  const { rows: [n] } = await c.query('SELECT * FROM nights WHERE token = $1 FOR UPDATE', [token]);
  return n || refuse('not_found');
}

async function findNight(db, token) {
  if (!TOKEN.test(String(token || ''))) return null;
  const { rows: [n] } = await db.query('SELECT * FROM nights WHERE token = $1', [token]);
  return n || null;
}

// The page's own shape, so its render code is unchanged from the prototype.
async function stateOf(db, n) {
  // One after another: inside a write this is a single transaction's client,
  // and pg will not run two queries on one client at once.
  const q = sql => db.query(sql, [n.id]).then(r => r.rows);
  const players = await q('SELECT id, name, ord, user_id, device FROM players WHERE night_id = $1');
  const buyins = await q('SELECT id, player_id, n, via, at FROM buyins WHERE night_id = $1');
  const cashouts = await q('SELECT player_id, chips, via, at FROM cashouts WHERE night_id = $1');
  const food = await q('SELECT id, data, at FROM food WHERE night_id = $1');
  const log = await q('SELECT id, t, via, at, by_name FROM log WHERE night_id = $1 ORDER BY at DESC LIMIT 60');
  const by = (rows, key, fn) => Object.fromEntries(rows.map(r => [r[key], fn(r)]));
  return {
    game: {
      name: n.name, price: n.price_ag / 100, chips: n.chips_per_buyin, foodMode: n.food_mode,
      code: n.code, createdAt: new Date(n.created_at).getTime(), closedAt: n.closed_at ? new Date(n.closed_at).getTime() : null,
      cancelledAt: n.cancelled_at ? new Date(n.cancelled_at).getTime() : null,
      host: n.host_player || null, locked: !!n.locked_at,
    },
    players: by(players, 'id', r => ({ name: r.name, order: r.ord, ...(r.user_id ? { linked: true } : {}), ...(r.device ? { held: seatTag(r.device) } : {}) })),
    buyins: by(buyins, 'id', r => ({ pid: r.player_id, n: r.n, via: r.via, at: r.at })),
    cashouts: by(cashouts, 'player_id', r => ({ chips: r.chips, via: r.via, at: r.at })),
    food: by(food, 'id', r => ({ ...r.data, at: r.at })),
    log: by(log, 'id', r => ({ t: r.t, via: r.via, at: r.at, ...(r.by_name ? { by: r.by_name } : {}) })),
  };
}

async function count(c, table, nightId) {
  return (await c.query(`SELECT count(*)::int AS n FROM ${table} WHERE night_id = $1`, [nightId])).rows[0].n;
}
async function playerExists(c, nightId, pid) {
  return (await c.query('SELECT 1 FROM players WHERE night_id = $1 AND id = $2', [nightId, pid])).rowCount > 0;
}
// A buy-in, a count, or any part in an order: paying it, eating from it, or a
// line of its own or of its paid-back record.
async function hasMoney(c, nightId, pid) {
  const { rowCount } = await c.query(
    `SELECT 1 FROM buyins WHERE night_id = $1 AND player_id = $2
     UNION ALL SELECT 1 FROM cashouts WHERE night_id = $1 AND player_id = $2
     UNION ALL SELECT 1 FROM food WHERE night_id = $1 AND (
       data->>'payer' = $2 OR data->'eaters' ? $2 OR data->'own' ? $2 OR data->'paid' ? $2)
     LIMIT 1`, [nightId, pid]);
  return rowCount > 0;
}

// Keeps game_results true to the night after every write: one row per player
// while the count closes, none while it does not. closed_at on the night
// follows the same rule, and a night that reopens takes back a join code no
// open night is using. Returns true when THIS write is the one that closed it
// — the moment the settlement is announced (src/announce.js).
async function recompute(c, n) {
  const st = await stateOf(c, n);
  const P = pokerOf(st);
  if (!P.closed) {
    await c.query('DELETE FROM game_results WHERE night_id = $1', [n.id]);
    if (n.closed_at) {
      const clash = (await c.query('SELECT 1 FROM nights WHERE code = $1 AND closed_at IS NULL AND id <> $2', [n.code, n.id])).rowCount;
      const code = clash ? await freeCode(c, n.id) : n.code;
      await c.query('UPDATE nights SET closed_at = NULL, code = $2 WHERE id = $1', [n.id, code]);
    }
    return false;
  }
  const { rows: [{ closed_at: closedAt }] } = await c.query(
    'UPDATE nights SET closed_at = COALESCE(closed_at, now()) WHERE id = $1 RETURNING closed_at', [n.id]);
  const pot = Math.round(P.totalBuy * P.price);
  const users = Object.fromEntries((await c.query('SELECT id, user_id FROM players WHERE night_id = $1', [n.id])).rows.map(r => [r.id, r.user_id]));
  const keep = [];
  for (const p of P.inGame) {
    keep.push(p.id);
    await c.query(
      `INSERT INTO game_results (night_id, player_id, name, user_id, buyins, chips, net_ag, price_ag, chips_per_buyin, pot_ag, closed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (night_id, player_id) DO UPDATE SET name = $3, user_id = $4, buyins = $5, chips = $6, net_ag = $7,
         price_ag = $8, chips_per_buyin = $9, pot_ag = $10, updated_at = now()`,
      [n.id, p.id, p.name, users[p.id] || null, P.bi[p.id], st.cashouts[p.id]?.chips ?? 0, P.poker[p.id], P.price, P.cpb, pot, closedAt]);
  }
  await c.query('DELETE FROM game_results WHERE night_id = $1 AND NOT (player_id = ANY($2::text[]))', [n.id, keep]);
  return !n.closed_at;
}

// Is this write the host's? The page proves it with the phone that holds the
// host's seat; Olma's tools with the person's user id, which brokerd vouched for.
async function isHost(c, n, actor) {
  if (!n.host_player) return false;
  const { rows: [h] } = await c.query('SELECT device, user_id FROM players WHERE night_id = $1 AND id = $2', [n.id, n.host_player]);
  if (!h) return false;
  return !!((actor.device && h.device === actor.device) || (actor.userId && Number(h.user_id) === Number(actor.userId)));
}
// Is this seat the writer's own? Same two proofs, for a player's own chips.
async function isSeatOf(c, n, pid, actor) {
  const { rows: [p] } = await c.query('SELECT device, user_id FROM players WHERE night_id = $1 AND id = $2', [n.id, pid]);
  if (!p) return false;
  return !!((actor.device && p.device === actor.device) || (actor.userId && Number(p.user_id) === Number(actor.userId)));
}
// Whose seat is writing, by name, for the log (migration 005). Olma's user id
// first: a tool call carries no phone. null when neither proof names a seat.
async function writerName(c, n, actor) {
  const { rows: [p] } = actor.userId
    ? await c.query('SELECT name FROM players WHERE night_id = $1 AND user_id = $2 ORDER BY ord LIMIT 1', [n.id, actor.userId])
    : actor.device
      ? await c.query('SELECT name FROM players WHERE night_id = $1 AND device = $2 LIMIT 1', [n.id, actor.device])
      : { rows: [] };
  return p ? p.name : null;
}

/* One write from the page: { op: set|add|update|delete, col, id?, data?, device? }.
   The night row is locked for the length of the write, so two phones pressing
   "+ כניסה" at once are serialized rather than interleaved. Returns the id
   written (for add), the whole state after it, and `closed` — the night's id
   when this write closed the count, else null.
   `device` is the page's phone tag and `actor.userId` is set by Olma's tools;
   together they say who is writing, which only a LOCKED night asks
   (migration 004): there, buy-ins and other players' chips are the host's. */
async function write(pool, token, w, actor = {}) {
  if (!w || typeof w !== 'object') refuse('bad_doc');
  const now = Date.now();
  const who = { device: v.device(w.device), userId: actor.userId || null };
  return withTx(pool, async c => {
    const n = await lockNight(c, token);
    // Closed without a settlement is final: a later write would run
    // recompute, which reopens any night whose count does not add up.
    if (n.cancelled_at) refuse('cancelled');
    const { op, col } = w;
    let outId = w.id;
    const locked = !!n.locked_at;
    const hostOnly = async () => { if (locked && !await isHost(c, n, who)) refuse('locked'); };
    if (col === 'game') {
      if (op !== 'update') refuse('bad_op');
      const { locked: lock, host, ...p } = v.gamePatch(w.data);
      if (lock !== undefined || host !== undefined) {
        if (!n.host_player) refuse('no_host');
        if (!await isHost(c, n, who)) refuse('not_host');
      }
      if (lock !== undefined) p.locked_at = lock ? new Date(now) : null;
      // Handing the role on: only to a seat somebody can prove is theirs — a
      // phone sits in it, or Olma knows whose it is — or a locked night would
      // be left with a host nobody can be. Any key for the old seat dies.
      if (host !== undefined && host !== n.host_player) {
        const { rows: [to] } = await c.query('SELECT device, user_id FROM players WHERE night_id = $1 AND id = $2', [n.id, host]);
        if (!to) refuse('not_found');
        if (!to.device && !to.user_id) refuse('host_absent');
        Object.assign(p, { host_player: host, host_key: null, host_key_until: null });
      }
      if (!Object.keys(p).length) refuse('bad_doc');
      const sets = Object.keys(p).map((k, i) => `${k} = $${i + 2}`);
      await c.query(`UPDATE nights SET ${sets.join(', ')} WHERE id = $1`, [n.id, ...Object.values(p)]);
    } else if (col === 'players' && op === 'delete') {
      // "Added by mistake" (owner, 2026-10-01): only a seat with no money on
      // it, and never once the count has closed. Anybody holding the link can
      // write, so a seat carrying a debt must not be one tap from gone —
      // its buy-ins, its count and its food come off first, one by one.
      const pid = v.id(w.id);
      if (n.closed_at) refuse('closed');
      if (!await playerExists(c, n.id, pid)) refuse('not_found');
      if (await hasMoney(c, n.id, pid)) refuse('has_money');
      // A locked night keeps its host: without the seat nobody could unlock it.
      if (pid === n.host_player && locked) refuse('host_seat');
      await c.query('DELETE FROM players WHERE night_id = $1 AND id = $2', [n.id, pid]);
      if (pid === n.host_player) await c.query('UPDATE nights SET host_player = NULL WHERE id = $1', [n.id]);
    } else if (col === 'players' && op === 'hold') {
      // "This is me" from a phone (migration 002). A seat another phone holds
      // is refused unless the page asked twice (`take`), and a phone sits in
      // one seat: whatever else it held in this night is let go.
      const pid = v.id(w.id), d = v.hold(w.data);
      const { rows: [seat] } = await c.query('SELECT device FROM players WHERE night_id = $1 AND id = $2', [n.id, pid]);
      if (!seat) refuse('not_found');
      // The host's seat on a locked night: only the host's own phone, or a new
      // phone carrying the one-time key Olma sent them, which it uses up.
      const keyOk = pid === n.host_player && d.key && n.host_key === d.key && n.host_key_until > new Date(now);
      if (keyOk) await c.query('UPDATE nights SET host_key = NULL, host_key_until = NULL WHERE id = $1', [n.id]);
      else if (pid === n.host_player && locked && seat.device !== d.device) refuse('host_seat');
      else if (seat.device && seat.device !== d.device && !d.take) refuse('held');
      await c.query('UPDATE players SET device = NULL WHERE night_id = $1 AND device = $2 AND id <> $3', [n.id, d.device, pid]);
      await c.query('UPDATE players SET device = $3 WHERE night_id = $1 AND id = $2', [n.id, pid, d.device]);
    } else if (col === 'players' && op === 'release') {
      // "להחליף": only this phone's own hold comes off, never somebody else's.
      const pid = v.id(w.id), d = v.hold(w.data);
      // Letting go of the host's seat on a locked night would leave it to the
      // one-time key alone: unlock first.
      if (pid === n.host_player && locked) refuse('host_seat');
      await c.query('UPDATE players SET device = NULL WHERE night_id = $1 AND id = $2 AND device = $3', [n.id, pid, d.device]);
    } else if (col === 'players') {
      if (op !== 'set') refuse('bad_op');
      const pid = v.id(w.id), d = v.player(w.data);
      const exists = await playerExists(c, n.id, pid);
      if (!exists && await count(c, 'players', n.id) >= LIMITS.players) refuse('too_many');
      await c.query(
        `INSERT INTO players (night_id, id, name, ord) VALUES ($1, $2, $3, $4)
         ON CONFLICT (night_id, id) DO UPDATE SET name = $3, ord = $4`, [n.id, pid, d.name, d.order]);
    } else if (col === 'buyins') {
      await hostOnly();
      if (op === 'add') {
        const d = v.buyin(w.data, now);
        if (!await playerExists(c, n.id, d.pid)) refuse('not_found');
        if (await count(c, 'buyins', n.id) >= LIMITS.buyins) refuse('too_many');
        outId = newId();
        await c.query('INSERT INTO buyins (night_id, id, player_id, n, via, at) VALUES ($1, $2, $3, $4, $5, $6)', [n.id, outId, d.pid, d.n, d.via, d.at]);
      } else if (op === 'delete') {
        await c.query('DELETE FROM buyins WHERE night_id = $1 AND id = $2', [n.id, v.id(w.id)]);
      } else refuse('bad_op');
    } else if (col === 'cashouts') {
      const pid = v.id(w.id);
      if (locked && !await isSeatOf(c, n, pid, who)) await hostOnly();
      if (op === 'set') {
        const d = v.cashout(w.data, now);
        if (!await playerExists(c, n.id, pid)) refuse('not_found');
        await c.query(
          `INSERT INTO cashouts (night_id, player_id, chips, via, at) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (night_id, player_id) DO UPDATE SET chips = $3, via = $4, at = $5`, [n.id, pid, d.chips, d.via, d.at]);
      } else if (op === 'delete') {
        await c.query('DELETE FROM cashouts WHERE night_id = $1 AND player_id = $2', [n.id, pid]);
      } else refuse('bad_op');
    } else if (col === 'food') {
      if (op === 'add' || op === 'set') {
        const d = v.food(w.data, now);
        if (op === 'add') {
          if (await count(c, 'food', n.id) >= LIMITS.food) refuse('too_many');
          outId = newId();
        } else outId = v.id(w.id);
        const { at, ...data } = d;
        await c.query(
          `INSERT INTO food (night_id, id, data, at) VALUES ($1, $2, $3, $4)
           ON CONFLICT (night_id, id) DO UPDATE SET data = $3`, [n.id, outId, data, at]);
      } else if (op === 'delete') {
        await c.query('DELETE FROM food WHERE night_id = $1 AND id = $2', [n.id, v.id(w.id)]);
      } else refuse('bad_op');
    } else if (col === 'log') {
      if (op !== 'add') refuse('bad_op');
      const d = v.logLine(w.data, now);
      outId = newId();
      await c.query('INSERT INTO log (night_id, id, t, via, at, by_name) VALUES ($1, $2, $3, $4, $5, $6)',
        [n.id, outId, d.t, d.via, d.at, await writerName(c, n, who)]);
      await c.query(
        `DELETE FROM log WHERE night_id = $1 AND id IN (
           SELECT id FROM log WHERE night_id = $1 ORDER BY at DESC OFFSET $2)`, [n.id, LIMITS.log]);
    } else refuse('bad_col');

    const fresh = (await c.query('SELECT * FROM nights WHERE id = $1', [n.id])).rows[0];
    const closedNow = await recompute(c, fresh);
    const after = (await c.query('SELECT * FROM nights WHERE id = $1', [n.id])).rows[0];
    return { id: outId, state: await stateOf(c, after), closed: closedNow ? n.id : null };
  });
}

// "תסגרי את הערב" when nobody is going to count the chips: they changed their
// minds, or simply went home (owner, 2026-10-03). Until then the only way a
// night closed was the count adding up, so one nobody finished stayed open
// and every "ערב חדש" was answered with it. Nothing is calculated and nothing
// is sent; the page keeps what was written and stops taking writes.
// → { already: 'cancelled' | 'settled' } when there was nothing to close,
//   else { cancelled: true, buyins } — buyins being what was on the table.
async function cancelNight(pool, token, { via = 'tap' } = {}) {
  return withTx(pool, async c => {
    const n = await lockNight(c, token);
    if (n.cancelled_at) return { already: 'cancelled', night: n };
    if (n.closed_at) return { already: 'settled', night: n };
    const { rows: [{ b }] } = await c.query('SELECT coalesce(sum(n), 0)::float AS b FROM buyins WHERE night_id = $1', [n.id]);
    await c.query('UPDATE nights SET closed_at = now(), cancelled_at = now() WHERE id = $1', [n.id]);
    await c.query('DELETE FROM game_results WHERE night_id = $1', [n.id]);
    const line = v.logLine({ t: 'הערב נסגר בלי חישוב', via }, Date.now());
    await c.query('INSERT INTO log (night_id, id, t, via, at) VALUES ($1, $2, $3, $4, $5)', [n.id, newId(), line.t, line.via, line.at]);
    const after = (await c.query('SELECT * FROM nights WHERE id = $1', [n.id])).rows[0];
    return { cancelled: true, buyins: Number(b), night: after, state: await stateOf(c, after) };
  });
}

// "פתיחת ערב חדש" on a night you hold: same table, same price and chips
// unless changed, a fresh link. Capped so one link cannot mint nights for ever.
// Whoever presses it is the new night's host (owner, 2026-10-05; the page
// says so before they confirm): the seat with their phone's name, held by
// the same phone. A phone with no seat opens a night with no host.
async function nextNight(pool, token, opts = {}) {
  return withTx(pool, async c => {
    const n = await lockNight(c, token);
    const kids = (await c.query('SELECT count(*)::int AS k FROM nights WHERE prev_id = $1', [n.id])).rows[0].k;
    if (kids >= LIMITS.successors) refuse('too_many');
    const players = (await c.query('SELECT name FROM players WHERE night_id = $1 ORDER BY ord', [n.id])).rows;
    const out = await insertNight(c, {
      name: opts.name || 'ערב פוקר',
      price: opts.price ?? n.price_ag / 100,
      chips: opts.chips ?? n.chips_per_buyin,
      players,
      prevId: n.id,
    });
    const dev = v.device(opts.device);
    const { rows: [mine] } = dev ? await c.query('SELECT name FROM players WHERE night_id = $1 AND device = $2', [n.id, dev]) : { rows: [] };
    if (mine) {
      const { rows: [seat] } = await c.query('SELECT id FROM players WHERE night_id = $1 AND name = $2 ORDER BY ord LIMIT 1', [out.id, mine.name]);
      if (seat) {
        await c.query('UPDATE players SET device = $3 WHERE night_id = $1 AND id = $2', [out.id, seat.id, dev]);
        await c.query('UPDATE nights SET host_player = $2 WHERE id = $1', [out.id, seat.id]);
        out.host = seat.id;
      }
    }
    return out;
  });
}

// A one-time key for the host's seat, for Olma to send when the host is on a
// new phone (migration 004). A new key replaces any older one.
async function hostKey(pool, nightId) {
  const key = makeToken();
  await pool.query('UPDATE nights SET host_key = $2, host_key_until = $3 WHERE id = $1', [nightId, key, new Date(Date.now() + HOST_KEY_MS)]);
  return key;
}

module.exports = { createNight, findNight, stateOf, write, cancelNight, nextNight, hostKey, seatTag, LIMITS, makeToken, TOKEN };
