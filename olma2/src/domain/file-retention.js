'use strict';
// The files on the box that hold what people said, aged out on the numbers the
// privacy page states (public-pages RETENTION; compliance review 2026-09-28).
// Rows had a retention sweep from the start; files never did, and 1,363
// session archives, every call transcript and every voice note were still on
// disk when this was written.
//
// Only files something has already FINISHED with, which is what makes deleting
// them safe to do from outside their owner:
//   - `*.jsonl.deleted.*` / `*.jsonl.reset.*` under agents/*/sessions: the
//     gateway's own archives of a session it rolled or removed. It never
//     reads them again. The LIVE transcript is in each agent's sqlite
//     (`transcript_events`) and is deliberately NOT touched here: that store is
//     open in the gateway, and a second writer to someone else's store is the
//     failure this repo keeps paying for (CLAUDE.md, "Recurring failure
//     shapes").
//   - media/inbound/*: voice notes, photos and documents people sent. The
//     transcription and the reply happened seconds after arrival.
//   - the voice bridge's transcripts/processed/*: a call jobs/voice-calls.js
//     has already turned into facts and a recap. An unprocessed transcript is
//     still due and is never touched.
//
// Age is the file's mtime, never a date parsed out of its name: the gateway
// owns the name's format and has changed it before.
const fs = require('node:fs');
const path = require('node:path');
const guard = require('../intake/production-guard');

const DAY_MS = 24 * 60 * 60 * 1000;
const VOICE_BRIDGE_ROOT = '/opt/olma2-voice-bridge';
// The days the privacy page states. Each is a flag so it can move without a
// deploy, and a move is a change to a promise: change the page with it.
const DEFAULT_DAYS = Object.freeze({ archives: 90, media: 90, callTranscripts: 30 });
const ARCHIVE = /\.jsonl\.(deleted|reset)\./;

// Deletes regular files in `dir` (not below it) older than `days` whose name
// passes `match`. A missing directory is an answer ("nothing there"), not an
// error; any other failure is counted, never thrown, because one unreadable
// file must not stop the rows sweep it rides with.
function purgeDir(dir, { days, match = () => true, now = Date.now() }) {
  const out = { purged: 0, failed: 0 };
  if (!(days > 0)) return out; // 0 or unset turns a class off, never "delete everything"
  let names;
  try { names = fs.readdirSync(dir); } catch (e) {
    if (e.code !== 'ENOENT') out.failed += 1;
    return out;
  }
  const cutoff = now - days * DAY_MS;
  for (const name of names) {
    if (!match(name)) continue;
    const p = path.join(dir, name);
    try {
      const st = fs.lstatSync(p);
      if (!st.isFile() || st.mtimeMs >= cutoff) continue;
      fs.unlinkSync(p);
      out.purged += 1;
    } catch { out.failed += 1; }
  }
  return out;
}

function add(a, b) { return { purged: a.purged + b.purged, failed: a.failed + b.failed }; }

// { home, voiceDir, days: { archives, media, callTranscripts }, now }
function purgeFiles({ home, voiceDir, days, now = Date.now() }) {
  // The on-box suite runs where these are production; tests/helpers.js points
  // both at temp directories, and this is the second lock.
  guard.assertNotProduction('file retention (gateway home)', home);
  if (guard.inTestProcess() && voiceDir && voiceDir.startsWith(VOICE_BRIDGE_ROOT)) {
    throw new Error(`refusing to age the live voice bridge's transcripts from a test process: ${voiceDir}`);
  }
  let archives = { purged: 0, failed: 0 };
  let agents = [];
  try { agents = fs.readdirSync(path.join(home, 'agents')); } catch { /* no agents dir: nothing to age */ }
  for (const a of agents) {
    archives = add(archives, purgeDir(path.join(home, 'agents', a, 'sessions'),
      { days: days.archives, match: (n) => ARCHIVE.test(n), now }));
  }
  const media = purgeDir(path.join(home, 'media', 'inbound'), { days: days.media, now });
  const calls = voiceDir
    ? purgeDir(path.join(voiceDir, 'processed'), { days: days.callTranscripts, match: (n) => n.endsWith('.json'), now })
    : { purged: 0, failed: 0 };
  return {
    archivesPurged: archives.purged, mediaPurged: media.purged, callTranscriptsPurged: calls.purged,
    fileFailures: archives.failed + media.failed + calls.failed,
  };
}

module.exports = { purgeFiles, purgeDir, ARCHIVE, DEFAULT_DAYS };
