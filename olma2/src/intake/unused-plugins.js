'use strict';
// Bundled gateway plugins we switch OFF, because the gateway loads them into
// its own process by default and nothing of ours ever calls them.
//
// The box has 2GB and the gateway is the process that does not fit: 771MB
// resident plus 544MB in swap on 2026-10-10, 25 critical memory readings the
// day before, and a restart in the middle of the nightly evals. Its startup
// line names what it imports — "16 plugins: anthropic, browser, canvas,
// cua-computer, device-pair, file-transfer, geolocation, linux-node,
// memory-core, ollama, olma-turn, openai, openrouter, talk-voice, whatsapp,
// xai" — and our config enables five of them.
//
// Each id below was checked the same day against two things:
//   - every agent's transcript store, all history: not one call to any tool
//     these plugins own (browser, canvas, file_fetch/dir_list/dir_fetch/
//     file_write, node_inference, code_execution, x_search);
//   - the gateway's environment and config: no OpenAI, xAI or Ollama
//     credential and no model ref on those providers (our openai/* models go
//     through openrouter/*, a different provider plugin).
// The rest are node-host and macOS-panel features (camera, location, desktop
// control, voice selection for Talk mode) on a headless server.
//
// Deliberately NOT here: device-pair (the CLI's own pairing — every
// `openclaw agent --deliver` rides that handshake), anthropic (the configured
// fallback provider), and the media plugins the gateway loads on demand for
// voice notes and attachments (elevenlabs, document-extract) — they are not
// in the startup sixteen and they are used.
//
// `plugins.entries.<id>.enabled: false` rather than `plugins.allow`: an
// allowlist would also have to name every plugin loaded on demand, and one it
// forgot is a capability that disappears without an error. A deny of ten
// named ids cannot take anything else with it. Config changes to plugins
// need a gateway restart (docs/gateway/configuration-reference.md).
const UNUSED_PLUGINS = Object.freeze([
  'browser',
  'canvas',
  'cua-computer',
  'file-transfer',
  'geolocation',
  'linux-node',
  'ollama',
  'openai',
  'talk-voice',
  'xai',
]);

// The ids from the list that this config does not explicitly switch off.
// Unset is the gateway's default, which for every one of them is ON.
function stillEnabled(cfg) {
  const entries = ((cfg || {}).plugins || {}).entries || {};
  return UNUSED_PLUGINS.filter((id) => !entries[id] || entries[id].enabled !== false);
}

// Writes `enabled: false` on each, keeping any other key an entry carries.
// Returns the ids it changed.
function disableUnused(cfg) {
  cfg.plugins = cfg.plugins || {};
  cfg.plugins.entries = cfg.plugins.entries || {};
  const changed = stillEnabled(cfg);
  for (const id of changed) {
    cfg.plugins.entries[id] = { ...(cfg.plugins.entries[id] || {}), enabled: false };
  }
  return changed;
}

module.exports = { UNUSED_PLUGINS, stillEnabled, disableUnused };
