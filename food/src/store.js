'use strict';
// Every read and write of a person's food, for the page and for Olma's tools
// alike. There is one door per change: the page's write and the tool that
// means the same thing both call the function here, so neither can do what
// the other would refuse, and a portion learned from a tap on the page is the
// same lesson as one learned from "it was more tahini than that".
const crypto = require('crypto');
const { withTx } = require('./db');
const V = require('./validate');
const N = require('./nutrition');
const D = require('./days');
const photos = require('./photos');

const { refuse } = V;
const MAX_MEALS_PER_DAY = 40;
const BACK_DAYS = 7;          // how far back a meal can still be logged or changed

const newToken = () => {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const b = crypto.randomBytes(22);
  return Array.from(b, x => abc[x % abc.length]).join('');
};

/* ── people ── */

// The person, created on their first call. Their clock and language are
// refreshed from brokerd's answer every time: Olma's is the true one.
async function ensurePerson(pool, user) {
  const tz = isZone(user.timezone) ? user.timezone : null;
  const { rows: [p] } = await pool.query(
    `INSERT INTO people (user_id, token, name, timezone, locale)
     VALUES ($1, $2, $3, COALESCE($4, 'Asia/Jerusalem'), $5)
     ON CONFLICT (user_id) DO UPDATE SET
       name = COALESCE(EXCLUDED.name, people.name),
       timezone = COALESCE($4, people.timezone),
       locale = EXCLUDED.locale
     RETURNING *`,
    [user.id, newToken(), user.name ? String(user.name).slice(0, 40) : null, tz, user.locale === 'en' ? 'en' : 'he']);
  return p;
}
function isZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}
async function personByToken(pool, token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9]{22}$/.test(token)) return null;
  return (await pool.query('SELECT * FROM people WHERE token = $1', [token])).rows[0] || null;
}
async function reload(pool, userId) {
  return (await pool.query('SELECT * FROM people WHERE user_id = $1', [userId])).rows[0];
}

const todayOf = (p, at) => D.today(p.timezone, at);

// A day they may write to: today or up to a week back, never ahead.
function dayFor(p, v, { at } = {}) {
  const t = todayOf(p, at);
  if (v == null || v === '' || v === 'today') return t;
  if (v === 'yesterday') return D.addDays(t, -1);
  if (!D.isDay(v)) refuse('bad_day');
  // Before 04:00 the calendar is a date ahead of the food day, and a model
  // that reads the date off the clock will name it. That is tonight, not a
  // future day.
  if (v === D.partsIn(p.timezone, at).day) return t;
  const back = D.daysBetween(v, t);
  if (back < 0) refuse('future_day');
  if (back > BACK_DAYS) refuse('too_old');
  return v;
}

/* ── reading meals ── */

const itemOut = r => ({
  id: Number(r.id), name: r.name, grams: Number(r.grams),
  v: [Number(r.kcal100), Number(r.protein100), Number(r.carbs100), Number(r.fat100)],
  grp: r.grp, confidence: r.confidence,
  ...(r.food_id != null ? { food_id: Number(r.food_id) } : {}), ...(r.value_src ? { value_src: r.value_src } : {}),
});

