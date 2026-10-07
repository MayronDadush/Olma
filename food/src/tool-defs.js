'use strict';
// Olma's food tools as the model sees them. No requires on purpose: the
// gateway spawns bin/food-mcp.js on every turn of every agent that is shown
// them, and tools/list must not pay for pg or the store.
//
// Shown to NOBODY until a person has the pack: every gateway agent carries
// `food__*` in its deny list (olma2/src/intake/agent-tool-policy.js), and
// foodd refuses a call from anybody without 'food' in their packs
// (src/server.js). The same limits as Olma's own schemas: `olma_identity`
// first and required, every description under 700 characters.
//
// The page and these tools are two doors to the same store: everything a
// person can do on their food page, they can ask Olma for here.
const IDENTITY_PARAM = 'olma_identity';

const S = (type, description, extra = {}) => ({ type, description, ...extra });
const SLOT = S('string', 'breakfast, lunch, dinner or snack. Omit to let the server pick from the hour.', { enum: ['breakfast', 'lunch', 'dinner', 'snack'] });
const DATE = S('string', '"today" (default), "yesterday", or YYYY-MM-DD up to 7 days back, for a meal eaten earlier.');
const MEAL_ID = S('integer', 'The meal to act on, from an earlier result. Omit for the last meal they logged.');
const ITEM = {
  type: 'object',
  properties: {
    name: S('string', 'In their language, short. A count after " · " (e.g. "ביצים · 2").'),
    name_en: S('string', 'English, as a food table names it, with how it was made ("chicken breast, roasted"). Values come from the table by it.'),
    grams: S('number', 'Grams (ml for drinks) actually eaten — THEIR part of a shared dish.'),
    said: S('boolean', 'true when they stated this amount themselves.'),
    group: S('string', 'What it mostly is.', { enum: ['protein', 'veg', 'fruit', 'grain', 'fat', 'sweet', 'drink'] }),
    per100: { type: 'object', description: 'ONLY off a label they sent (confidence label); else omit.', properties: { kcal: S('number', ''), protein: S('number', ''), carbs: S('number', ''), fat: S('number', '') }, required: ['kcal', 'protein', 'carbs', 'fat'] },
    confidence: S('string', 'high, mid or low for an estimate; label when read off a nutrition label.', { enum: ['high', 'mid', 'low', 'label'] }),
  },
  required: ['name', 'name_en', 'grams'],
};

const def = (name, description, props, required = []) => ({
  name,
  description,
  inputSchema: {
    type: 'object',
    properties: { [IDENTITY_PARAM]: S('string', 'from AGENTS.md'), ...props },
    required: [IDENTITY_PARAM, ...required],
  },
});

