'use strict';
// The food tools, behind foodd's box-only POST /api/tool. The caller has
// already been resolved by brokerd (src/identity.js) and holds the 'food'
// pack; this file is only what each tool does, and every write is the same
// store function the page's write calls (src/server.js). Answers follow
// Olma's convention: `OK {json}` or `ERROR code: message`.
//
// Two things are decided HERE and not left to the model:
//  - In no-numbers mode a result carries no calorie or gram at all. A number
//    the model was never handed is one it cannot say.
//  - A result never judges. Where the data suggests somebody is eating very
//    little day after day, the result says how to respond, once a week.
const store = require('./store');
const N = require('./nutrition');
const D = require('./days');
const card = require('./card');
const foods = require('./foods');
const plate = require('./plate');
const llm = require('./llm');
const { Refused } = require('./validate');

const ok = obj => 'OK ' + JSON.stringify(obj);
const err = (code, message) => `ERROR ${code}: ${message}`;
class ToolError extends Error { constructor(code, message) { super(message); this.code = code; } }
const fail = (code, message) => { throw new ToolError(code, message); };

/* ── what a result may say ── */

const plateHe = balance => balance.map(b => N.BALANCE_HE[b]);
function mealBrief(m, numbers) {
  const out = { meal_id: m.id, title: m.title, meal: m.slot, day: m.day, time: m.time };
  if (m.rough) return { ...out, rough: true };
  out.items = m.items.map(it => numbers
    ? { name: it.name, grams: it.grams, kcal: it.kcal, ...(it.confidence === 'portion' ? { their_portion: true } : {}) }
    : { name: it.name, group: N.GROUP_HE[it.grp] });
  if (numbers) out.totals = m.totals;
  out.plate = plateHe(m.balance);
  if (m.shared_part) out.shared_part = m.shared_part;
  return out;
}
function dayBrief(v, numbers) {
  const out = { date: v.day, date_he: v.date_he, meals: v.meals.map(m => mealBrief(m, numbers)), water: { cups: v.water, ml: v.water_ml, goal: v.person.water_goal, goal_ml: v.person.water_goal_ml } };
  if (numbers) {
    out.totals = v.totals;
    out.goal = { ...v.person.goal, ...(v.person.goal.set ? {} : { note: 'a default; set_food_goal sets theirs' }) };
    out.left = v.left;
  } else {
    out.plate = { meals: v.meals.length, with_protein: v.balance_counts.protein, with_vegetables: v.balance_counts.veg, with_grains: v.balance_counts.grain };
  }
  if (v.challenge) out.challenge = { name: v.challenge.he, this_week: `${v.challenge.score} of ${v.challenge.so_far} days so far`, today_met: v.challenge.days.find(d => d.day === v.day)?.met ?? null };
  return out;
}
const insightFor = (v, numbers) => (v.insights.find(i => numbers || !i.numbers) || {}).he || null;

// Very little, several days running. Said once a week per person, in memory:
// a restart only means it may be said again.
const CARE_EVERY_MS = 7 * 864e5;
const careSaid = new Map();
async function careNote(pool, p) {
  if (!p.numbers) return null;
  const t = store.todayOf(p);
  const meals = await store.mealsBetween(pool, p, D.addDays(t, -3), D.addDays(t, -1));
  for (let i = 1; i <= 3; i++) {
    const day = D.addDays(t, -i);
    const ms = meals.filter(m => m.day === day && !m.rough);
    if (ms.length < 2 || ms.reduce((a, m) => a + m.totals.kcal, 0) >= 1000) return null;
  }
  const last = careSaid.get(p.user_id);
  if (last && Date.now() - last < CARE_EVERY_MS) return null;
  careSaid.set(p.user_id, Date.now());
  return 'They logged under 1,000 kcal on each of the last three days. Do not praise it and never suggest eating less. '
    + 'Once, warmly and briefly, ask how they are doing, and offer to hide the numbers (food_numbers on:false). If they mention distress about food, be kind and suggest talking to someone they trust or a professional.';
}

const NOTE_LOG = 'One short line: what you logged and, if it helps, what is left today. Never judge a food or a total. Mention a portion the server applied ("I used your usual 40 g of tahini").';
const NOTE_NO_NUMBERS = 'No-numbers mode: never say a calorie or gram amount. Talk about what was on the plate.';

// A goal waiting for their yes: the second call saves it.
const CONFIRM_TTL_MS = 30 * 60_000;
const goalAsks = new Map();

