#!/usr/bin/env node
// Name the model the gateway reads a picture with, instead of letting it guess.
//
// A photo a person sends is described by the gateway before the agent's turn
// (its "media understanding" step), and the agent model, which cannot see,
// works from that text. With no image entry in `tools.media.models` and no
// `agents.defaults.imageModel`, the gateway asks `openrouter/auto` — which
// routes each call wherever OpenRouter likes, and 3 of the 6 photos sent in
// the fourteen days to 2026-10-07 came back 400 and reached the agent as
// "[Image attachment could not be analyzed]". The CLI says the same thing
// in words: "No image understanding provider is configured".
//
// The entry sits beside the two audio ones and is chosen by its
// `capabilities`, so audio is untouched.
//
// NOT gemini-3.5-flash-lite, though food/ reads plates with it: the gateway's
// image call sends `reasoning: { effort: "none" }`, and both 3.5 Flash models
// answer 400 "Reasoning is mandatory for this endpoint and cannot be
// disabled" — so the first entry (2026-10-07) failed every photo, by a new
// route. Measured on the box 2026-10-08 through the gateway's own describe
// function: 3.1-flash-lite, 2.5-flash-lite, 2.5-flash and 3-flash-preview
// all accept it. food/ calls the model itself, without that field, and is
// unaffected.
//
// Config only; `tools.media` hot-reloads. Verify on the next real photo: the
// gateway log shows a model-fetch to this model and no "image: failed".
//
// Usage: node scripts/set-image-model.js [--apply] [--reset]
//   --reset removes the entry (back to the gateway's guess)
'use strict';

const MODEL = 'google/gemini-3.1-flash-lite';
const isImageEntry = (m) => Array.isArray(m && m.capabilities) && m.capabilities.length === 1 && m.capabilities[0] === 'image';

// Returns the config with exactly one image entry (or none, on reset), every
// other entry kept in its order.
function withImageModel(cfg, { reset = false } = {}) {
  cfg.tools = cfg.tools || {};
  cfg.tools.media = cfg.tools.media || {};
  const rest = (cfg.tools.media.models || []).filter((m) => !isImageEntry(m));
  cfg.tools.media.models = reset ? rest : [...rest, { provider: 'openrouter', model: MODEL, capabilities: ['image'] }];
  return cfg;
}

function main() {
  const occ = require('../src/intake/openclaw-config');
  const APPLY = process.argv.includes('--apply');
  const RESET = process.argv.includes('--reset');
  const cfg = occ.loadConfig();
  const before = (cfg.tools?.media?.models || []).find(isImageEntry);
  withImageModel(cfg, { reset: RESET });
  console.log('tools.media.models image entry:', before ? `${before.provider}/${before.model}` : '(none — the gateway guesses openrouter/auto)',
    '->', RESET ? '(none)' : `openrouter/${MODEL}`);
  if (!APPLY) { console.log('\ndry run — pass --apply to write'); return; }
  occ.saveConfig(cfg);
  console.log('\nwritten. Confirm the gateway applied it, not just the file:');
  console.log('  XDG_RUNTIME_DIR=/run/user/0 journalctl --user -u openclaw-gateway --since "-2min" | grep "\\[reload\\]"');
}

if (require.main === module) main();
module.exports = { withImageModel, isImageEntry, MODEL };
