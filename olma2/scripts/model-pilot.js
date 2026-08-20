#!/usr/bin/env node
// Side-by-side model comparison — never touches production routing or a
// real conversation. Runs a real agent turn (real workspace, real tools,
// real USER.md context) but on an isolated session key and WITHOUT
// --deliver, so nothing ever reaches WhatsApp and nothing lands in the
// person's actual session history.
//
// Why this exists: the standing default (anthropic/claude-haiku-4-5) is
// being compared against open-weight alternatives on OpenRouter for cost
// (see CLAUDE.md, "Model provider pilot"). The comparison has to be a real
// turn — real tool selection, real Hebrew — not a synthetic benchmark, but
// it must not put an unproven model in front of a real person's real
// conversation. --model is a per-call override the openclaw CLI already
// supports; this script just wraps it with a safe, disposable session.
//
// Usage:
//   node scripts/model-pilot.js --agent u-3 --message "..." [--model openrouter/qwen/qwen3-235b-a22b-2507]
//   (omit --model to run the current default, for a baseline)
'use strict';
const { spawn } = require('node:child_process');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const agentId = arg('agent');
const message = arg('message');
const model = arg('model'); // omit for the current default
if (!agentId || !message) {
  console.error('Usage: node model-pilot.js --agent <id> --message "..." [--model <provider/model>]');
  process.exit(1);
}

// A disposable key per run, never a real user's session key — so a pilot
// call can never be mistaken for (or fold into) their actual conversation.
const sessionKey = `agent:${agentId}:pilot-${Date.now()}`;
const args = [
  'agent', '--agent', agentId, '--session-key', sessionKey,
  '--message', message, '--json',
  // no --deliver, ever — this is a comparison, not a send
];
if (model) args.push('--model', model);

const child = spawn('openclaw', args, { stdio: ['ignore', 'pipe', 'pipe'] });
let out = '', errOut = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { errOut += d; });
child.on('exit', (code) => {
  if (code !== 0) {
    console.error(`openclaw agent exited ${code}: ${errOut.trim().slice(0, 500)}`);
    process.exit(code || 1);
  }
  let json;
  try { json = JSON.parse(out); }
  catch { console.error('unparseable output:', out.slice(0, 500)); process.exit(1); }

  const meta = json.result && json.result.meta && json.result.meta.agentMeta;
  const reply = json.result && json.result.payloads && json.result.payloads[0];
  console.log('--- model actually used ---');
  console.log(`${meta ? meta.provider : '?'}/${meta ? meta.model : '?'}`);
  console.log('--- reply ---');
  console.log(reply ? reply.text : '(no text payload)');
  console.log('--- usage ---');
  console.log(meta ? JSON.stringify(meta.usage) : '(none reported)');
  console.log('--- session (for transcript inspection — tool calls etc) ---');
  console.log(meta ? meta.sessionFile : '(none)');
});