/* ── the tools ── */
const TOOLS = {
  async log_meal({ pool, p, fetchImpl }, a) {
    if (!Array.isArray(a.items)) fail('bad_item', 'items is a list of {name, name_en, grams}');
    const items = a.rough === true ? a.items : await foods.resolve(pool, a.items.slice(0, 12), { userId: p.user_id, fetchImpl });
    const { meal, applied } = await store.logMeal(pool, p, { ...a, items }, { via: 'olma' });
    const v = await store.dayView(pool, p, meal.day);
    const out = { logged: mealBrief(meal, p.numbers), for_day: meal.day === v.today_day ? 'today' : meal.day };
    if (applied.length) out.applied_portions = applied.map(x => (p.numbers ? x : { name: x.name }));
    if (meal.day === v.today_day) out.today = p.numbers ? { totals: v.totals, left: v.left } : { meals: v.meals.length, with_vegetables: v.balance_counts.veg };
    else out.that_day = p.numbers ? { totals: v.totals } : { meals: v.meals.length };
    const care = await careNote(pool, p);
    return { ...out, note: p.numbers ? NOTE_LOG : `${NOTE_LOG} ${NOTE_NO_NUMBERS}`, ...(care ? { care } : {}) };
  },

  // A photo of their plate: the vision step reads it, the table values it,
  // and it is logged at once, because correcting is easier than confirming.
  // The one question the model may have (an unclear amount, oil it cannot
  // see) is asked after, and its answer is an edit_meal.
  async see_meal_photo({ pool, p, fetchImpl, readMedia }, a) {
    if (typeof a.path !== 'string' || !a.path) fail('missing', 'path: the exact file path the system showed you for the photo, this turn');
    if (await plate.photosToday(pool, p) >= plate.PHOTOS_PER_DAY) fail('rate_limited', `${plate.PHOTOS_PER_DAY} photos in a day is the limit; log the rest with log_meal from what they tell you`);
    let media;
    try { media = await readMedia({ userId: p.user_id, path: a.path }); } catch (e) { fail('unavailable', `the photo could not be fetched (${e.message}); ask them to send it again`); }
    if (!media || !media.ok) fail(media?.code === 'too_old' ? 'too_old' : 'no_photo', `${media?.error || 'no photo'}. Never invent or reuse a path; if none was shown this turn, ask them to send the photo again.`);
    let got;
    try { got = await plate.logPhoto(pool, p, { mime: media.mime, base64: media.base64, note: a.note, meal: a.meal, date: a.date, via: 'olma', fetchImpl }); } catch (e) {
      if (e instanceof llm.ModelUnavailable) fail('unavailable', `the photo could not be read right now (${e.message}). Ask them what they ate in words and use log_meal.`);
      throw e;
    }
    const { seen, meal, applied, items } = got;
    if (!meal) return { logged: null, note: 'There is no food in this photo. Ask, in one line, whether they meant to send another one.' };
    const v = await store.dayView(pool, p, meal.day);
    const out = { logged: mealBrief(meal, p.numbers), for_day: meal.day === v.today_day ? 'today' : meal.day };
    if (applied.length) out.applied_portions = applied.map(x => (p.numbers ? x : { name: x.name }));
    if (meal.day === v.today_day) out.today = p.numbers ? { totals: v.totals, left: v.left } : { meals: v.meals.length, with_vegetables: v.balance_counts.veg };
    const rough = items.filter(it => it.value_src === 'group').map(it => it.name);
    if (rough.length) out.estimated = rough;
    if (seen.question) out.ask = seen.question;
    const care = await careNote(pool, p);
    const next = seen.question
      ? 'Say in one short line what you logged, then ask the question in `ask`, in your own words, short. Their answer is an edit_meal on this meal_id (add oil as an item, or change an amount).'
      : 'Say in one short line what you logged; they can correct any amount.';
    return { ...out, note: p.numbers ? `${next} ${NOTE_LOG}` : `${next} ${NOTE_NO_NUMBERS}`, ...(care ? { care } : {}) };
  },

  async edit_meal({ pool, p, fetchImpl }, a) {
    const add = Array.isArray(a.add) && a.add.length ? await foods.resolve(pool, a.add.slice(0, 12), { userId: p.user_id, fetchImpl }) : a.add;
    const r = await store.editMeal(pool, p, { ...a, add }, { via: 'olma' });
    return {
      ...(r.meal ? { meal: mealBrief(r.meal, p.numbers) } : { deleted: true }),
      learned: r.learned.map(x => (p.numbers ? x : { name: x.name })),
      ...(r.learned.length ? { note: 'Tell them, in one line, that next time you will start from this amount.' } : {}),
    };
  },

  async delete_meal({ pool, p }, a) {
    return await store.deleteMeal(pool, p, a.meal_id);
  },

  async log_water({ pool, p }, a) {
    return await store.water(pool, p, { date: a.date, cups: a.cups, add: a.cups == null ? (a.add ?? 1) : undefined });
  },

  async food_today({ pool, p, publicBase }, a) {
    const v = await store.dayView(pool, p, a.date, { publicBase });
    const care = await careNote(pool, p);
    return { ...dayBrief(v, p.numbers), insight: insightFor(v, p.numbers), url: v.url, ...(p.numbers ? {} : { note: NOTE_NO_NUMBERS }), ...(care ? { care } : {}) };
  },

  async food_week({ pool, p, publicBase }, a) {
    const v = await store.dayView(pool, p, a.date, { publicBase });
    const past = v.week.filter(w => !w.future);
    const logged = past.filter(w => w.meals > 0);
    const out = { week_of: v.week[0].day, days_logged: `${logged.length} of ${past.length}`, url: v.url };
    out.days = v.week.map(w => ({ day: w.day, weekday: w.weekday, meals: w.meals, ...(p.numbers ? { kcal: w.kcal } : {}), ...(w.future ? { future: true } : {}) }));
    if (p.numbers && logged.length) out.average_kcal = Math.round(logged.reduce((x, w) => x + w.kcal, 0) / logged.length);
    if (p.numbers) out.goal_kcal = v.person.goal.kcal;
    if (v.challenge) out.challenge = { name: v.challenge.he, met_days: v.challenge.score, of: past.length };
    out.insights = v.insights.filter(i => p.numbers || !i.numbers).map(i => i.he);
    return { ...out, note: p.numbers ? 'Warm and short. A day over the goal is never a failure.' : NOTE_NO_NUMBERS };
  },

  async set_food_goal({ pool, p }, a) {
    const key = p.user_id;
    if (a.confirm === true) {
      const asked = goalAsks.get(key);
      if (!asked || Date.now() - asked.at > CONFIRM_TTL_MS) fail('no_proposal', 'nothing is waiting for their yes; call without confirm first and show them the proposal');
      goalAsks.delete(key);
      const saved = await store.setGoal(pool, p, asked.goal);
      if (!p.numbers) await store.setNumbers(pool, p, true);
      return { saved, numbers: true, note: 'Saved. One short line; their page now counts against it.' };
    }
    let goal, how;
    if (a.kcal != null) {
      goal = { kcal: a.kcal, protein: a.protein ?? p.goal_protein, carbs: a.carbs ?? p.goal_carbs, fat: a.fat ?? p.goal_fat };
      how = 'the numbers they chose';
    } else {
      const need = ['height', 'weight', 'age', 'sex', 'activity', 'aim'].filter(k => a[k] == null);
      if (need.length) fail('missing', `to compute a goal ask them for: ${need.join(', ')} (or pass kcal/protein/carbs/fat they chose)`);
      const age = Number(a.age);
      if (!Number.isFinite(age) || age < 10 || age > 110) fail('bad_number', 'age is in years');
      if (age < 18) {
        await store.setNumbers(pool, p, false);
        return { goal: null, numbers: false, note: 'No calorie goal under 18; numbers are now hidden and logging goes on by what was on the plate. Say so kindly, in one line; if food worries them, suggest talking to a parent or another adult they trust.' };
      }
      const h = Number(a.height), w = Number(a.weight);
      if (!(h >= 120 && h <= 230)) fail('bad_number', 'height is in cm, 120-230');
      if (!(w >= 35 && w <= 250)) fail('bad_number', 'weight is in kg, 35-250');
      if (!N.ACTIVITY[a.activity] || N.AIM[a.aim] == null || !['male', 'female'].includes(a.sex)) fail('bad_value', 'activity: low|some|high, aim: lose|keep|gain, sex: male|female');
      const g = N.goalFrom({ height: h, weight: w, age, sex: a.sex, activity: a.activity, aim: a.aim });
      goal = { kcal: g.kcal, protein: g.protein, carbs: g.carbs, fat: g.fat };
      how = `Mifflin-St Jeor (resting ${g.bmr} kcal) x activity${a.aim === 'lose' ? ', minus 400: about half a kilo a week at most' : a.aim === 'gain' ? ', plus 250' : ''}`;
    }
    // Validate now, so a proposal they say yes to can always be saved.
    for (const [k, lo, hi] of [['kcal', 800, 6000], ['protein', 10, 400], ['carbs', 0, 800], ['fat', 10, 300]]) {
      if (!(goal[k] >= lo && goal[k] <= hi)) fail('bad_number', `${k} must be ${lo}-${hi}`);
    }
    goalAsks.set(key, { goal, at: Date.now() });
    return { proposal: goal, how, needs_confirmation: true, ask: 'Show them the four numbers and how they were computed, say it is an estimate they can change, and ask if to save. Call again with confirm:true only after they say yes, in a new message.' };
  },

  async food_numbers({ pool, p }, a) {
    if (typeof a.on !== 'boolean') fail('bad_value', 'on is true or false');
    await store.setNumbers(pool, p, a.on);
    return { numbers: a.on, note: a.on ? 'Numbers are back on the page and in your answers.' : `Hidden everywhere from now on; logging goes on. ${NOTE_NO_NUMBERS}` };
  },

  async my_portions({ pool, p }, a) {
    if (a.forget) return await store.forgetPortion(pool, p, a.forget);
    const list = await store.portionsOf(pool, p);
    return { portions: list.map(x => (p.numbers ? { name: x.name, grams: x.grams } : { name: x.name })), ...(list.length ? {} : { note: 'None yet: a corrected amount becomes one.' }) };
  },

  async usual_meals({ pool, p }, a) {
    const which = a.which || 'both';
    const out = {};
    if (which !== 'usual') {
      const y = D.addDays(store.todayOf(p), -1);
      out.yesterday = (await store.mealsBetween(pool, p, y, y)).filter(m => !m.rough).map(m => ({ meal_id: m.id, title: m.title, meal: m.slot }));
    }
    if (which !== 'yesterday') out.usual = (await store.usualOf(pool, p)).map(u => ({ meal_id: u.meal_id, title: u.title, times_in_4_weeks: u.times, meal: u.slot, logs_itself_at: u.auto_hour }));
    return { ...out, note: 'Offer them as short choices; relog_meal logs the one they pick.' };
  },

  async relog_meal({ pool, p }, a) {
    const { meal } = await store.relog(pool, p, a, { via: 'olma', source: 'repeat' });
    return { logged: mealBrief(meal, p.numbers), note: 'One line. If this time was different, edit_meal adjusts it.' };
  },

  async auto_log_meal({ pool, p }, a) {
    if (typeof a.on !== 'boolean') fail('bad_value', 'on is true or false');
    if (a.on && a.meal_id == null) fail('missing', 'meal_id of the meal to repeat (usual_meals lists them)');
    if (!a.on && !a.title) fail('missing', 'title of the meal to stop (usual_meals shows which log themselves)');
    const r = await store.setAuto(pool, p, a);
    return { ...r, note: r.auto ? `From tomorrow it logs itself at ${r.hour}:00 their time. Tell them they can say "not today" and you will delete it, or stop it any time.` : 'Stopped.' };
  },

  async food_challenge({ pool, p }, a) {
    const r = await store.setChallenge(pool, p, a.challenge);
    return { ...r, note: r.challenge ? 'Counted from their photos, no reporting needed. 5 of 7 is a win.' : 'Stopped.' };
  },

  async day_card({ pool, p, publicBase, makeCard }, a) {
    const v = await store.dayView(pool, p, a.date, { publicBase });
    if (!v.meals.length) fail('empty', 'nothing logged that day yet; nothing to draw');
    const { svg } = card.buildSvg(v);
    let r;
    try { r = makeCard ? await makeCard({ userId: p.user_id, svg }) : null; } catch (e) { r = { ok: false, error: e.message }; }
    if (r && r.ok && r.path) {
      return { media_path: r.path, caption: card.caption(r.invite_link || null),
        next_step: `Reply with the caption exactly as given, then "MEDIA: ${r.path}" on its own line. Nothing else.` };
    }
    console.error('[foodd tool] the card was not drawn:', r && r.error || 'no answer');
    return { drawn: false, url: v.url, caption: card.caption(null), note: 'The picture could not be drawn right now. Give them their page link instead, in one line.' };
  },
};

