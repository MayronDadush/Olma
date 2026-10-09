'use strict';
// The evening picture: everything a person ate today as one funny
// illustration, and on Saturday evening the whole week as one (the owner,
// 2026-10-09: "תמונה אחת בסוף יום ... כל המאכלים של אותו יום בצורה כיפית
// ומצחיק", and the week "תמונה אחת שתאגד את כולם").
//
// What is decided here is decided by CODE, and only two things are a model's:
//   - `scene` turns the titles they wrote ("שקשוקה של אמא") into plain English
//     food names, because an image model draws from English, and
//   - `picture` draws it.
// The theme, the genre of the week, whether the water bottle appears, every
// word on the picture and under it: drawn here, from their own log, so the
// same week is the same joke and nothing on it is invented.
//
// Paid with foodd's own key, under a monthly cap read from model_calls (the
// owner: "המפתח של foodd + תקרה חודשית"). Over the cap, with no key, or when a
// model fails, the person still gets a picture: the card drawn by code
// (card.js), the same one the page already offers.
//
// Two image models side by side, by person (the owner: "גם ב-recraft-v4.1-flash
// וגם ב-seedream-5-0-flash אחרי תקופה מסוימת נראה איך כל אחד עבד"). Each
// person keeps one model, so whoever compares sees one style per person, and
// `pictures.model` is what the comparison is read from.
const { spawn } = require('child_process');
const crypto = require('crypto');
const D = require('./days');
const store = require('./store');
const card = require('./card');
const llm = require('./llm');

const MODELS = ['recraft/recraft-v4.1-flash', 'bytedance-seed/seedream-5-0-flash'];
const MONTHLY_CAP_USD = () => Number(process.env.FOOD_PICTURE_MONTHLY_USD || 20);
const IMAGE_TIMEOUT_MS = 90_000;
const MIN_DAY_MEALS = 2;   // the owner: only a day with two meals or more
const MIN_WEEK_MEALS = 3;
const MAX_FOODS = 6;

const W = 1080, IMG = 1080, BAND = 290, H = IMG + BAND;
const { esc, plain, clip, mark, FONT, RLM, CYPRESS, SAND, MUSTARD } = card;

// Stable for a person and a day, so a retry draws the same theme.
const hash = (...parts) => crypto.createHash('sha256').update(parts.join('|')).digest().readUInt32BE(0);
const modelFor = userId => (process.env.FOOD_PICTURE_MODEL || MODELS[Number(userId) % MODELS.length]);

const STYLE = 'Bright, playful 3D animated-film style render, soft studio lighting, cute food characters with small friendly faces and tiny arms. '
  + 'Square composition. No text, no letters, no words, no numbers, no logos, no brand names, no human beings.';

const DAY_THEMES = {
  parade: { scene: f => `A cheerful parade of cute food characters marching across a sunny kitchen counter, confetti in the air: ${f}.`,
    he: wd => `המצעד של יום ${wd}`, en: wd => `${wd}'s parade` },
  band: { scene: f => `Cute food characters performing as a rock band on a small stage with colourful lights, one at the microphone and one on the drums: ${f}.`,
    he: wd => `ההרכב של יום ${wd}`, en: wd => `${wd}'s lineup` },
  classPhoto: { scene: f => `An end-of-the-day class photo: cute food characters lined up on little school bleachers, smiling at the camera: ${f}.`,
    he: wd => `תמונת המחזור של יום ${wd}`, en: wd => `The class of ${wd}` },
  carpet: { scene: f => `Cute food characters arriving on a glamorous red carpet, camera flashes everywhere: ${f}.`,
    he: wd => `השטיח האדום של יום ${wd}`, en: wd => `${wd} on the red carpet` },
  heroes: { scene: f => `Cute food characters posing as a superhero team on a rooftop at sunset, capes blowing in the wind: ${f}.`,
    he: wd => `נבחרת יום ${wd}`, en: wd => `Team ${wd}` },
};
const EN_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const WATER = {
  proud: { scene: ' Beside them, a proud little water bottle character wears a gold medal.',
    he: 'ובקבוק המים? עמד ביעד.', en: 'And the water bottle hit its goal.' },
  thirsty: { scene: ' In the corner, a tiny, almost empty water bottle character looks on, thirsty and dramatic.',
    he: 'והמים? נשארו בבקבוק.', en: 'And the water stayed in the bottle.' },
};