async function mealsBetween(q, p, from, to) {
  const { rows: meals } = await q.query(
    `SELECT * FROM meals WHERE user_id = $1 AND day BETWEEN $2 AND $3 AND deleted_at IS NULL ORDER BY day, at, id`,
    [p.user_id, from, to]);
  if (!meals.length) return [];
  const { rows: items } = await q.query(
    'SELECT * FROM items WHERE meal_id = ANY($1) ORDER BY meal_id, ord, id', [meals.map(m => m.id)]);
  const by = new Map();
  for (const it of items) { const k = Number(it.meal_id); if (!by.has(k)) by.set(k, []); by.get(k).push(itemOut(it)); }
  return meals.map(m => mealOut(p, m, by.get(Number(m.id)) || []));
}
function mealOut(p, m, items) {
  const day = typeof m.day === 'string' ? m.day : dayString(m.day);
  const totals = m.rough ? N.rounded(N.sum([])) : N.rounded(N.sum(items));
  return {
    id: Number(m.id), day, slot: m.slot, slot_he: N.SLOT_HE[m.slot], time: timeIn(p.timezone, m.at),
    title: m.title, source: m.source, rough: m.rough, shared_part: m.shared_part || null, photo: !!m.photo,
    items: items.map(it => ({ ...it, kcal: N.r0(N.itemTotals(it).kcal) })),
    totals, balance: m.rough ? [] : N.balanceOf(items),
  };
}
// pg returns a DATE as a Date at local midnight of the server; read it back
// as the calendar date it was, never through a zone.
const dayString = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const timeIn = (tz, at) => { const x = D.partsIn(tz, new Date(at)); return `${String(x.hour).padStart(2, '0')}:${String(x.minute).padStart(2, '0')}`; };

async function mealOf(q, p, id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) refuse('not_found');
  const { rows: [m] } = await q.query('SELECT * FROM meals WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL', [n, p.user_id]);
  if (!m) refuse('not_found');
  const { rows } = await q.query('SELECT * FROM items WHERE meal_id = $1 ORDER BY ord, id', [n]);
  return mealOut(p, m, rows.map(itemOut));
}
// "the last one" = the newest meal they logged in the last two days.
async function lastMeal(q, p) {
  const { rows: [m] } = await q.query(
    `SELECT id FROM meals WHERE user_id = $1 AND deleted_at IS NULL AND day >= $2 ORDER BY created_at DESC, id DESC LIMIT 1`,
    [p.user_id, D.addDays(todayOf(p), -1)]);
  return m ? mealOf(q, p, m.id) : null;
}
const mealOrLast = async (q, p, id) => (id != null ? mealOf(q, p, id) : (await lastMeal(q, p)) || refuse('no_meal'));
const editable = (p, meal) => { if (D.daysBetween(meal.day, todayOf(p)) > BACK_DAYS) refuse('too_old'); };

/* ── portions: a correction is a lesson ── */

async function portionsOf(q, p) {
  const { rows } = await q.query('SELECT name, grams, from_grams, updated_at FROM portions WHERE user_id = $1 ORDER BY updated_at DESC', [p.user_id]);
  return rows.map(r => ({ name: r.name, grams: Number(r.grams), from_grams: r.from_grams == null ? null : Number(r.from_grams), updated: r.updated_at }));
}
async function learn(c, p, name, grams, fromGrams) {
  if (!(grams > 0)) return null;
  const key = N.base(name);
  await c.query(
    `INSERT INTO portions (user_id, name, grams, from_grams) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, name) DO UPDATE SET grams = $3, from_grams = $4, updated_at = now()`,
    [p.user_id, key, grams, fromGrams]);
  return { name: key, grams, from: fromGrams };
}
async function forgetPortion(pool, p, name) {
  const { rowCount } = await pool.query('DELETE FROM portions WHERE user_id = $1 AND name = $2', [p.user_id, N.base(V.text(name, 60))]);
  if (!rowCount) refuse('not_found');
  return { forgotten: N.base(name) };
}

/* ── writing meals ── */

