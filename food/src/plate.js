'use strict';
// A photo of a plate, read and logged — the one path for both doors: the
// photo Olma is sent in WhatsApp (tools.see_meal_photo) and the one taken
// with the camera button on the page (chat.photo). Logged at once, because
// correcting is easier than confirming, and the photo kept so the page can
// show the plate (migration 003).
const store = require('./store');
const foods = require('./foods');
const vision = require('./vision');
const photos = require('./photos');
const { slotFromNote } = require('./slot-words');

// Each photo is a paid model call. Nobody eats sixty plates a day; a loop does.
const PHOTOS_PER_DAY = 60;

async function photosToday(pool, p) {
  const { rows: [{ n }] } = await pool.query(`SELECT count(*)::int AS n FROM model_calls WHERE user_id = $1 AND purpose = 'see' AND at > now() - interval '1 day'`, [p.user_id]);
  return n;
}

// Answers { seen } with no meal when there is no food in the picture, or
// { seen, meal, applied, items }. A model that cannot be reached throws
// llm.ModelUnavailable for the caller to word.
async function logPhoto(pool, p, { mime, base64, note, meal: slot, date, via, fetchImpl }) {
  const seen = await vision.see({ pool, userId: p.user_id, image: { mime, base64 }, note, fetchImpl });
  if (!seen.food) return { seen };
  const items = await foods.resolve(pool, seen.items, { userId: p.user_id, fetchImpl });
  const { meal, applied } = await store.logMeal(pool, p, { title: seen.title || undefined, items, meal: slot || slotFromNote(note) || undefined, date, source: 'photo' }, { via });
  // A photo that could not be written costs only the picture, never the meal.
  try {
    const name = photos.save({ userId: p.user_id, mealId: meal.id, mime, base64 });
    if (name) await store.setPhoto(pool, p, meal.id, name);
  } catch (e) { console.error('[foodd photo] not kept:', e.message); }
  return { seen, meal, applied, items };
}

module.exports = { logPhoto, photosToday, PHOTOS_PER_DAY };
