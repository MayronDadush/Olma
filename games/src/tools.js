'use strict';
// The seven game-night tools, behind gamesd's box-only POST /api/tool. The
// caller has already been resolved by brokerd (src/identity.js) and holds the
// 'games' pack; this file is only what each tool does to a night.
//
// Every write goes through store.write, the same door the page uses, so a
// tool cannot do anything the page's own validation would refuse, and the
// log lines are the page's own words with via 'olma'. Answers follow Olma's
// convention: `OK {json}` or `ERROR code: message`.
//
// Which night: the person's own — a night where a player row carries their
// user id — from the last three days. An open one wins; two open ones are
// ambiguous and the answer names both codes, so the model can ask.
const crypto = require('crypto');
const store = require('./store');
const { Refused } = require('./validate');
const { pokerOf, settlementOf, ag } = require('./money');
const { summaryText, fmtChips, fmtAg } = require('./summary');

const RECENT = "interval '3 days'";

const ok = obj => 'OK ' + JSON.stringify(obj);
const err = (code, message) => `ERROR ${code}: ${message}`;
class ToolError extends Error { constructor(code, message) { super(message); this.code = code; } }
const fail = (code, message) => { throw new ToolError(code, message); };

const newId = () => 'o' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

const FOOD = { pizza: '🍕', sushi: '🍣', burger: '🍔', shawarma: '🥙', drinks: '🍺' };
const kindOf = t => /פיצ|pizza/i.test(t) ? 'pizza' : /סושי|sushi/i.test(t) ? 'sushi' : /בורגר|המבורג|burger/i.test(t) ? 'burger'
  : /שו?ו?ארמה|פלאפל|שיפוד|לאפה|פיתה|shawarma|falafel/i.test(t) ? 'shawarma'
  : /בירה|שתי|יין|וודקה|וויסקי|אלכוהול|קולה|beer|wine|drinks?/i.test(t) ? 'drinks' : '';
const shekels = a => Math.round(a) / 100;

/* ── which night, which player ── */
async function nightsOf(pool, userId) {
  return (await pool.query(
    `SELECT DISTINCT ON (n.id) n.*, p.id AS my_pid FROM nights n
       JOIN players p ON p.night_id = n.id AND p.user_id = $1
      WHERE n.created_at > now() - ${RECENT}
      ORDER BY n.id, p.ord`, [userId])).rows
    .sort((a, b) => (a.closed_at ? 1 : 0) - (b.closed_at ? 1 : 0) || b.created_at - a.created_at);
}

async function pickNight(pool, user, code) {
  const rows = await nightsOf(pool, user.id);
  if (code) {
    const hit = rows.find(n => n.code === String(code).trim().toUpperCase());
    return hit || fail('not_found', `no night of theirs with code ${code} in the last 3 days`);
  }
  if (!rows.length) fail('no_night', 'they have no game night in the last 3 days; start_game_night opens one if they ask');
  const open = rows.filter(n => !n.closed_at);
  if (open.length > 1) fail('ambiguous', `two open nights: ${open.map(n => `${n.code} (${n.name})`).join(', ')} — ask which, then pass night_code`);
  return open[0] || rows[0];
}

const playersOf = st => Object.entries(st.players).map(([id, p]) => ({ id, ...p })).sort((a, b) => a.order - b.order);
const findPlayer = (st, name) => playersOf(st).find(p => norm(p.name) === norm(name)) || null;
const namesOf = st => playersOf(st).map(p => p.name);

async function ctx(pool, user, code) {
  const n = await pickNight(pool, user, code);
  const st = await store.stateOf(pool, n);
  return { n, st, token: n.token, me: n.my_pid };
}

/* ── writes, all through the page's door ── */
function writer(pool, token, onState) {
  let last = null;
  const w = async (op, col, id, data) => {
    const out = await store.write(pool, token, { op, col, id, data });
    last = out.state;
    if (out.closed) w.closed = out.closed;
    return out;
  };
  w.log = t => w('add', 'log', undefined, { t, via: 'olma' });
  w.closed = null;
  w.done = () => { if (last && onState) onState(token, last); return last; };
  return w;
}