async function insertItems(c, mealId, items) {
  let ord = 0;
  for (const it of items) {
    await c.query(
      `INSERT INTO items (meal_id, ord, name, grams, kcal100, protein100, carbs100, fat100, grp, confidence, food_id, value_src)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [mealId, ord++, it.name, it.grams, it.v[0], it.v[1], it.v[2], it.v[3], it.grp, it.confidence, it.food_id ?? null, it.value_src ?? null]);
  }
}

// One meal, on the day it was eaten. Items the person did not state an amount
// for take their learned portion, and the answer names each one that did.
async function logMeal(pool, p, a, { via = 'olma', at } = {}) {
  const day = dayFor(p, a.date ?? a.day, { at });
  const rough = a.rough === true;
  const items = rough ? V.items(a.items || [], { allowEmpty: true }) : V.items(a.items);
  const title = V.text(a.title || items.map(i => N.base(i.name)).slice(0, 3).join(', ') || 'ארוחה', 80);
  const source = V.SOURCES.includes(a.source) ? a.source : (via === 'page' ? 'page' : 'text');
  return withTx(pool, async c => {
    const { rows: [{ n }] } = await c.query('SELECT count(*)::int AS n FROM meals WHERE user_id = $1 AND day = $2 AND deleted_at IS NULL', [p.user_id, day]);
    if (n >= MAX_MEALS_PER_DAY) refuse('too_many');
    let slot = a.meal ?? a.slot;
    if (slot != null) slot = V.oneOf(slot, V.SLOTS, 'bad_slot');
    else {
      const isToday = day === todayOf(p, at);
      const { rows: [{ dinner }] } = await c.query(`SELECT count(*)::int AS dinner FROM meals WHERE user_id = $1 AND day = $2 AND slot = 'dinner' AND deleted_at IS NULL`, [p.user_id, day]);
      slot = isToday ? D.slotAt(D.hourIn(p.timezone, at), { hasDinner: dinner > 0 }) : 'dinner';
    }
    const applied = [];
    if (items.length) {
      const { rows } = await c.query('SELECT name, grams FROM portions WHERE user_id = $1', [p.user_id]);
      const mine = new Map(rows.map(r => [r.name, Number(r.grams)]));
      for (const it of items) {
        if (it.confidence === 'said' || it.confidence === 'label') continue;
        const g = mine.get(N.base(it.name));
        if (g && g !== it.grams) { applied.push({ name: N.base(it.name), from: it.grams, to: g }); it.grams = g; it.confidence = 'portion'; }
      }
    }
    const shared = a.shared_part ? V.text(String(a.shared_part), 60) : null;
    const { rows: [m] } = await c.query(
      `INSERT INTO meals (user_id, day, slot, at, title, source, rough, shared_part, via) VALUES ($1,$2,$3,COALESCE($4, now()),$5,$6,$7,$8,$9) RETURNING id`,
      [p.user_id, day, slot, at || null, title, source, rough, shared, via]);
    await insertItems(c, m.id, items);
    return { meal: await mealOf(c, p, m.id), applied };
  });
}

// Changing a meal. A new amount for an item is also a lesson about that item,
// unless it was read off a label: then the label was right and this was a
// different package.
async function editMeal(pool, p, a, { via = 'olma' } = {}) {
  return withTx(pool, async c => {
    const meal = await mealOrLast(c, p, a.meal_id);
    editable(p, meal);
    const learned = [];
    for (const ch of Array.isArray(a.changes) ? a.changes.slice(0, V.MAX_ITEMS) : []) {
      if (!V.isObj(ch)) refuse('bad_item');
      const it = ch.item_id != null ? meal.items.find(x => x.id === Number(ch.item_id))
        : meal.items.find(x => N.base(x.name) === N.base(String(ch.item || ch.name || '')));
      if (!it) refuse('item_not_found', `no item ${ch.item_id ?? ch.item ?? ''} in "${meal.title}"; items: ${meal.items.map(x => x.name).join(', ')}`);
      if (ch.remove === true) { await c.query('DELETE FROM items WHERE id = $1', [it.id]); continue; }
      if (ch.grams != null) {
        const g = Math.round(V.num(ch.grams, 0, 3000) * 10) / 10;
        if (g !== it.grams) {
          await c.query(`UPDATE items SET grams = $2, confidence = CASE WHEN confidence = 'label' THEN 'label' ELSE 'said' END WHERE id = $1`, [it.id, g]);
          if (it.confidence !== 'label' && g > 0 && ch.learn !== false) learned.push(await learn(c, p, it.name, g, it.grams));
        }
      }
      if (ch.rename) await c.query('UPDATE items SET name = $2 WHERE id = $1', [it.id, V.text(ch.rename, 60)]);
      if (ch.per100) {
        const v = V.item({ name: it.name, grams: 1, per100: ch.per100 }).v;
        // New values for an item are read off a label they sent (the tool
        // says so): the label wins over the table row from now on.
        await c.query(`UPDATE items SET kcal100=$2, protein100=$3, carbs100=$4, fat100=$5, value_src='label', food_id=NULL, confidence='label' WHERE id = $1`, [it.id, ...v]);
      }
    }
    if (Array.isArray(a.add) && a.add.length) {
      const add = V.items(a.add);
      if (meal.items.length + add.length > V.MAX_ITEMS) refuse('too_many');
      const { rows: [{ o }] } = await c.query('SELECT COALESCE(max(ord), -1)::int AS o FROM items WHERE meal_id = $1', [meal.id]);
      let ord = o + 1;
      for (const it of add) {
        await c.query(`INSERT INTO items (meal_id, ord, name, grams, kcal100, protein100, carbs100, fat100, grp, confidence, food_id, value_src) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [meal.id, ord++, it.name, it.grams, it.v[0], it.v[1], it.v[2], it.v[3], it.grp, it.confidence, it.food_id ?? null, it.value_src ?? null]);
      }
    }
    if (a.slot ?? a.meal) await c.query('UPDATE meals SET slot = $2 WHERE id = $1', [meal.id, V.oneOf(a.slot ?? a.meal, V.SLOTS, 'bad_slot')]);
    if (a.title) await c.query('UPDATE meals SET title = $2 WHERE id = $1', [meal.id, V.text(a.title, 80)]);
    if (a.date != null) await c.query('UPDATE meals SET day = $2 WHERE id = $1', [meal.id, dayFor(p, a.date)]);
    const { rows: [{ left }] } = await c.query('SELECT count(*)::int AS left FROM items WHERE meal_id = $1', [meal.id]);
    const gone = !left && !meal.rough ? await dropMeal(c, meal.id) : null;
    return { meal: left || meal.rough ? await mealOf(c, p, meal.id) : null, deleted: !left && !meal.rough, learned: learned.filter(Boolean), [PHOTO_GONE]: gone };
  }).then(afterDrop);
}