const TOOL_DEFS = [
  def('see_meal_photo',
    'They sent a photo of food: call THIS TURN with the exact path the system showed you for it, never invented or reused. The server reads the plate, values it from its table and logs it, then returns the meal, what is left today and at most one question to ask (oil it cannot see, an unclear amount); their answer is an edit_meal. A photo of a nutrition label is not this: read it and use log_meal with per100 and confidence label.',
    {
      path: S('string', 'The exact file path shown to you this turn.'),
      note: S('string', 'What they wrote with the photo, if anything ("only half of it was mine").'),
      meal: SLOT, date: DATE,
    }, ['path']),
  def('log_meal',
    'Record what they ate from words, a voice note or a nutrition label (a photo of a plate is see_meal_photo). Break it into items, each with name_en and an amount; the server takes the values from its table. If ONE amount is genuinely unclear, ask one short question first; otherwise log and let them correct. A shared dish: only their part. Their learned portions are applied unless said:true. Returns the meal, what is left today, and any portion it applied.',
    {
      title: S('string', 'A short name for the meal, in their language.'),
      items: { type: 'array', items: ITEM, description: 'Up to 12.' },
      meal: SLOT, date: DATE,
      source: S('string', 'Where it came from.', { enum: ['photo', 'voice', 'text', 'label'] }),
      shared_part: S('string', 'Their part of a shared dish, in their words ("2 of 8 slices").'),
      rough: S('boolean', 'true only when they asked to log a meal roughly, with no details (e.g. Friday dinner): it counts as a meal and nothing else. items may be empty.'),
    }, ['title', 'items']),
  def('edit_meal',
    'Change a logged meal: an item\'s amount ("it was more tahini"), remove an item, add items, rename, move it to another meal or day. A new amount for an item becomes their portion for it from now on, unless learn:false or it came off a label. A meal left with no items is deleted.',
    {
      meal_id: MEAL_ID,
      changes: { type: 'array', description: 'One per item.', items: { type: 'object', properties: { item: S('string', 'The item\'s name as logged.'), grams: S('number', 'Its new amount.'), remove: S('boolean', 'true to take it out.'), rename: S('string', 'A new name.'), learn: S('boolean', 'false when this amount was a one-off.') }, required: ['item'] } },
      add: { type: 'array', items: ITEM, description: 'Items to add.' },
      meal: SLOT, date: DATE, title: S('string', 'A new name for the meal.'),
    }),
  def('delete_meal',
    'Take a meal off their log ("delete the last one", "I didn\'t eat that after all"). Without meal_id, the last one they logged.',
    { meal_id: MEAL_ID }),
  def('log_water',
    'Record water: add cups ("I drank a glass" = 1) or set the day\'s count.',
    { add: S('integer', 'Cups to add; negative to take back. Default 1.'), cups: S('integer', 'The day\'s count, instead of add.'), date: DATE }),
  def('food_today',
    'Where their day stands: meals, totals against their goal, water, their challenge, a small insight, and their food page link. For "how am I doing", "what\'s left", "what did I eat today". In no-numbers mode it carries no numbers to say, by design.',
    { date: DATE }),
  def('food_week',
    'Their week, Sunday to Saturday: each day\'s total and meal count, averages, days logged, how their challenge went, and insights. For a weekly look back.',
    { date: S('string', 'Any day in the week to show; default this week.') }),
  def('set_food_goal',
    'Set their daily goal. From what they told you (height cm, weight kg, age, sex for the formula, activity, aim) the server computes it; or pass kcal/protein/carbs/fat they chose. Takes two calls: the first returns the proposal for them to approve; confirm:true saves it, only after they said yes in a new message. Under 18 no calorie goal is set.',
    {
      height: S('number', 'cm'), weight: S('number', 'kg'), age: S('integer', 'years'),
      sex: S('string', 'For the formula only.', { enum: ['male', 'female'] }),
      activity: S('string', 'low: barely moves; some: 2-3 workouts a week; high: 4+.', { enum: ['low', 'some', 'high'] }),
      aim: S('string', '', { enum: ['lose', 'keep', 'gain'] }),
      kcal: S('integer', ''), protein: S('integer', 'g'), carbs: S('integer', 'g'), fat: S('integer', 'g'),
      confirm: S('boolean', 'true only on the second call, after they approved.'),
    }),
  def('food_numbers',
    'Turn numbers on or off. Off: no calories or grams anywhere, on the page or from you — only what was on the plate (protein, vegetables, grains). Logging goes on underneath, so turning them back on loses nothing.',
    { on: S('boolean', 'true to show numbers, false to hide them.') }, ['on']),
  def('my_portions',
    'The amounts Olma learned from their corrections ("your tahini is 40 g"), or forget one.',
    { forget: S('string', 'The item name to forget.') }),
  def('usual_meals',
    'Meals they can log again with one word: yesterday\'s ("like yesterday", "same as yesterday\'s lunch") and the ones they eat most. Each has a meal_id for relog_meal, and whether it logs itself every day.',
    { which: S('string', '', { enum: ['yesterday', 'usual', 'both'] }) }),
  def('relog_meal',
    'Log a meal again, as it was: from usual_meals or an earlier result. Returns the new meal, which edit_meal can adjust.',
    { meal_id: S('integer', 'The meal to copy.'), meal: SLOT, date: DATE }, ['meal_id']),
  def('auto_log_meal',
    'Make a meal they eat every day log itself at an hour (the morning coffee), or stop it. Offer it once when they log the same thing most mornings; only on their yes.',
    { meal_id: S('integer', 'The meal to repeat, for on:true.'), title: S('string', 'Its title, for on:false.'), on: S('boolean', ''), hour: S('integer', 'Local hour, 0-23. Default 8.') }, ['on']),
  def('food_challenge',
    'Pick their small weekly challenge, or stop it. Never a punishment: 5 of 7 is a win.',
    { challenge: S('string', 'veg_dinner: vegetables at every dinner; protein_breakfast: protein at breakfast; water6: 6 cups a day; none: stop.', { enum: ['veg_dinner', 'protein_breakfast', 'water6', 'none'] }) }, ['challenge']),
  def('day_card',
    'Their day as one picture to share: the meals, the balance and water, no calories. Returns an image path and its caption, which carries their invite link.',
    { date: DATE }),
];

module.exports = { TOOL_DEFS, IDENTITY_PARAM };
