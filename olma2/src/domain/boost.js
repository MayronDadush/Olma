'use strict';
// Boost mode: one dashboard switch that moves every user onto a faster, more
// capable model for a demo, and takes them back off it again on its own.
//
// The whole design is one idea: THE SWITCH IS DATA, THE RECONCILER IS THE ONLY
// WRITER. The dashboard only ever writes a flag; a job compares that flag to
// the live gateway config once a minute and makes the config match. Nothing
// else writes agents.defaults.model. That is what makes the two hard promises
// keepable:
//
//   - It cannot get stuck on. Expiry is a comparison against a stored
//     timestamp, re-made every tick, not a setTimeout that dies with the
//     process. brokerd can restart mid-demo and the boost still ends on time.
//   - It cannot lose the way back. The model to restore is captured when boost
//     is ENGAGED and stored inside the flag, so it survives a restart, a
//     deploy, and an operator who forgets what the default used to be.
//
// agents.defaults.model is `kind: "hot"` on gateway 2026.8.1 (verified against
// dist/config-reload-plan-*.js and live), so engaging and releasing are both
// invisible to users mid-conversation — no restart, no dropped turn.

const DEFAULT_MAX_MINUTES = 120;

// The one shape stored in the `boost_mode` flag.
//   { on, startedAt, until, model, restore: { model, fallbacks } }
// `restore` is the state to put back, captured at engage time.

function emptyState() {
  return { on: false };
}

// Is `s` a usable boost state? A malformed flag must read as OFF, never as
// "on with no way back" — the failure that would strand every user on a demo
// model until somebody noticed the bill.
function isEngaged(s) {
  return !!(s && s.on === true && typeof s.until === 'string' && s.restore
    && typeof s.restore.model === 'string' && s.restore.model);
}

function expired(s, now) {
  const until = Date.parse(s.until);
  if (!Number.isFinite(until)) return true; // unreadable deadline = expired
  return now.getTime() >= until;
}

// What the live config currently says the default model is.
function currentModel(cfg) {
  const m = cfg && cfg.agents && cfg.agents.defaults && cfg.agents.defaults.model;
  if (!m) return null;
  return typeof m === 'string' ? { model: m, fallbacks: [] }
    : { model: m.primary || null, fallbacks: Array.isArray(m.fallbacks) ? m.fallbacks : [] };
}

// The decision, given the flag, the live config and the clock. Pure: the job
// does the writing, this says what writing is called for. Every branch returns
// a `reason` because every one of them ends up in an audit row — an operator
// asking "why did the demo end" must not have to guess.
function decide(state, cfg, now, opts = {}) {
  const s = state && typeof state === 'object' ? state : emptyState();
  const live = currentModel(cfg);
  const boostModel = opts.boostModel;

  if (!isEngaged(s)) {
    // Not engaged. If the flag is malformed but the config is still sitting on
    // a boost model, we have no stored restore and must NOT guess one —
    // guessing would write a model nobody chose. Say so loudly instead.
    if (s && s.on === true) {
      return { action: 'alert', reason: 'boost flag is on but unusable (no restore target)' };
    }
    return { action: 'none', reason: 'off' };
  }

  if (expired(s, now)) {
    return { action: 'release', reason: 'expired', restore: s.restore };
  }

  // Engaged and in date. Make the config match — but only if it does not
  // already, so a steady demo is not a config write every 60 seconds (each one
  // costs a hot reload).
  const want = boostModel || s.model;
  if (!want) return { action: 'alert', reason: 'boost is on but no model is configured' };
  if (live && live.model === want) return { action: 'none', reason: 'already boosted' };
  return { action: 'engage', reason: 'boost on', model: want, restore: s.restore };
}

// Build the state to store when an operator turns the switch ON. `live` is
// what the config says right now — that becomes the way back.
function engageState(live, model, now, maxMinutes = DEFAULT_MAX_MINUTES) {
  if (!model) return { ok: false, error: 'no boost model configured' };
  if (!live || !live.model) return { ok: false, error: 'cannot read the current default model' };
  // Refuse to record the boost model as its own restore target. Turning boost
  // on twice without this would overwrite the way back with the way there, and
  // every user would stay on the demo model for good — silently, since nothing
  // about the config would look wrong afterwards.
  if (live.model === model) {
    return { ok: false, error: 'the default model is already the boost model — refusing to capture it as the restore target' };
  }
  const until = new Date(now.getTime() + maxMinutes * 60000);
  return {
    ok: true,
    state: {
      on: true,
      startedAt: now.toISOString(),
      until: until.toISOString(),
      model,
      restore: { model: live.model, fallbacks: live.fallbacks || [] },
    },
  };
}

// Minutes left, for the dashboard banner. Never negative.
function minutesLeft(s, now) {
  if (!isEngaged(s)) return 0;
  const until = Date.parse(s.until);
  if (!Number.isFinite(until)) return 0;
  return Math.max(0, Math.ceil((until - now.getTime()) / 60000));
}

module.exports = {
  DEFAULT_MAX_MINUTES, emptyState, isEngaged, expired, currentModel,
  decide, engageState, minutesLeft,
};