async function deleteMeal(pool, p, mealId) {
  return withTx(pool, async c => {
    const meal = await mealOrLast(c, p, mealId);
    editable(p, meal);
    const gone = await dropMeal(c, meal.id);
    return { deleted: { id: meal.id, title: meal.title, day: meal.day, slot: meal.slot }, [PHOTO_GONE]: gone };
  }).then(afterDrop);
}

// A meal deleted takes its photo with it (the owner's rule, 2026-10-08). The
// row forgets the file inside the transaction; the file goes only after it
// commits, so a rollback never leaves a row pointing at nothing it had.
const PHOTO_GONE = Symbol('photo');
async function dropMeal(c, id) {
  const { rows: [r] } = await c.query('SELECT photo FROM meals WHERE id = $1', [id]);
  await c.query('UPDATE meals SET deleted_at = now(), photo = NULL WHERE id = $1', [id]);
  return r ? r.photo : null;
}
function afterDrop(out) {
  if (out[PHOTO_GONE]) photos.remove(out[PHOTO_GONE]);
  delete out[PHOTO_GONE];
  return out;
}

// The photo a meal was read from, once it is on disk.
async function setPhoto(pool, p, mealId, name) {
  await pool.query('UPDATE meals SET photo = $3 WHERE id = $1 AND user_id = $2', [mealId, p.user_id, name]);
}
async function photoOf(pool, p, mealId) {
  const n = Number(mealId);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  const { rows: [r] } = await pool.query('SELECT photo FROM meals WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL', [n, p.user_id]);
  return r && r.photo ? photos.read(r.photo) : null;
}

