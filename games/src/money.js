'use strict';
// The arithmetic of a game night, on the server. The page carries its own
// copy of the same functions (public/night.html) so it can redraw on every
// keystroke without a round trip; tests/page-parity.test.js runs both on the
// same random nights and fails if they ever disagree. Everything is in
// agorot (integer cents): a float shekel never reaches a sum.

const ag = v => Math.round((+v || 0) * 100);

/* Minimum number of transfers, exactly: n minus the largest number of
   disjoint groups whose balances sum to zero (a group of m settles in m−1).
   Subset DP up to 15 non-zero balances; past that, one greedy group. */
function settle(bal) {
  const items = bal.filter(b => b.v !== 0);
  const k = items.length;
  if (!k) return [];
  let groups;
  if (k <= 15) {
    const N = 1 << k, sum = new Float64Array(N), dp = new Int8Array(N), ch = new Int8Array(N);
    for (let m = 1; m < N; m++) { const low = m & -m, b = 31 - Math.clz32(low); sum[m] = sum[m ^ low] + items[b].v; }
    for (let m = 1; m < N; m++) {
      let best = -1, bb = 0;
      for (let b = 0; b < k; b++) if (m >> b & 1) { const v = dp[m ^ (1 << b)]; if (v > best) { best = v; bb = b; } }
      dp[m] = best + (sum[m] === 0 ? 1 : 0); ch[m] = bb;
    }
    groups = []; let cur = [], m = N - 1;
    while (m) { const b = ch[m]; cur.push(items[b]); m ^= 1 << b; if (sum[m] === 0) { groups.push(cur); cur = []; } }
    if (cur.length) groups.push(cur);
  } else groups = [items];
  const out = [];
  for (const g of groups) {
    const cr = g.filter(x => x.v > 0).map(x => ({ id: x.id, v: x.v }));
    const db = g.filter(x => x.v < 0).map(x => ({ id: x.id, v: -x.v }));
    while (cr.length && db.length) {
      cr.sort((a, b) => b.v - a.v); db.sort((a, b) => b.v - a.v);
      const c = cr[0], d = db[0], a = Math.min(c.v, d.v);
      out.push({ from: d.id, to: c.id, amt: a });
      c.v -= a; d.v -= a;
      if (!c.v) cr.shift();
      if (!d.v) db.shift();
    }
  }
  return out.sort((a, b) => b.amt - a.amt);
}

function evenly(total, ids) {
  const out = {};
  if (!ids.length) return out;
  const base = Math.floor(total / ids.length);
  let rem = total - base * ids.length;
  ids.slice().sort().forEach(id => { out[id] = base + (rem-- > 0 ? 1 : 0); });
  return out;
}

/* One food order. `players` is the set of ids still in the night.
   paid: who put money down (none = the one payer paid all).
   own:  what a person's own dish cost; whoever left it empty splits the rest
   evenly, and when everyone named theirs the rest (delivery, tip) is split by
   all. Zero-sum: what was paid is exactly what is owed. */
function foodSplit(f, players) {
  const has = id => players.has(id);
  const amt = ag(f.amount);
  const eaters = (f.eaters || []).filter(has);
  const pay = {};
  const paidIds = Object.keys(f.paid || {}).filter(id => has(id) && ag(f.paid[id]) > 0);
  if (paidIds.length) {
    paidIds.forEach(id => { pay[id] = ag(f.paid[id]); });
    const r = amt - paidIds.reduce((a, id) => a + pay[id], 0);
    if (r) pay[paidIds.sort((a, b) => pay[b] - pay[a])[0]] += r;
  } else if (has(f.payer)) pay[f.payer] = amt;
  const own = {};
  let ownSum = 0;
  for (const e of eaters) if (f.own && f.own[e] != null && f.own[e] !== '') { own[e] = ag(f.own[e]); ownSum += own[e]; }
  let warn = null;
  if (ownSum > amt) { warn = 'over'; for (const k in own) delete own[k]; ownSum = 0; }
  const plain = eaters.filter(e => own[e] == null);
  const rest = evenly(amt - ownSum, plain.length ? plain : eaters);
  const owe = {};
  eaters.forEach(e => { owe[e] = (own[e] || 0) + (rest[e] || 0); });
  const ok = eaters.length > 0 && Object.keys(pay).length > 0;
  return { amt, pay, owe, own, plain, eaters, ok, warn };
}

/* The poker half of a night: who is in, whether the count closes, and each
   player's net in agorot. `night` is the page's shape:
   { game: {price, chips}, players: {id: {name, order}}, buyins: {id: {pid, n}},
     cashouts: {pid: {chips}} } */
function pokerOf(night) {
  const g = night.game || {};
  const S = night;
  const players = Object.entries(S.players || {}).map(([id, p]) => ({ id, ...p })).sort((a, b) => a.order - b.order);
  const bi = {};
  for (const b of Object.values(S.buyins || {})) if (S.players[b.pid]) bi[b.pid] = (bi[b.pid] || 0) + b.n;
  const price = Math.round((g.price || 0) * 100), cpb = g.chips || 1;
  const totalBuy = Object.values(bi).reduce((a, b) => a + b, 0);
  const expected = Math.round(totalBuy * cpb);
  const cash = S.cashouts || {};
  const inGame = players.filter(p => bi[p.id]);
  const missing = inGame.filter(p => !cash[p.id]);
  const counted = players.reduce((a, p) => a + (cash[p.id]?.chips || 0), 0);
  const diff = counted - expected;
  const allIn = inGame.length > 0 && !missing.length;
  const closed = allIn && diff === 0;
  const poker = {};
  for (const p of players) poker[p.id] = Math.round((cash[p.id]?.chips || 0) * price / cpb) - Math.round((bi[p.id] || 0) * price);
  if (closed) { // rounding to agorot can leave a few over; the biggest balance absorbs it
    const r = Object.values(poker).reduce((a, b) => a + b, 0);
    if (r) { const top = players.slice().sort((a, b) => Math.abs(poker[b.id]) - Math.abs(poker[a.id]))[0]; poker[top.id] -= r; }
  }
  return { players, bi, price, cpb, totalBuy, expected, counted, diff, inGame, missing, allIn, closed, poker };
}

/* Who pays whom, the page's derive() on the server: food either folds into
   the poker transfers ('merge') or is settled on its own ('split'). Poker
   transfers exist only once the count closes; split food settles at once. */
function settlementOf(night) {
  const P = pokerOf(night);
  const ids = new Set(P.players.map(p => p.id));
  const food = Object.fromEntries(P.players.map(p => [p.id, 0]));
  const orders = Object.values(night.food || {}).sort((a, b) => a.at - b.at);
  for (const f of orders) {
    const sp = foodSplit(f, ids); if (!sp.ok) continue;
    for (const id in sp.pay) food[id] += sp.pay[id];
    for (const id in sp.owe) food[id] -= sp.owe[id];
  }
  const merge = ((night.game || {}).foodMode || 'merge') === 'merge';
  const hasFood = orders.length > 0;
  const bal = fn => P.players.map(p => ({ id: p.id, v: fn(p.id) }));
  let xAll = [], xPoker = [], xFood = [];
  if (merge) { if (P.closed) xAll = settle(bal(id => P.poker[id] + food[id])); }
  else { if (P.closed) xPoker = settle(bal(id => P.poker[id])); if (hasFood) xFood = settle(bal(id => food[id])); }
  return { ...P, food, merge, hasFood, xAll, xPoker, xFood };
}

module.exports = { ag, settle, evenly, foodSplit, pokerOf, settlementOf };