// The bottle appears on some days, not every day (the owner: "לפעמים"), and
// only at the two ends: the goal met, or under half of it.
function waterMood(p, day, ml) {
  const goal = Number(p.water_goal_ml) || 2000;
  if (!ml) return null;
  const mood = ml >= goal ? 'proud' : ml < goal / 2 ? 'thirsty' : null;
  return mood && hash('water', p.user_id, day) % 2 === 0 ? mood : null;
}

// The same dish under the same name, whatever the case or spacing.
const keyOf = t => plain(t).toLowerCase();
function counted(meals) {
  const by = new Map();
  for (const m of meals) {
    const k = keyOf(m.title);
    if (!k) continue;
    const e = by.get(k) || { title: plain(m.title), n: 0, last: '' };
    e.n += 1;
    if (`${m.day} ${m.time}` >= e.last) { e.last = `${m.day} ${m.time}`; e.title = plain(m.title); }
    by.set(k, e);
  }
  // Most often first; a tie goes to the one eaten last.
  return [...by.values()].sort((a, b) => b.n - a.n || (a.last < b.last ? 1 : -1));
}

// The week's genre, from the log alone:
//   a dish eaten three times or more is the star of its own sequel,
//   else a dish that was a regular LAST week and never came this week is
//   evicted from the house,
//   else the week's favourite takes the award.
function weekGenre(meals, lastWeek) {
  const now = counted(meals);
  if (now[0] && now[0].n >= 3) return { genre: 'sequel', star: now[0].title, n: now[0].n, cast: now.slice(1, MAX_FOODS).map(e => e.title) };
  const here = new Set(now.map(e => keyOf(e.title)));
  const gone = counted(lastWeek).find(e => e.n >= 2 && !here.has(keyOf(e.title)));
  if (gone) return { genre: 'eviction', out: gone.title, cast: now.slice(0, MAX_FOODS - 1).map(e => e.title) };
  return { genre: 'awards', star: now[0].title, cast: now.slice(1, MAX_FOODS).map(e => e.title) };
}