async function ensurePlayer(w, st, name) {
  const hit = findPlayer(st, name);
  if (hit) return { id: hit.id, name: hit.name, added: false };
  const id = newId();
  const { state } = await w('set', 'players', id, { name: String(name).trim(), order: Date.now() });
  await w.log(`${state.players[id].name} בשולחן`);
  return { id, name: state.players[id].name, added: true };
}

const countOf = (st, pid) => Object.values(st.buyins).filter(b => b.pid === pid).reduce((a, b) => a + Number(b.n), 0);

// A settlement text is DRAWN, and the model only says one sentence around it.
// On 2026-09-30 the owner's first night closed and the model wrote its own
// summary instead — "מירון → יוסי 25 ₪" — and in a Hebrew line that arrow
// points at מירון, so it read as the wrong person paying. The description
// asked for a relay on game_night_summary only; the instruction now rides
// every result that carries the text, because the result is what gets read.
const RELAY = 'Your reply is `text` exactly as given, every line and character. One short sentence before it is fine; never restate its names or amounts in your own words, and never draw arrows.';
const withText = (s, text) => ({ ...s, text, relay: RELAY });

// Where the count stands once somebody reports: still waiting, off, or closed.
function standing(st, locale) {
  const D = settlementOf(st);
  if (!D.allIn) return { closed: false, waiting_for: D.missing.map(p => p.name) };
  if (!D.closed) return { closed: false, count_off: D.diff > 0 ? 'extra' : 'missing', chips: Math.abs(D.diff), expected: D.expected, counted: D.counted };
  return withText({ closed: true }, summaryText(st, D, locale));
}

// The call that closes the count does not hand the model the settlement to
// write out: it is sent to every linked player as its own message, by code
// (src/announce.js), and the result says only that. The text and the relay
// come back only when that did not happen for the person asking — brokerd
// unreachable, or a refusal — so they are never left with no settlement.
const SENT = 'The settlement just went to them as its own message from Olma, drawn by code, and to every other player on Olma. '
  + 'Do not write out any name, amount or transfer. At most one short line, e.g. that the night is closed.';
async function announced({ pool, user, announce }, w, st) {
  if (!w.closed || !announce) return {};
  let out;
  try { out = await announce(pool, w.closed, st); } catch (e) { out = { ok: false, error: e.message }; }
  if (out && out.ok && Array.isArray(out.queued) && out.queued.includes(user.id)) {
    return { summary_sent: true, note: SENT };
  }
  console.error('[gamesd tool] the settlement was not sent:', out && out.error || 'not queued for the caller');
  return { summary_sent: false };
}
const closing = async (env, w, st, s) => {
  const a = await announced(env, w, st);
  if (!a.summary_sent) return { ...s, ...a };
  const { text, relay, ...rest } = s;   // eslint-disable-line no-unused-vars
  return { ...rest, ...a };
};

// close_game_night's question, per person and night: when it was asked.
// In memory on purpose — a gamesd restart only means she asks again.
const CONFIRM_TTL_MS = 30 * 60_000;
const closeAsks = new Map();

