'use strict';
require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fr = require('../src/domain/file-retention');

const DAY = 24 * 60 * 60 * 1000;
// One clock for every assertion (rules/testing.md): files are stamped relative
// to it and the purge is asked at it, so the hour the suite runs cannot matter.
const NOW = Date.UTC(2026, 8, 28, 12, 0, 0);

function put(file, ageDays) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x');
  const t = (NOW - ageDays * DAY) / 1000;
  fs.utimesSync(file, t, t);
  return file;
}

function tree() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'olma2-fr-home-'));
  const voice = fs.mkdtempSync(path.join(os.tmpdir(), 'olma2-fr-voice-'));
  const s = (agent, name) => path.join(home, 'agents', agent, 'sessions', name);
  const f = {
    oldDeleted: put(s('u-3', 'a.jsonl.deleted.2026-06-01T03-00-00.000Z.abc.zst'), 120),
    oldReset: put(s('g-2', 'b.jsonl.reset.2026-06-01T03-00-00.000Z'), 100),
    freshDeleted: put(s('u-3', 'c.jsonl.deleted.2026-09-20T03-00-00.000Z.def.zst'), 8),
    oldLive: put(s('u-3', 'd.jsonl'), 200),
    oldTrajectory: put(s('u-3', 'd.trajectory-path.json'), 200),
    oldSqlite: put(path.join(home, 'agents', 'u-3', 'agent', 'openclaw-agent.sqlite'), 200),
    oldMedia: put(path.join(home, 'media', 'inbound', 'v.ogg'), 91),
    freshMedia: put(path.join(home, 'media', 'inbound', 'w.jpg'), 89),
    oldOutbound: put(path.join(home, 'media', 'outbound', 'card.png'), 200),
    oldCall: put(path.join(voice, 'processed', '1788176934011.json'), 31),
    freshCall: put(path.join(voice, 'processed', '1788177056803.json'), 29),
    pendingCall: put(path.join(voice, '1788177000000.json'), 200),
  };
  return { home, voice, f };
}

test('purgeFiles: only finished files past their days go, and everything live stays', () => {
  const { home, voice, f } = tree();
  const out = fr.purgeFiles({ home, voiceDir: voice, days: fr.DEFAULT_DAYS, now: NOW });
  assert.deepEqual(out, { archivesPurged: 2, mediaPurged: 1, callTranscriptsPurged: 1, fileFailures: 0 });
  for (const k of ['oldDeleted', 'oldReset', 'oldMedia', 'oldCall']) assert.ok(!fs.existsSync(f[k]), `${k} should be gone`);
  // The gateway's live store and anything it may still read are not ours to age.
  for (const k of ['freshDeleted', 'oldLive', 'oldTrajectory', 'oldSqlite', 'freshMedia', 'oldOutbound', 'freshCall']) {
    assert.ok(fs.existsSync(f[k]), `${k} must survive`);
  }
  // A call voice-calls.js has not processed yet is still due.
  assert.ok(fs.existsSync(f.pendingCall), 'an unprocessed call transcript is never aged');
});

test('purgeFiles: a zero or unreadable day count turns that class off, never "delete everything"', () => {
  const { home, voice, f } = tree();
  const out = fr.purgeFiles({ home, voiceDir: voice, days: { archives: 0, media: NaN, callTranscripts: -1 }, now: NOW });
  assert.equal(out.archivesPurged + out.mediaPurged + out.callTranscriptsPurged, 0);
  assert.ok(fs.existsSync(f.oldDeleted) && fs.existsSync(f.oldMedia) && fs.existsSync(f.oldCall));
});

test('purgeFiles: missing directories are "nothing there", not a failure', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'olma2-fr-empty-'));
  const out = fr.purgeFiles({ home, voiceDir: path.join(home, 'nope'), days: fr.DEFAULT_DAYS, now: NOW });
  assert.deepEqual(out, { archivesPurged: 0, mediaPurged: 0, callTranscriptsPurged: 0, fileFailures: 0 });
});

test('purgeFiles: refuses the live gateway home and the live voice bridge from a test process', () => {
  assert.throws(() => fr.purgeFiles({ home: '/root/.openclaw', voiceDir: null, days: fr.DEFAULT_DAYS, now: NOW }),
    /refusing to touch the live gateway/);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'olma2-fr-g-'));
  assert.throws(() => fr.purgeFiles({ home, voiceDir: '/opt/olma2-voice-bridge/transcripts', days: fr.DEFAULT_DAYS, now: NOW }),
    /live voice bridge/);
});

test('the test process is isolated from both live directories before any sweep can run', () => {
  assert.ok(!process.env.OLMA_OPENCLAW_HOME.startsWith('/root/.openclaw'));
  assert.ok(!process.env.VOICE_TRANSCRIPTS_DIR.startsWith('/opt/olma2-voice-bridge'));
});
