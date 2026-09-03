'use strict';
// The reconciler for boost mode. Runs on the minute tick and is the ONLY thing
// that writes agents.defaults.model. The dashboard writes a flag and nothing
// else — so an operator's click cannot leave the gateway config half-changed,
// and a crash between "flag set" and "config written" self-heals on the next
// tick instead of stranding everyone on a demo model.
//
// Once a minute is the right cadence for the same reason the expiry is a
// comparison rather than a timer: the guarantee people actually want is "it
// ends on its own", and a guarantee that dies with the process is not one.
// Worst case overshoot is 60 seconds past the two hours.

const boost = require('../domain/boost');
const flagsDomain = require('../domain/flags');
const occ = require('../intake/openclaw-config');
const audit = require('../domain/audit');

const STATE_FLAG = 'boost_mode';
const MODEL_FLAG = 'boost_model';

function writeModel(cfg, model, fallbacks) {
  cfg.agents = cfg.agents || {};
  cfg.agents.defaults = cfg.agents.defaults || {};
  cfg.agents.defaults.model = { primary: model, fallbacks: fallbacks || [] };
  return cfg;
}

// One tick. `deps` is injectable so tests never touch a real openclaw.json.
async function run(client, deps = {}) {
  const configPath = deps.configPath || occ.DEFAULT_PATH;
  const load = deps.loadConfig || (() => occ.loadConfig(configPath));
  const save = deps.saveConfig || ((c) => occ.saveConfig(c, configPath));
  const now = deps.now || new Date();

  const state = await flagsDomain.getFlag(client, STATE_FLAG);
  const boostModel = (await flagsDomain.getFlag(client, MODEL_FLAG)) || null;

  let cfg;
  try {
    cfg = load();
  } catch (e) {
    // An unreadable config is not a reason to touch anything. Report and wait.
    return { skipped: 'config unreadable', error: e.message };
  }

  const d = boost.decide(state, cfg, now, { boostModel });

  if (d.action === 'none') return { action: 'none', reason: d.reason };

  if (d.action === 'alert') {
    // On, but with no usable way back. Never guess a model to restore —
    // writing one nobody chose is worse than the stuck state it papers over.
    await audit.record(client, null, 'boost.unusable', { reason: d.reason });
    return { action: 'alert', reason: d.reason };
  }

  if (d.action === 'engage') {
    save(writeModel(cfg, d.model, (state && state.restore && state.restore.fallbacks) || []));
    await audit.record(client, null, 'boost.engaged', {
      model: d.model, restoreTo: d.restore.model, until: state.until,
    });
    return { action: 'engage', model: d.model };
  }

  // release — put the captured default back, THEN clear the flag. In that
  // order: if the process dies between the two, the next tick sees a flag that
  // is still on and a config already restored, and simply writes nothing.
  // Clearing first would leave a boosted config with no record of why.
  save(writeModel(cfg, d.restore.model, d.restore.fallbacks || []));
  await flagsDomain.setFlag(client, STATE_FLAG, boost.emptyState());
  await audit.record(client, null, 'boost.released', {
    reason: d.reason, restoredTo: d.restore.model,
  });
  return { action: 'release', reason: d.reason, model: d.restore.model };
}

module.exports = { run, STATE_FLAG, MODEL_FLAG, writeModel };