/* ── the tools ── */
const TOOLS = {
  async start_game_night({ pool, user, publicBase }, a) {
    const open = (await nightsOf(pool, user.id)).filter(n => !n.closed_at);
    if (open.length) fail('already_open', `they already have an open night, code ${open[0].code}: ${publicBase}/night/${open[0].token}. `
      + 'If they asked for a new one in its place, close_game_night closes it without a settlement, then call this again.');
    const host = (user.name || (user.locale === 'en' ? 'Me' : 'אני')).slice(0, 24);
    const others = Array.isArray(a.players) ? a.players.filter(p => typeof p === 'string') : [];
    const n = await store.createNight(pool, { name: a.name || (user.locale === 'en' ? 'Poker night' : 'ערב פוקר'), price: a.price, chips: a.chips, players: [host, ...others] });
    // The host is the first row insertNight wrote; linking it is what makes
    // this night "theirs" to every later tool.
    await pool.query(
      `UPDATE players SET user_id = $2, linked_at = now(), linked_via = 'host'
        WHERE night_id = $1 AND ord = (SELECT min(ord) FROM players WHERE night_id = $1)`, [n.id, user.id]);
    const st = await store.stateOf(pool, (await store.findNight(pool, n.token)));
    return { night_code: n.code, url: `${publicBase}/night/${n.token}`, name: st.game.name, price: st.game.price, chips: st.game.chips, players: namesOf(st) };
  },

  async add_buyin(env, a) {
    const { pool, user, onState } = env;
    const { st, token, me, n } = await ctx(pool, user, a.night_code);
    const w = writer(pool, token, onState);
    const size = a.n == null ? 1 : Number(a.n);
    if (size !== 1 && size !== 0.5) fail('bad_number', 'n is 1 or 0.5');
    const who = a.player ? (a.cancel ? findPlayer(st, a.player) || fail('not_found', `${a.player} is not at the table; players: ${namesOf(st).join(', ')}`) : await ensurePlayer(w, st, a.player))
      : { id: me, name: st.players[me].name, added: false };
    if (a.cancel) {
      const mine = Object.entries(st.buyins).filter(([, b]) => b.pid === who.id).sort((x, y) => y[1].at - x[1].at);
      if (!mine.length) fail('nothing_to_cancel', `${who.name} has no buy-in to cancel`);
      await w('delete', 'buyins', mine[0][0]);
      await w.log(`${who.name} − ${Number(mine[0][1].n) === 1 ? 'כניסה' : 'חצי כניסה'}`);
    } else {
      await w('add', 'buyins', undefined, { pid: who.id, n: size, via: 'olma' });
      await w.log(`${who.name} ${size === 1 ? '+ כניסה' : '+ חצי כניסה'}`);
    }
    const after = w.done();
    const count = countOf(after, who.id);
    // Taking back a buy-in can be what makes the chips add up.
    const closedBy = w.closed ? await closing(env, w, after, standing(after, user.locale)) : {};
    return { night_code: n.code, player: who.name, added_to_table: who.added, cancelled: !!a.cancel, buyins: count, paid: shekels(count * ag(after.game.price)), ...closedBy };
  },

  async my_game_status({ pool, user, publicBase }, a) {
    const { st, me, n } = await ctx(pool, user, a.night_code);
    const count = countOf(st, me);
    const P = pokerOf(st);
    return {
      night_code: n.code, name: st.game.name, url: `${publicBase}/night/${n.token}`, open: !n.closed_at,
      buyins: count, paid: shekels(count * P.price), chips_reported: st.cashouts[me]?.chips ?? null,
      chip_value: P.price / P.cpb / 100, players: namesOf(st).length, pot: shekels(P.totalBuy * P.price),
    };
  },

  async report_chips(env, a) {
    const { pool, user, onState } = env;
    const { st, token, me, n } = await ctx(pool, user, a.night_code);
    const chips = Number(a.chips);
    if (!Number.isInteger(chips) || chips < 0) fail('bad_number', 'chips is a whole number, 0 or more');
    const who = a.player ? findPlayer(st, a.player) || fail('not_found', `${a.player} is not at the table; players: ${namesOf(st).join(', ')}`)
      : { id: me, name: st.players[me].name };
    const w = writer(pool, token, onState);
    await w('set', 'cashouts', who.id, { chips, via: 'olma' });
    await w.log(`${who.name}: נשארו ${fmtChips(chips)} ז'יטונים`);
    const after = w.done();
    return { night_code: n.code, player: who.name, chips, ...await closing(env, w, after, standing(after, user.locale)) };
  },

  async add_food_order({ pool, user, onState }, a) {
    const { st, token, me, n } = await ctx(pool, user, a.night_code);
    const amount = Number(a.amount);
    if (!(amount > 0)) fail('bad_number', 'amount is the total paid, more than 0');
    const what = String(a.what || '').trim() || 'אוכל';
    const payer = a.payer ? findPlayer(st, a.payer) || fail('not_found', `${a.payer} is not at the table; players: ${namesOf(st).join(', ')}`)
      : { id: me, name: st.players[me].name };
    const eaters = Array.isArray(a.eaters) ? a.eaters.filter(e => typeof e === 'string' && e.trim()) : [];
    if (!eaters.length) return { saved: false, ask: 'who ate from it', players: namesOf(st) };
    const ids = [];
    for (const e of eaters) {
      const p = findPlayer(st, e) || fail('not_found', `${e} is not at the table; players: ${namesOf(st).join(', ')}`);
      if (!ids.includes(p.id)) ids.push(p.id);
    }
    const kind = kindOf(what);
    const w = writer(pool, token, onState);
    await w('add', 'food', undefined, { kind, what, amount, payer: payer.id, eaters: ids });
    await w.log(`${FOOD[kind] || '🍽️'} ${what}, ${fmtAg(ag(amount))} · 💳 ${payer.name}`);
    const after = w.done();
    return {
      night_code: n.code, saved: true, what, amount, payer: payer.name, eaters: ids.map(id => after.players[id].name),
      each: Math.round(amount / ids.length * 100) / 100, settled: after.game.foodMode === 'split' ? 'separately' : 'with the poker',
    };
  },

  // Closing with no count (owner, 2026-10-03): the night they asked to close
  // and open again could not close, because only a count that adds up closed
  // a night. Only an OPEN one is closed here; a settled night is left alone.
  //
  // It is final, so it takes TWO calls, and the server counts them (owner,
  // same day: she makes sure it is what they meant). The first only asks and
  // says what is on the table; `confirm: true` closes only after a first call
  // for the same night by the same person in the last CONFIRM_TTL_MS. A
  // `confirm: true` with no question before it is answered as a first call.
  async close_game_night({ pool, user, onState }, a) {
    const n = await pickNight(pool, user, a.night_code);
    if (n.closed_at) return { night_code: n.code, closed: false, already: n.cancelled_at ? 'already closed without a settlement' : 'closed with a settlement' };
    const key = `${user.id}:${n.id}`;
    const askedAt = closeAsks.get(key);
    if (a.confirm !== true || !askedAt || Date.now() - askedAt > CONFIRM_TTL_MS) {
      closeAsks.set(key, Date.now());
      const st = await store.stateOf(pool, n);
      const players = playersOf(st);
      const total = Object.values(st.buyins).reduce((x, b) => x + Number(b.n), 0);
      return {
        night_code: n.code, name: n.name, closed: false, needs_confirmation: true,
        buyins_on_table: total, chips_reported: Object.keys(st.cashouts).length, players: players.length,
        ask: 'Nothing is closed yet. Ask them, in one short question, whether to close this night with no settlement for good, '
          + 'saying how many buy-ins are on the table if any. Call again with confirm:true only after they say yes in a new message, never in this turn.',
      };
    }
    closeAsks.delete(key);
    const r = await store.cancelNight(pool, n.token, { via: 'olma' });
    if (r.already) return { night_code: n.code, closed: false, already: r.already === 'settled' ? 'closed with a settlement' : 'already closed without a settlement' };
    if (onState) onState(n.token, r.state);
    return { night_code: n.code, name: n.name, closed: true, settlement: 'none — nothing was calculated or sent', buyins_on_table: r.buyins };
  },

  async game_night_summary({ pool, user, publicBase }, a) {
    const { st, n } = await ctx(pool, user, a.night_code);
    const D = settlementOf(st);
    const s = standing(st, user.locale);
    // Split food settles before the poker does; that text is real on its own.
    const r = !s.closed && !D.merge && D.hasFood ? withText(s, summaryText(st, D, user.locale)) : s;
    return { night_code: n.code, url: `${publicBase}/night/${n.token}`, ...r };
  },
};

const REFUSED = {
  bad_number: 'a number is out of range', bad_text: 'a name or text is empty or too long', too_many: 'the night is full',
  not_found: 'not found', bad_doc: 'malformed input',
  cancelled: 'that night was closed without a settlement and takes no more changes; start_game_night opens a new one',
};

async function runTool(name, args, env) {
  const fn = Object.hasOwn(TOOLS, name) ? TOOLS[name] : null;
  if (!fn) return err('unknown_tool', `no tool ${String(name).slice(0, 40)}`);
  try {
    return ok(await fn(env, args && typeof args === 'object' ? args : {}));
  } catch (e) {
    if (e instanceof ToolError) return err(e.code, e.message);
    if (e instanceof Refused) return err(e.code, REFUSED[e.code] || e.code);
    console.error('[gamesd tool]', name, e && e.stack || e);
    return err('internal', 'the game service failed part way; check the page before trying again');
  }
}

module.exports = { runTool, TOOLS, summaryText, kindOf };
