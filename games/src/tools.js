'use strict';
// The six game-night tools, behind gamesd's box-only POST /api/tool. The
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

const RECENT = "interval '3 days'";

const ok = obj => 'OK ' + JSON.stringify(obj);
const err = (code, message) => `ERROR ${code}: ${message}`;
class ToolError extends Error { constructor(code, message) { super(message); this.code = code; } }
const fail = (code, message) => { throw new ToolError(code, message); };

const newId = () => 'o' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

/* ── the page's formatting, for the lines people read ── */
const nfHe = new Intl.NumberFormat('he-IL');
const fmtChips = n => nfHe.format(Math.round(n));
const fmtAg = a => {
  const x = Math.abs(a), whole = x % 100 === 0;
  return '⁦' + (a < 0 ? '−' : '') + (x / 100).toLocaleString('he-IL', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 }) + ' ₪⁩';
};
const fmtAgEn = a => '₪' + (Math.abs(a) / 100).toLocaleString('en-US', { minimumFractionDigits: a % 100 ? 2 : 0, maximumFractionDigits: 2 });
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
    return out;
  };
  w.log = t => w('add', 'log', undefined, { t, via: 'olma' });
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

function summaryText(st, D, locale = 'he') {
  const name = id => st.players[id]?.name || '?';
  if (locale === 'en') {
    // Words, not an arrow, and every name isolated behind a left-to-right
    // mark: a line that opens on a Hebrew name is laid out right to left, and
    // "יוסי → מירון" then reads as the other person paying.
    const lines = xs => xs.map(x => `\u200E\u2068${name(x.from)}\u2069 pays \u2068${name(x.to)}\u2069: ${fmtAgEn(x.amt)}`).join('\n') || 'No transfers';
    let t = `${st.game.name} — settlement\nBuy-in ${fmtAgEn(D.price)} = ${D.cpb.toLocaleString('en-US')} chips\n\n`;
    if (D.merge) t += lines(D.xAll) + (D.hasFood ? '\n(food included)' : '');
    else { if (D.closed) t += 'Poker:\n' + lines(D.xPoker); if (D.hasFood) t += (D.closed ? '\n\n' : '') + 'Food:\n' + lines(D.xFood); }
    return t;
  }
  // The page's summaryText, word for word (public/night.html).
  const lines = xs => xs.map(x => `מ${name(x.from)} ל${name(x.to)}: ${fmtAg(x.amt)}`).join('\n') || 'אין העברות';
  let t = `סיכום ${st.game.name}\nכניסה ${fmtAg(D.price)} = ${fmtChips(D.cpb)} ז'יטונים\n\n`;
  if (D.merge) t += lines(D.xAll) + (D.hasFood ? '\n(כולל האוכל)' : '');
  else { if (D.closed) t += 'פוקר:\n' + lines(D.xPoker); if (D.hasFood) t += (D.closed ? '\n\n' : '') + 'אוכל:\n' + lines(D.xFood); }
  return t;
}

/* ── the tools ── */
const TOOLS = {
  async start_game_night({ pool, user, publicBase }, a) {
    const open = (await nightsOf(pool, user.id)).filter(n => !n.closed_at);
    if (open.length) fail('already_open', `they already have an open night, code ${open[0].code}: ${publicBase}/night/${open[0].token}`);
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

  async add_buyin({ pool, user, onState }, a) {
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
    return { night_code: n.code, player: who.name, added_to_table: who.added, cancelled: !!a.cancel, buyins: count, paid: shekels(count * ag(after.game.price)) };
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

  async report_chips({ pool, user, onState }, a) {
    const { st, token, me, n } = await ctx(pool, user, a.night_code);
    const chips = Number(a.chips);
    if (!Number.isInteger(chips) || chips < 0) fail('bad_number', 'chips is a whole number, 0 or more');
    const who = a.player ? findPlayer(st, a.player) || fail('not_found', `${a.player} is not at the table; players: ${namesOf(st).join(', ')}`)
      : { id: me, name: st.players[me].name };
    const w = writer(pool, token, onState);
    await w('set', 'cashouts', who.id, { chips, via: 'olma' });
    await w.log(`${who.name}: נשארו ${fmtChips(chips)} ז'יטונים`);
    const after = w.done();
    return { night_code: n.code, player: who.name, chips, ...standing(after, user.locale) };
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