// Everything they ever logged, newest day first, a page of days at a time:
// the page's "הצלחות" tab. `before` is the cursor, the oldest day already shown.
const JOURNAL_DAYS = 10;
async function journal(pool, p, { before } = {}) {
  const until = before && D.isDay(before) ? D.addDays(before, -1) : todayOf(p);
  const { rows } = await pool.query(
    `SELECT DISTINCT day FROM meals WHERE user_id = $1 AND deleted_at IS NULL AND day <= $2 ORDER BY day DESC LIMIT $3`,
    [p.user_id, until, JOURNAL_DAYS + 1]);
  const days = rows.map(r => (typeof r.day === 'string' ? r.day : dayString(r.day)));
  const more = days.length > JOURNAL_DAYS;
  const shown = days.slice(0, JOURNAL_DAYS);
  if (!shown.length) return { days: [], more: false, numbers: p.numbers, today_day: todayOf(p) };
  const meals = await mealsBetween(pool, p, shown[shown.length - 1], shown[0]);
  return {
    numbers: p.numbers, today_day: todayOf(p), more, editable_from: D.addDays(todayOf(p), -BACK_DAYS),
    days: shown.map(d => ({ day: d, date_he: D.heDate(d), meals: meals.filter(m => m.day === d) })),
  };
}

// The same meal again, on another day: "like yesterday", or one of the usual.
async function relog(pool, p, a, { via = 'olma', source = 'repeat' } = {}) {
  const src = await mealOf(pool, p, a.meal_id);
  return logMeal(pool, p, {
    date: a.date, meal: a.meal ?? a.slot, title: src.title, source: V.SOURCES.includes(source) ? source : 'repeat',
    items: src.items.map(it => ({ name: it.name, grams: it.grams, per100: { kcal: it.v[0], protein: it.v[1], carbs: it.v[2], fat: it.v[3] }, group: it.grp, confidence: 'said', food_id: it.food_id, value_src: it.value_src })),
  }, { via });
}

/* ── water, settings ── */

// Counted in ml since migration 005; a cup is 250 ml. `cups` is still
// written, the nearest whole cup, for every reader that knows only cups.
const CUP_ML = 250;
const VESSELS = [250, 500, 750, 1000, 1500];
async function water(pool, p, { date, cups, add, ml, add_ml } = {}) {
  const day = dayFor(p, date);
  const now = await pool.query('SELECT COALESCE(ml, cups * 250) AS ml FROM water WHERE user_id = $1 AND day = $2', [p.user_id, day]);
  const had = now.rows[0] ? now.rows[0].ml : 0;
  let n;
  if (ml != null) n = V.num(ml, 0, 10000);
  else if (cups != null) n = V.num(cups, 0, 30) * CUP_ML;
  else if (add_ml != null) n = had + V.num(add_ml, -10000, 10000);
  else n = had + V.num(add ?? 1, -30, 30) * CUP_ML;
  n = Math.max(0, Math.min(10000, Math.round(n)));
  const c = Math.min(30, Math.round(n / CUP_ML));
  await pool.query(`INSERT INTO water (user_id, day, cups, ml) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id, day) DO UPDATE SET cups = $3, ml = $4`, [p.user_id, day, c, n]);
  return { day, cups: c, ml: n, goal: p.water_goal, goal_ml: p.water_goal_ml };
}
async function setWaterGoal(pool, p, ml) {
  const g = Math.round(V.num(ml, 500, 6000));
  const cups = Math.max(1, Math.min(20, Math.round(g / CUP_ML)));
  await pool.query('UPDATE people SET water_goal_ml = $2, water_goal = $3 WHERE user_id = $1', [p.user_id, g, cups]);
  return { goal_ml: g };
}
async function setVessel(pool, p, v) {
  const n = Number(v);
  if (!VESSELS.includes(n)) refuse('bad_value');
  await pool.query('UPDATE people SET water_vessel = $2 WHERE user_id = $1', [p.user_id, n]);
  return { vessel: n };
}