// Their titles in plain English food names, one call, same order. Anything
// that is not a short run of letters is dropped, so a title can never steer
// the image prompt into something that is not food.
async function englishNames({ pool, userId, titles, chat = llm.chat }) {
  const r = await chat({ pool, userId, purpose: 'scene', maxTokens: 400,
    content: 'Each line below is the name of a dish someone ate, in their own words (usually Hebrew). '
      + 'Give each as a short plain English food name of one to four words that an illustrator could draw (for example "shakshuka", "chicken schnitzel", "green salad"). '
      + 'Answer only JSON: {"en": ["...", ...]}, the same number of items in the same order.\n\n'
      + titles.map((t, i) => `${i + 1}. ${t}`).join('\n') });
  const en = Array.isArray(r.json && r.json.en) ? r.json.en : [];
  return titles.map((t, i) => {
    const s = String(en[i] || '').toLowerCase().replace(/[^a-z' -]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
    return s || null;
  });
}

const listOf = names => names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
const a = n => (/^[aeiou]/.test(n) ? `an ${n}` : `a ${n}`);

// The scene for the image model: only the code's templates and the names.
function sceneFor(plan, en) {
  if (plan.kind === 'day') {
    return DAY_THEMES[plan.theme].scene(listOf(en.foods)) + (plan.water ? WATER[plan.water].scene : '') + ' ' + STYLE;
  }
  const cast = en.cast.length ? listOf(en.cast) : 'a few smaller dishes';
  if (plan.genre === 'sequel') {
    return `A Hollywood blockbuster movie poster scene: a heroic ${en.star} character in an epic action pose, bursts of spices exploding behind it, `
      + `with ${cast} as the supporting cast. Cinematic lighting, low angle, epic and ridiculous. ` + STYLE;
  }
  if (plan.genre === 'eviction') {
    return `A reality TV show eviction scene in a glossy studio: cute food characters sit on a big couch (${cast}) `
      + `while a sad little ${en.out} character walks away carrying a tiny suitcase. Dramatic stage lights. ` + STYLE;
  }
  return `A glamorous award ceremony: ${a(en.star)} character holds a golden trophy on stage under a spotlight while ${cast} applaud from the audience. ` + STYLE;
}

// Every word on the picture and under it, in both languages. The person's own
// titles in Hebrew; in English, the names the scene call gave.
function wordsFor(plan, en) {
  const wd = D.weekday(plan.day);
  if (plan.kind === 'day') {
    const t = DAY_THEMES[plan.theme];
    const water = plan.water ? WATER[plan.water] : null;
    return {
      he: { title: t.he(D.HE_DAYS[wd]), sub: plan.foods.join(' · '), water: water ? water.he : null,
        caption: 'ככה נראה היום שלך בצלחת 🍽️' },
      en: { title: t.en(EN_DAYS[wd]), sub: (en ? en.foods : plan.foods).join(' · '), water: water ? water.en : null,
        caption: 'Your day on a plate 🍽️' },
    };
  }
  const n = plan.meals, days = plan.days;
  // With no English names (the drawn card), the English words carry their own.
  const star = plan.star, enStar = en ? en.star : plan.star;
  const he = plan.genre === 'sequel' ? { title: `${clip(star, 22)} ${plan.n}`, sub: `${plan.n} פעמים ${star} השבוע. ההמשך כבר בדרך.` }
    : plan.genre === 'eviction' ? { title: `יצא מהבית: ${clip(plan.out, 20)}`, sub: `${n} ארוחות השבוע, ואף אחת מהן לא הייתה ${plan.out}.` }
      : { title: 'פרסי השבוע', sub: `הזוכה: ${star} · ${n} ארוחות ב-${days} ימים` };
  const enW = plan.genre === 'sequel' ? { title: `${clip(cap(enStar), 22)} ${plan.n}`, sub: `${cap(enStar)} was on the plate ${plan.n} times this week. The sequel is coming.` }
    : plan.genre === 'eviction' ? { title: `Evicted: ${clip(cap(en ? en.out : plan.out), 20)}`, sub: `${n} meals this week, and not one of them was ${en ? en.out : plan.out}.` }
      : { title: "The week's awards", sub: `Winner: ${cap(enStar)} · ${n} meals over ${days} days` };
  return {
    he: { ...he, water: null, caption: 'השבוע שלך בצלחת. שבוע טוב! 🎬' },
    en: { ...enW, water: null, caption: 'Your week on a plate. Have a good week! 🎬' },
  };
}
const cap = s => String(s || '').replace(/^./, c => c.toUpperCase());

// What to draw for a person, from their log; null when there is not enough
// of it (the owner: a day with fewer than two meals gets no picture).
async function planFor(pool, p, kind, day) {
  if (kind === 'day') {
    const v = await store.dayView(pool, p, day);
    if (v.meals.length < MIN_DAY_MEALS) return null;
    const foods = counted(v.meals).slice(0, MAX_FOODS).map(e => e.title);
    if (!foods.length) return null;
    const themes = Object.keys(DAY_THEMES);
    return { kind, day: v.day, view: v, foods, meals: v.meals.length,
      theme: themes[hash('theme', p.user_id, v.day) % themes.length], water: waterMood(p, v.day, v.water_ml) };
  }
  const w = await store.weekOf(pool, p, day);
  if (w.meals.length < MIN_WEEK_MEALS || !counted(w.meals).length) return null;
  const last = await store.mealsBetween(pool, p, D.addDays(w.from, -7), D.addDays(w.from, -1));
  const g = weekGenre(w.meals, last);
  return { kind, day: w.to, from: w.from, week: w, ...g, theme: g.genre,
    meals: w.meals.length, days: new Set(w.meals.map(m => m.day)).size };
}

async function monthSpent(pool) {
  const { rows: [r] } = await pool.query(
    `SELECT COALESCE(sum(cost_usd), 0)::float AS usd FROM model_calls
      WHERE purpose IN ('scene', 'picture') AND at >= date_trunc('month', now())`);
  return r.usd;
}

// One image from OpenRouter, logged like every other call (llm.chat's shape).
async function drawImage({ pool, userId, prompt, model, fetchImpl = globalThis.fetch, key = process.env.FOOD_OPENROUTER_KEY }) {
  if (!key) throw new llm.ModelUnavailable('no model key configured (FOOD_OPENROUTER_KEY)');
  const t0 = Date.now();
  let body, error = null, bytes = null;
  try {
    const res = await fetchImpl('https://openrouter.ai/api/v1/images', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'Olma food' },
      body: JSON.stringify({ model, prompt, n: 1 }),
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
    });
    body = await res.json().catch(() => null);
    const d = body && body.data && body.data[0];
    if (!res.ok || !d) error = `http ${res.status}: ${JSON.stringify(body && body.error || body).slice(0, 160)}`;
    else if (d.b64_json) bytes = Buffer.from(d.b64_json, 'base64');
    else if (d.url) bytes = Buffer.from(await (await fetchImpl(d.url, { signal: AbortSignal.timeout(30_000) })).arrayBuffer());
    if (!error && (!bytes || bytes.length < 1000)) error = 'empty image';
  } catch (e) {
    error = e.name === 'TimeoutError' ? 'timeout' : String(e.message || e).slice(0, 160);
  }
  const cost = body && body.usage && body.usage.cost != null ? body.usage.cost : null;
  await pool.query(
    'INSERT INTO model_calls (user_id, purpose, model, ok, ms, cost_usd, error) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [userId, 'picture', model, !error, Date.now() - t0, cost, error]).catch(e => console.error('[foodd picture] not recorded:', e.message));
  if (error) throw new llm.ModelUnavailable(error);
  return { bytes, cost };
}

// Whatever the model answered (Recraft answers WebP, which the renderer
// draws as nothing; Seedream answers 2048 px) as a 1080 px JPEG, by the
// ffmpeg already on the box for the voice bridge.
function toJpeg(buf, { bin = process.env.FOOD_FFMPEG || 'ffmpeg', timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const ff = spawn(bin, ['-loglevel', 'error', '-i', 'pipe:0', '-vf', `scale=${IMG}:-2`, '-frames:v', '1', '-q:v', '4', '-f', 'mjpeg', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [], errs = [];
    const timer = setTimeout(() => { ff.kill('SIGKILL'); reject(new Error('ffmpeg timeout')); }, timeoutMs);
    ff.stdout.on('data', c => out.push(c));
    ff.stderr.on('data', c => errs.push(c));
    ff.on('error', e => { clearTimeout(timer); reject(e); });
    ff.on('close', code => {
      clearTimeout(timer);
      const jpg = Buffer.concat(out);
      if (code !== 0 || jpg.length < 1000) return reject(new Error(`ffmpeg ${code}: ${Buffer.concat(errs).toString().slice(0, 160)}`));
      resolve(jpg);
    });
    ff.stdin.on('error', () => { /* ffmpeg closed early; close reports it */ });
    ff.stdin.end(buf);
  });
}

// At most two lines, broken between words. Never an ellipsis: resvg puts a
// trailing one on the wrong side of a right-to-left line, and a cut-off
// sentence reads as a mistake. What does not fit on two lines is left off at
// a word.
const SUB_LINE = 44;
function wrap(s, max) {
  const lines = [''];
  for (const w of s.split(' ')) {
    const cur = lines[lines.length - 1];
    if (!cur) lines[lines.length - 1] = w.slice(0, max);
    else if (cur.length + 1 + w.length <= max) lines[lines.length - 1] = `${cur} ${w}`;
    else if (lines.length < 2) lines.push(w.slice(0, max));
    else break;
  }
  return lines;
}

// The picture and a band under it in Olma's colours, with the words drawn by
// code in Olma's own font (an image model cannot spell Hebrew). Same renderer
// rules as card.js: an RLM opens every <text>, and no emoji.
function composeSvg(jpg, words, locale) {
  const rtl = locale !== 'en';
  const x = rtl ? W - 56 : 56, anchor = rtl ? 'end' : 'start';
  // A direction mark at BOTH ends: the opening one sets the line's direction
  // (card.js), and the closing one keeps a final full stop beside the last
  // word, where resvg otherwise moves it to the far end of a Hebrew line.
  const dm = rtl ? RLM : '\u200E';
  const t = (y, size, weight, fill, s) =>
    `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${dm}${esc(s)}${dm}</text>`;
  const [sub1, sub2] = wrap(plain(words.sub), SUB_LINE);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
    + `<defs><clipPath id="ph"><rect width="${W}" height="${IMG}"/></clipPath></defs>`
    + `<rect width="${W}" height="${H}" fill="${CYPRESS}"/>`
    + `<image width="${W}" height="${IMG}" preserveAspectRatio="xMidYMid slice" clip-path="url(#ph)" href="data:image/jpeg;base64,${jpg.toString('base64')}"/>`
    + `<rect y="${IMG}" width="${W}" height="8" fill="${MUSTARD}"/>`
    + t(IMG + 92, 56, 700, SAND, clip(plain(words.title), 30))
    + t(IMG + 150, 32, 500, '#BFD3CF', sub1)
    + (sub2 ? t(IMG + 194, 32, 500, '#BFD3CF', sub2) : '')
    + (words.water ? t(IMG + (sub2 ? 246 : 204), 30, 500, MUSTARD, words.water) : '')
    + mark(rtl ? 56 : W - 56 - 64, IMG + BAND - 64 - 36, 64)
    + '</svg>';
}

// The code-drawn card, for when no picture can be paid for or drawn.
async function drawnCard(pool, p, plan) {
  if (plan.kind === 'day') return card.buildSvg(plan.view).svg;
  const got = new Map();
  for (const m of plan.week.meals.filter(x => x.photo && !x.rough).reverse().slice(0, card.TILES)) got.set(m.id, await store.photoOf(pool, p, m.id));
  return card.buildWeekSvg(plan.week, m => got.get(m.id) || null).svg;
}

// The whole of it, for /api/picture. Claims the (person, kind, day) first, so
// the same picture is never paid for twice; answers
//   { ok: true, svg, texts: { he, en }, model, theme }   or
//   { ok: false, reason: 'too_few' | 'already' }.
async function make(pool, p, { kind, day }, deps = {}) {
  const plan = await planFor(pool, p, kind, day);
  if (!plan) return { ok: false, reason: 'too_few' };
  const { rows: claimed } = await pool.query(
    `INSERT INTO pictures (user_id, kind, day, theme) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, kind, day) DO NOTHING RETURNING id`, [p.user_id, kind, plan.day, plan.theme]);
  if (!claimed.length) return { ok: false, reason: 'already' };
  const id = claimed[0].id;

  let svg = null, model = null, cost = null, error = null, en = null;
  try {
    if (!(deps.key ?? process.env.FOOD_OPENROUTER_KEY)) throw new Error('no key');
    if (await monthSpent(pool) >= MONTHLY_CAP_USD()) throw new Error('monthly cap reached');
    // The week's lead (its star, or who was evicted) first, then the cast.
    const lead = plan.kind === 'week' ? (plan.genre === 'eviction' ? plan.out : plan.star) : null;
    const names = await englishNames({ pool, userId: p.user_id, titles: lead ? [lead, ...plan.cast] : plan.foods, chat: deps.chat });
    if (plan.kind === 'day') {
      en = { foods: names.filter(Boolean) };
      if (!en.foods.length) throw new Error('no food names');
    } else {
      if (!names[0]) throw new Error('no food names');
      en = { star: names[0], out: names[0], cast: names.slice(1).filter(Boolean) };
    }
    model = modelFor(p.user_id);
    const img = await drawImage({ pool, userId: p.user_id, prompt: sceneFor(plan, en), model, fetchImpl: deps.fetchImpl, key: deps.key });
    cost = img.cost;
    const jpg = await (deps.toJpeg || toJpeg)(img.bytes);
    const words = wordsFor(plan, en)[p.locale === 'en' ? 'en' : 'he'];
    svg = composeSvg(jpg, words, p.locale);
  } catch (e) {
    error = String(e.message || e).slice(0, 200);
    model = null;
    svg = await drawnCard(pool, p, plan);
  }
  await pool.query(
    `UPDATE pictures SET status = $2, model = $3, cost_usd = $4, error = $5 WHERE id = $1`,
    [id, model ? 'generated' : 'drawn', model, cost, error]);
  const words = wordsFor(plan, en);
  return { ok: true, svg, model, theme: plan.theme, drawn: !model,
    texts: { he: words.he.caption, en: words.en.caption } };
}

module.exports = {
  make, planFor, weekGenre, counted, sceneFor, wordsFor, composeSvg, wrap, toJpeg, monthSpent, modelFor, waterMood,
  MODELS, DAY_THEMES, MIN_DAY_MEALS, MIN_WEEK_MEALS,
};
