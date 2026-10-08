'use strict';
// The photos meals were read from, on disk beside foodd and never under its
// code: deploy.sh rsyncs /opt/olma-food with --delete, which would take them.
//
// A file is `<user_id>/<meal_id>.<ext>`, built here from integers, mode 0600.
// The page asks for one by meal id through its own token (server.js), so
// whoever holds the link sees their plates and nobody else's. The directory
// is read per call so a test can point it at a temp dir, and a test that did
// not is refused rather than allowed to write into the live one.
const fs = require('fs');
const path = require('path');

const DEFAULT_DIR = '/var/lib/olma-food/photos';
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MIME = Object.fromEntries(Object.entries(EXT).map(([m, e]) => [e, m]));
const NAME_RE = /^(\d+)\/(\d+)\.(jpg|png|webp)$/;
const MAX_BYTES = 6 * 1024 * 1024;

function dir() {
  const d = process.env.FOOD_PHOTO_DIR;
  if (d) return d;
  if (process.env.NODE_TEST_CONTEXT) throw new Error('FOOD_PHOTO_DIR is not set under test; refusing the live photo directory');
  return DEFAULT_DIR;
}

// Writes the photo and answers its name, or null when it is not a picture we
// keep (an unknown type, empty, too large).
function save({ userId, mealId, mime, base64 }) {
  const ext = EXT[mime];
  const u = Number(userId), m = Number(mealId);
  if (!ext || !Number.isSafeInteger(u) || !Number.isSafeInteger(m) || u <= 0 || m <= 0) return null;
  const buf = Buffer.from(String(base64 || ''), 'base64');
  if (!buf.length || buf.length > MAX_BYTES) return null;
  const name = `${u}/${m}.${ext}`;
  fs.mkdirSync(path.join(dir(), String(u)), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir(), name), buf, { mode: 0o600 });
  return name;
}

// The bytes and type of a stored photo, or null. Only a name of our own shape
// is ever joined to the directory.
function read(name) {
  const mt = NAME_RE.exec(String(name || ''));
  if (!mt) return null;
  try { return { body: fs.readFileSync(path.join(dir(), name)), mime: MIME[mt[3]] }; } catch { return null; }
}

function remove(name) {
  if (!NAME_RE.test(String(name || ''))) return false;
  try { fs.unlinkSync(path.join(dir(), name)); return true; } catch { return false; }
}

module.exports = { save, read, remove, dir, MAX_BYTES };