async function setNumbers(pool, p, on) {
  if (typeof on !== 'boolean') refuse('bad_value');
  await pool.query('UPDATE people SET numbers = $2 WHERE user_id = $1', [p.user_id, on]);
  return { numbers: on };
}
async function setGoal(pool, p, g) {
  const kcal = Math.round(V.num(g.kcal, 800, 6000)), protein = Math.round(V.num(g.protein, 10, 400));
  const carbs = Math.round(V.num(g.carbs, 0, 800)), fat = Math.round(V.num(g.fat, 10, 300));
  await pool.query('UPDATE people SET goal_kcal=$2, goal_protein=$3, goal_carbs=$4, goal_fat=$5, goal_set=true, numbers=true WHERE user_id = $1', [p.user_id, kcal, protein, carbs, fat]);
  return { kcal, protein, carbs, fat };
}
async function setChallenge(pool, p, key) {
  const k = key == null || key === 'none' ? null : V.oneOf(key, V.CHALLENGES, 'bad_challenge');
  await pool.query('UPDATE people SET challenge = $2 WHERE user_id = $1', [p.user_id, k]);
  return { challenge: k, he: k ? N.CHALLENGES[k].he : null };
}

/* ── the usual, and meals that log themselves ── */

// What they ate three times or more in four weeks, by title, newest copy first.
async function usualOf(q, p) {
  const { rows } = await q.query(
    `SELECT title, count(*)::int AS times, max(id) AS last_id, mode() WITHIN GROUP (ORDER BY slot) AS slot
       FROM meals WHERE user_id = $1 AND deleted_at IS NULL AND NOT rough AND day >= $2
      GROUP BY title HAVING count(*) >= 3 ORDER BY count(*) DESC, max(id) DESC LIMIT 6`,
    [p.user_id, D.addDays(todayOf(p), -28)]);
  const { rows: auto } = await q.query('SELECT title, hour FROM auto_meals WHERE user_id = $1', [p.user_id]);
  const on = new Map(auto.map(a => [a.title, a.hour]));
  return rows.map(r => ({ title: r.title, times: r.times, meal_id: Number(r.last_id), slot: r.slot, auto_hour: on.has(r.title) ? on.get(r.title) : null }));
}

async function setAuto(pool, p, a) {
  if (a.on === false) {
    const t = V.text(String(a.title || ''), 80);
    const { rowCount } = await pool.query('DELETE FROM auto_meals WHERE user_id = $1 AND title = $2', [p.user_id, t]);
    if (!rowCount) refuse('not_found');
    return { title: t, auto: false };
  }
  const src = await mealOf(pool, p, a.meal_id);
  const hour = a.hour == null ? 8 : Math.round(V.num(a.hour, 0, 23));
  const items = src.items.map(it => ({ name: it.name, grams: it.grams, per100: { kcal: it.v[0], protein: it.v[1], carbs: it.v[2], fat: it.v[3] }, group: it.grp, confidence: 'said' }));
  // Today counts as done when it is already past the hour: turning it on at
  // noon must not log a second morning coffee on top of the one just sent.
  const today = todayOf(p);
  const lastDay = D.hourIn(p.timezone) >= hour ? today : null;
  await pool.query(
    `INSERT INTO auto_meals (user_id, title, slot, hour, items, last_day) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (user_id, title) DO UPDATE SET slot=$3, hour=$4, items=$5`,
    [p.user_id, src.title, src.slot, hour, JSON.stringify(items), lastDay]);
  return { title: src.title, auto: true, hour, slot: src.slot };
}

