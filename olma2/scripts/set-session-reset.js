#!/usr/bin/env node
// Make every session start over once a day.
//
// `session.reset` decides when the gateway opens a fresh history window for
// a session key. Its default is "none": a session never ends, and every
// model call carries everything since the last reset — which for a WhatsApp
// assistant means everything since the day the person joined. Measured on
// the box 2026-09-09 (docs/incidents.md, "The conversation that never
// ended"): u-3's one session, open since 2026-08-27, was 205,000 tokens on
// every call — $0.018 of history read per message before the first word,
// 8–23 seconds to the first token, and 52% of the whole real-user bill
// across four people. Every user drifts there; u-3 took thirteen days.
//
// "daily" rolls the session on the first message after `atHour` on the
// gateway HOST's clock — the box is UTC, so 2 is 05:00 in Israel (04:00 in
// winter), before anybody writes. Nothing the conversation KNOWS lives in the
// window: tasks, reminders, meetings, facts and preferences are in the DB and
// USER.md, which is injected on every session start. What the watchers read
// (promise_watch, the onboarding review, fact extraction, unanswered) follows
// `session_windows.previous_session_id` in channels/sessions.js, so a reset
// hides yesterday from nobody but the model.
//
// Config only, and the gateway reads `session` per message — but this ships
// beside two settings that DO need a restart (the provider pin and the
// turn-context plugin list), so restart once after all three.
// The guard rule in jobs/config-guard.js (checkOpenclawConfig) turns red when
// the mode is anything else, so an upgrade that resets it shows on the board.
//
// Usage: node scripts/set-session-reset.js [--apply] [--reset]
//   --reset deletes `session.reset` (back to the gateway default, "none")
'use strict';
const occ = require('../src/intake/openclaw-config');

const APPLY = process.argv.includes('--apply');
const RESET = process.argv.includes('--reset');
const AT_HOUR = 2; // UTC on the box; 05:00 Asia/Jerusalem in summer

const cfg = occ.loadConfig();
cfg.session = cfg.session || {};
const before = cfg.session.reset === undefined ? '(unset — gateway default "none")' : JSON.stringify(cfg.session.reset);
if (RESET) delete cfg.session.reset; else cfg.session.reset = { mode: 'daily', atHour: AT_HOUR };
console.log('session.reset:', before, '->', RESET ? '(unset — "none")' : JSON.stringify(cfg.session.reset));

if (!APPLY) { console.log('\ndry run — pass --apply to write'); process.exit(0); }
occ.saveConfig(cfg);
console.log('\nwritten. Prove it on the box, not in the file: the morning after, a person\'s');
console.log('session_windows row must carry a new session_id with reason "rollover" —');
console.log('  node -e "const {DatabaseSync}=require(\'node:sqlite\');const db=new DatabaseSync(\'/root/.openclaw/agents/u-3/agent/openclaw-agent.sqlite\',{readOnly:true});console.log(db.prepare(\'select session_id,previous_session_id,reason,created_at from session_windows order by created_at desc limit 3\').all())"');
