'use strict';
// The bundled gateway plugins we switch off to save the gateway's memory
// (src/intake/unused-plugins.js), and the config_guard row that notices one
// coming back. Pure config, no DB.
const test = require('node:test');
const assert = require('node:assert/strict');
const { UNUSED_PLUGINS, stillEnabled, disableUnused } = require('../src/intake/unused-plugins');
const guard = require('../src/jobs/config-guard');

test('unused plugins: unset is the gateway default, which is ON', () => {
  assert.deepEqual(stillEnabled({}), UNUSED_PLUGINS);
  assert.deepEqual(stillEnabled({ plugins: { entries: { browser: {} } } }), UNUSED_PLUGINS,
    'an entry with no enabled key is still the default');
  assert.deepEqual(stillEnabled({ plugins: { entries: { browser: { enabled: true } } } }), UNUSED_PLUGINS);
});

test('unused plugins: disableUnused switches off exactly the list and keeps everything else', () => {
  const cfg = { plugins: { entries: {
    whatsapp: { enabled: true },
    'memory-core': { config: { dreaming: { enabled: false } } },
    openai: { enabled: true, config: { kept: 1 } },
    canvas: { enabled: false },
  } } };
  const changed = disableUnused(cfg);
  assert.ok(!changed.includes('canvas'), 'one already off is not a change');
  assert.equal(changed.length, UNUSED_PLUGINS.length - 1);
  assert.deepEqual(stillEnabled(cfg), []);
  assert.deepEqual(cfg.plugins.entries.openai, { enabled: false, config: { kept: 1 } }, 'only enabled moves');
  assert.deepEqual(cfg.plugins.entries.whatsapp, { enabled: true }, 'a plugin we use is never touched');
  assert.deepEqual(cfg.plugins.entries['memory-core'], { config: { dreaming: { enabled: false } } });
  assert.deepEqual(disableUnused(cfg), [], 'a second pass changes nothing');
});

test('unused plugins: none of the plugins the system runs on is on the list', () => {
  // whatsapp is the channel, openrouter the model, olma-turn our plugin,
  // memory-core memory_search, device-pair the CLI's own pairing (every
  // --deliver), anthropic the fallback provider, and the on-demand media
  // plugins read voice notes and attachments.
  for (const id of ['whatsapp', 'openrouter', 'olma-turn', 'memory-core', 'device-pair', 'anthropic', 'elevenlabs', 'document-extract']) {
    assert.ok(!UNUSED_PLUGINS.includes(id), id);
  }
});

test('config guard: an unused plugin that comes back is a row naming it, and off is quiet', () => {
  const cfg = { plugins: { entries: {} } };
  disableUnused(cfg);
  assert.deepEqual(guard.checkUnusedPlugins(cfg), []);
  cfg.plugins.entries.browser.enabled = true;
  delete cfg.plugins.entries.xai;
  const v = guard.checkUnusedPlugins(cfg);
  assert.equal(v.length, 1);
  assert.match(v[0], /^2 unused gateway plugin\(s\) are not switched off: browser, xai/);
  assert.match(v[0], /disable-unused-plugins\.js --apply/, 'says how to fix it');
});