// Every due auto meal, written once per local day. Called by foodd every
// minute; returns what it wrote, for the log.
async function runAuto(pool, { at = new Date() } = {}) {
  const { rows } = await pool.query(
    'SELECT a.*, p.timezone FROM auto_meals a JOIN people p USING (user_id)');
  const wrote = [];
  for (const a of rows) {
    // The hour is the clock's, the day is the food day (D.today), so an auto
    // meal set for 02:00 is written once and never onto a day still ahead.
    const x = { hour: D.hourIn(a.timezone, at), day: D.today(a.timezone, at) };
    const last = a.last_day ? (typeof a.last_day === 'string' ? a.last_day : dayString(a.last_day)) : null;
    if (x.hour < a.hour || last === x.day) continue;
    const { rowCount } = await pool.query(
      'UPDATE auto_meals SET last_day = $3 WHERE user_id = $1 AND title = $2 AND (last_day IS NULL OR last_day < $3)',
      [a.user_id, a.title, x.day]);
    if (!rowCount) continue;           // another tick got there first
    const p = await reload(pool, a.user_id);
    const out = await logMeal(pool, p, { date: x.day, meal: a.slot, title: a.title, source: 'auto', items: a.items }, { via: 'auto', at });
    wrote.push({ user_id: Number(a.user_id), meal_id: out.meal.id });
  }
  return wrote;
}

/* ── views ── */

// The week a day falls in, for the week card: its meals, water and challenge.
async function weekOf(pool, p, day) {
  const d = day ? dayFor(p, day) : todayOf(p);
  const from = D.weekStart(d), to = D.addDays(from, 6);
  const meals = await mealsBetween(pool, p, from, to);
  const w = await waterOf(pool, p, from, to);
  const v = await dayView(pool, p, d);
  return { from, to, meals, water_ml: Array.from({ length: 7 }, (_, i) => w.get(D.addDays(from, i)) || 0), challenge: v.challenge };
}

async function waterOf(q, p, from, to) {
  const { rows } = await q.query('SELECT day, COALESCE(ml, cups * 250) AS ml FROM water WHERE user_id = $1 AND day BETWEEN $2 AND $3', [p.user_id, from, to]);
  return new Map(rows.map(r => [typeof r.day === 'string' ? r.day : dayString(r.day), r.ml]));
}

// `water` stays in cups (the nearest whole one) for the challenge and every
// older reader; `water_ml` is the count.
function dayDigest(meals, ml) {
  const real = meals.filter(m => !m.rough);
  const t = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  for (const m of real) for (const k in t) t[k] += m.totals[k];
  const counts = { protein: 0, veg: 0, grain: 0 };
  for (const m of real) for (const b of m.balance) counts[b] += 1;
  return { totals: N.rounded(t), meal_count: meals.length, balance_counts: counts, water: Math.round((ml || 0) / CUP_ML), water_ml: ml || 0 };
}

const goalOf = p => ({ kcal: p.goal_kcal, protein: p.goal_protein, carbs: p.goal_carbs, fat: p.goal_fat, set: p.goal_set });