const REFUSED = {
  bad_number: 'a number is out of range', bad_text: 'a name or text is empty or too long', bad_item: 'an item needs name, name_en and grams',
  bad_values: 'the per-100 g values are impossible (kcal 0-950, each macro 0-100, and the macros cannot hold more energy than the kcal)',
  no_items: 'a meal needs at least one item (or rough:true)', too_many: 'too many items or meals',
  bad_slot: 'meal is breakfast, lunch, dinner or snack', bad_day: 'date is today, yesterday or YYYY-MM-DD',
  future_day: 'that day has not happened yet', too_old: 'only the last 7 days can be logged or changed',
  not_found: 'not found', no_meal: 'they have not logged a meal in the last two days', bad_challenge: 'unknown challenge', bad_value: 'a value is not one of the allowed ones',
};

async function runTool(name, args, env) {
  const fn = Object.hasOwn(TOOLS, name) ? TOOLS[name] : null;
  if (!fn) return err('unknown_tool', `no tool ${String(name).slice(0, 40)}`);
  try {
    const p = await store.ensurePerson(env.pool, env.user);
    return ok(await fn({ ...env, p }, args && typeof args === 'object' ? args : {}));
  } catch (e) {
    if (e instanceof ToolError) return err(e.code, e.message);
    if (e instanceof Refused) return err(e.code, e.message !== e.code ? e.message : (REFUSED[e.code] || e.code));
    console.error('[foodd tool]', name, e && e.stack || e);
    return err('internal', 'the food service failed part way; check their page before trying again');
  }
}

module.exports = { runTool, TOOLS, mealBrief, dayBrief };
