'use strict';
// A picture the person just sent, handed to a pack's server (food/: a photo
// of their plate) through brokerd's `pack_media`. The pack runs as its own
// unit and cannot read the gateway's inbound directory; we can, so the guard
// lives here, beside contact-file.js's, and on the same terms: the path is a
// tool argument the model chose, so it is untrusted twice over.
//
//  - realpath on BOTH sides, so a symlink inside the directory cannot lead
//    out of it (contact-file.js, same reasoning);
//  - only a file that arrived recently: the directory is shared by every
//    person and has no owner per file, so an old name echoed into another
//    person's turn must not open their picture. Two hours covers "I sent it
//    earlier, log it now" and nothing like a history;
//  - only an image, by its first bytes, never by its name;
//  - not consumed, unlike a contact file: the person may correct the meal and
//    the model may look again inside the same window.
//
// The path the model is SHOWN is not in that shared directory. The gateway
// copies the picture into the person's own workspace before the turn
// (`<workspace>/media/inbound/openclaw-staged-<uuid>/input-<name>.jpg`), so
// the shared directory alone refused every real photo: the first one, on
// 2026-10-07, was refused twice and logged from the gateway's text
// description instead. The caller passes that person's own directory as
// `ownDir`; it belongs to one person, which is narrower than the shared one.
const fs = require('node:fs');
const path = require('node:path');
const { ok, err } = require('./results');

const inboundDir = () => process.env.OLMA_INBOUND_MEDIA_DIR || '/root/.openclaw/media/inbound';
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_AGE_MS = 2 * 3600 * 1000;

function mimeOf(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// A directory's real path, or null when it does not exist (a person who has
// never been sent a picture has no media/inbound of their own).
function realDir(d) {
  if (!d) return null;
  try { return fs.realpathSync(d); } catch { return null; }
}

function readInboundImage(rawPath, { now = Date.now(), ownDir = null } = {}) {
  if (!rawPath || typeof rawPath !== 'string') return err('invalid', 'no path given');
  let real;
  try { real = fs.realpathSync(rawPath); } catch { return err('not_found', 'no such file'); }
  const dirs = [realDir(inboundDir()), realDir(ownDir)].filter(Boolean);
  if (!dirs.some(dir => real.startsWith(dir + path.sep))) return err('forbidden', 'that path is not a picture the person sent');
  let stat;
  try { stat = fs.statSync(real); } catch { return err('not_found', 'no such file'); }
  if (!stat.isFile()) return err('invalid', 'not a file');
  if (stat.size > MAX_BYTES) return err('too_big', 'the picture is larger than 5 MB');
  if (now - stat.mtimeMs > MAX_AGE_MS) return err('too_old', 'that picture arrived more than two hours ago; ask them to send it again');
  const buf = fs.readFileSync(real);
  const mime = mimeOf(buf);
  if (!mime) return err('invalid', 'that file is not a picture (jpeg, png or webp)');
  return ok({ mime, base64: buf.toString('base64'), bytes: buf.length });
}

module.exports = { readInboundImage, mimeOf, MAX_BYTES, MAX_AGE_MS };