// Everything the page shows for one day, and what a tool answers from.
async function dayView(pool, p, day, { publicBase = '' } = {}) {
  const today = todayOf(p);
  const d = day ? dayFor(p, day) : today;
  const ws = D.weekStart(d);
  const weekMeals = await mealsBetween(pool, p, ws, D.addDays(ws, 6));
  const waters = await waterOf(pool, p, ws, D.addDays(ws, 6));
  const meals = weekMeals.filter(m => m.day === d);
  const dig = dayDigest(meals, waters.get(d));
  const week = [];
  for (let i = 0; i < 7; i++) {
    const day_ = D.addDays(ws, i);
    const ms = weekMeals.filter(m => m.day === day_);
    const dd = dayDigest(ms, waters.get(day_));
    const future = day_ > today;
    week.push({ day: day_, weekday: D.HE_DAYS[i], kcal: future ? null : dd.totals.kcal, meals: ms.length, future,
      met: future || !p.challenge ? null : (day_ === today && !N.CHALLENGES[p.challenge].met({ meals: ms, water: dd.water }) ? null : N.CHALLENGES[p.challenge].met({ meals: ms, water: dd.water })) });
  }
  const challenge = p.challenge ? {
    key: p.challenge, he: N.CHALLENGES[p.challenge].he,
    score: week.filter(w => w.met === true).length, so_far: week.filter(w => !w.future).length,
    days: week.map(w => ({ day: w.day, met: w.met, future: w.future })),
  } : null;
  const goal = goalOf(p);
  return {
    person: { name: p.name, numbers: p.numbers, goal, water_goal: p.water_goal, water_goal_ml: p.water_goal_ml, water_vessel: p.water_vessel, timezone: p.timezone },
    url: publicBase ? `${publicBase}/food/${p.token}` : null,
    day: d, date_he: D.heDate(d), today: d === today, today_day: today,
    meals, ...dig,
    left: p.numbers ? { kcal: goal.kcal - dig.totals.kcal, protein: N.r1(goal.protein - dig.totals.protein) } : null,
    week, challenge,
    portions: await portionsOf(pool, p),
    usual: await usualOf(pool, p),
    insights: await insights(pool, p),
  };
}

// Small true things found in what they logged. Every one is computed, and an
// empty list is the honest answer for somebody who has logged little.
async function insights(q, p) {
  const today = todayOf(p);
  const out = [];
  const month = await mealsBetween(q, p, D.addDays(today, -29), today);
  const real = month.filter(m => !m.rough);
  const counts = new Map();
  for (const m of real) for (const it of new Set(m.items.map(i => N.base(i.name)))) counts.set(it, (counts.get(it) || 0) + 1);
  const top = [...counts].sort((a, b) => b[1] - a[1])[0];
  if (top && top[1] >= 4) out.push({ key: 'top_item', numbers: false, he: `מה שהכי חוזר אצלך החודש: ${top[0]}, ב-${top[1]} ארוחות.` });
  const week = real.filter(m => D.daysBetween(m.day, today) < 7);
  const best = week.slice().sort((a, b) => b.totals.protein - a.totals.protein)[0];
  if (best && best.totals.protein >= 20) out.push({ key: 'protein_meal', numbers: true, he: `הארוחה הכי חלבונית שלך השבוע: ${best.title}, עם ${N.r0(best.totals.protein)} ג׳ חלבון.` });
  const logged = new Set(month.filter(m => D.daysBetween(m.day, today) < 7).map(m => m.day)).size;
  if (logged >= 3) out.push({ key: 'days_logged', numbers: false, he: `רשמת ${logged} מתוך 7 הימים האחרונים.` });
  // The same dish on the same weekday, at least three different weeks.
  const habit = new Map();
  for (const m of real) {
    const k = `${D.weekday(m.day)}|${m.title}`;
    if (!habit.has(k)) habit.set(k, new Set());
    habit.get(k).add(D.weekStart(m.day));
  }
  const h = [...habit].filter(([, w]) => w.size >= 3).sort((a, b) => b[1].size - a[1].size)[0];
  if (h) { const [wd, title] = h[0].split('|'); out.push({ key: 'weekday_habit', numbers: false, he: `${title} מופיע אצלך בימי ${D.HE_DAYS[Number(wd)]}, כבר ${h[1].size} שבועות. מסורת?` }); }
  return out;
}

module.exports = {
  ensurePerson, personByToken, reload, todayOf, dayFor,
  mealsBetween, mealOf, lastMeal, logMeal, editMeal, deleteMeal, relog,
  portionsOf, forgetPortion, water, setWaterGoal, setVessel, VESSELS, setNumbers, setGoal, setChallenge,
  usualOf, setAuto, runAuto, dayView, weekOf, insights, BACK_DAYS,
  setPhoto, photoOf, journal,
};
