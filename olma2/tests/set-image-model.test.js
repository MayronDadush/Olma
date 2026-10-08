'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withImageModel, MODEL } = require('../scripts/set-image-model');

// The live shape on 2026-10-07: two audio entries and nothing for images.
const live = () => ({ tools: { media: { audio: { enabled: true }, models: [
  { provider: 'elevenlabs', model: 'scribe_v2', capabilities: ['audio'] },
  { type: 'cli', command: '/root/whisper-transcribe.sh', capabilities: ['audio'] },
] } } });

test('adds one image entry after the audio ones, which stay as they were', () => {
  const cfg = withImageModel(live());
  assert.deepEqual(cfg.tools.media.models.slice(0, 2), live().tools.media.models);
  assert.deepEqual(cfg.tools.media.models[2], { provider: 'openrouter', model: MODEL, capabilities: ['image'] });
  assert.deepEqual(cfg.tools.media.audio, { enabled: true });
});

test('a second run replaces the entry rather than adding another, and --reset removes it', () => {
  const twice = withImageModel(withImageModel(live()));
  assert.equal(twice.tools.media.models.filter((m) => m.capabilities.includes('image')).length, 1);
  assert.deepEqual(withImageModel(twice, { reset: true }).tools.media.models, live().tools.media.models);
});

test('a config with no tools.media at all gets one', () => {
  assert.deepEqual(withImageModel({}).tools.media.models, [{ provider: 'openrouter', model: MODEL, capabilities: ['image'] }]);
});
