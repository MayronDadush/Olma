#!/usr/bin/env node
// PreToolUse hook: block whole-file reads of long files in the main
// conversation, and point at the cheap worker instead.
//
// Modelled on spotify/portal-ai-plugins "shunt". Their finding, which matches
// this repo's own doctrine about instructions in tool results: a rule stated in
// a prompt is a request, and a rule enforced at the tool boundary is a rule.
// Asking nicely for restraint about large reads does not survive a long
// session; denying the call does.
//
// Measured on this repo (2026-09-10): 78 of 464 source files are over 350
// lines, and those 78 hold 54,626 of 101,752 total lines — 17% of the files
// carrying 54% of the mass. That is what this gates.
//
// FAILS OPEN, always. A hook that breaks reads is far worse than no hook, so
// every error path here allows the call.
'use strict';

const fs = require('node:fs');

const MIN_LINES = Number(process.env.SHUNT_MIN_LINES || 350);
const ALLOW = () => process.exit(0);

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

// Line count, or null when the file is missing, binary, or otherwise not ours
// to judge. Null always means allow — never "assume it is big".
function countLines(file) {
  try {
    const buf = fs.readFileSync(file);
    if (buf.includes(0)) return null; // binary: Read handles images/PDFs itself
    let n = 1;
    for (const byte of buf) if (byte === 10) n++;
    return n;
  } catch {
    return null; // missing or unreadable — let Read report the real error
  }
}

function guidance(file, lines) {
  return [
    `Blocked: ${file} is ${lines} lines (limit ${MIN_LINES}). Reading it whole would`,
    'put all of it in this conversation for what is usually a small answer.',
    '',
    'Do one of these instead:',
    '',
    '1. Delegate the reading. Spawn the `bulk-reader` agent (Agent tool,',
    '   subagent_type: "bulk-reader") with the actual question. It runs on a cheap',
    '   model, reads the file there, and returns facts with line numbers. Its',
    '   context is thrown away; only the answer reaches this conversation.',
    '2. Read a targeted slice. Read with offset+limit is never blocked, so once you',
    '   know the line you want, go straight to it.',
    '3. Grep first. If you are looking for a symbol or a string, Grep with -n and',
    '   context is cheaper than any read.',
    '',
    'Delegate when you need to understand something; slice when you already know',
    'where it is and are about to edit it. Edits need real line numbers, so make',
    'the targeted read yourself rather than editing off a delegated summary.',
  ].join('\n');
}

function checkRead(input) {
  const args = input.tool_input || {};
  // A targeted read is the escape hatch and is always allowed.
  if (args.offset != null || args.limit != null || args.pages != null) ALLOW();
  const file = args.file_path;
  if (typeof file !== 'string' || !file) ALLOW();
  const lines = countLines(file);
  if (lines == null || lines <= MIN_LINES) ALLOW();
  deny(guidance(file, lines));
}

// Bash is the back door: `cat big.js` costs exactly what `Read` would. Kept
// deliberately narrow — only bare whole-file dumps, because guessing at shell
// semantics is how a hook starts misfiring on legitimate commands.
const DUMP_RE = /(?:^|[;&]\s*)(cat|less|more)\s+((?:-\S+\s+)*)([^\s;&|<>]+)\s*$/;
const HEAD_TAIL_RE = /(?:^|[;&]\s*)(head|tail)\s+(?:-n\s*|-)(\d+)\s+([^\s;&|<>]+)\s*$/;

function checkBash(input) {
  const cmd = (input.tool_input || {}).command;
  if (typeof cmd !== 'string' || !cmd) ALLOW();
  // A pipeline or a redirect is a filter, not a dump — it is the cheap thing.
  if (/[|><]|\$\(|`/.test(cmd)) ALLOW();
  if (cmd.includes('bulk-cat.js')) ALLOW();

  let file = null;
  const dump = cmd.match(DUMP_RE);
  if (dump) file = dump[3];
  const slice = cmd.match(HEAD_TAIL_RE);
  // `head file` with no count prints 10 lines; only an explicit large -n dumps.
  if (slice && Number(slice[2]) > MIN_LINES) file = slice[3];
  if (!file) ALLOW();

  const lines = countLines(file);
  if (lines == null || lines <= MIN_LINES) ALLOW();
  deny(guidance(file, lines));
}

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw);
    // Subagents read freely. Their context never reaches this conversation, and
    // most of them cannot spawn the worker anyway — denying them would leave
    // them with a rule and no way to follow it.
    if (input.agent_id || input.agent_type) ALLOW();
    if (input.tool_name === 'Read') checkRead(input);
    if (input.tool_name === 'Bash') checkBash(input);
  } catch { /* fall through to allow */ }
  ALLOW();
});
