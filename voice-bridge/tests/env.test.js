'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadEnvFiles } = require('../lib/env');

function tmpFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olma-voice-env-'));
  const f = path.join(dir, 'env');
  fs.writeFileSync(f, content);
  return f;
}

test('KEY=value lines load, `export` is tolerated, and the first file wins', () => {
  const a = tmpFile('DEEPGRAM_API_KEY=dg-a\nexport CARTESIA_API_KEY=ca-a\n# comment\nnot a line\n');
  const b = tmpFile('DEEPGRAM_API_KEY=dg-b\nOPENROUTER_API_KEY=or-b\n');
  const env = {};
  const set = loadEnvFiles([a, b], env);
  assert.deepEqual(env, { DEEPGRAM_API_KEY: 'dg-a', CARTESIA_API_KEY: 'ca-a', OPENROUTER_API_KEY: 'or-b' });
  assert.deepEqual(set, ['DEEPGRAM_API_KEY', 'CARTESIA_API_KEY', 'OPENROUTER_API_KEY']);
});

test('a value already in the environment is never overwritten by a file', () => {
  const f = tmpFile('VOICE_TTS=cartesia\n');
  const env = { VOICE_TTS: 'elevenlabs' };
  loadEnvFiles([f], env);
  assert.equal(env.VOICE_TTS, 'elevenlabs', 'the unit\'s Environment= outranks the file');
});

test('a missing file is skipped, not an error', () => {
  const env = {};
  assert.deepEqual(loadEnvFiles(['/nonexistent/olma.env'], env), []);
  assert.deepEqual(env, {});
});
