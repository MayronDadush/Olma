#!/usr/bin/env node
'use strict';
// READ-ONLY. What would the reply gate (domain/reply-leak.js) do to every
// real assistant message on this box, and what English is left that it does
// not touch?
//
// The module's own rule is that a DROP tier is chosen from traffic and never
// guessed — a false positive there eats a reply somebody was waiting for. This
// is the measurement: it runs the gate over every assistant text in every
// `u-N` agent's transcript store for the last DAYS days and prints, per
// paragraph, what the gate does today and whether the paragraph is English
// inside a reply that is otherwise Hebrew (the shape every working-out leak on
// file has had). Read the residue by hand before adding a pattern, and read
// the drops by hand before trusting one.
//
// First run 2026-09-15 (`incidents.md`, "The working-out, measured"): 33
// agents, 14 days, 1,156 messages, 2,247 paragraphs, 151 hits, of which two
// were real English replies a naive rule would have deleted.
//
//   node scripts/measure-reply-gate.js            # last 14 days
//   DAYS=30 node scripts/measure-reply-gate.js    # wider
//   ... --agent u-3                               # one person
//
// Nothing is written. Runs on the box (it needs the agents' sqlite stores).
// Written without an exclamation mark anywhere: an interactive bash expands
// one inside a pasted heredoc as history, which garbled an earlier one-liner.
const fs = require('node:fs');
const path = require('node:path');
const sessions = require('../src/channels/sessions');
const { gateReply, scannable } = require('../src/domain/reply-leak');

const DAYS = Number(process.env.DAYS || 14);
const base = process.env.OLMA_OPENCLAW_HOME || '/root/.openclaw';
const only = (() => { const i = process.argv.indexOf('--agent'); return i > 0 ? process.argv[i + 1] : null; })();
const since = Date.now() - DAYS * 86400e3;
const HEB = /[֐-׿]/;
const SENTINEL = 'NO_REPLY';

const agents = fs.readdirSync(path.join(base, 'agents'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^u-\d+$/.test(d.name) && (!only || d.name === only))
  .map((d) => d.name).sort();

function local(ms) {
  return new Date(ms).toLocaleString('sv-SE', { timeZone: process.env.TZ_DISPLAY || 'Asia/Jerusalem' });
}

// A paragraph is "English" when, with links, addresses and quotations blanked
// out, it has no Hebrew left, four or more words, and at least two of them
// Latin-letter words — a bare link or a quoted English name on a line of its
// own is not an English paragraph.
function englishParagraph(para) {
  const stripped = scannable(para).trim();
  const words = stripped.split(/\s+/).filter(Boolean);
  const latin = words.filter((w) => /[A-Za-z]{2,}/.test(w)).length;
  return !HEB.test(stripped) && words.length >= 4 && latin >= 2;
}

let messages = 0;
let paragraphs = 0;
const actions = { pass: 0, trim: 0, cancel: 0 };
const rows = [];
for (const agentId of agents) {
  const texts = sessions.scanAssistantTextSince(agentId, since, base);
  if (texts === null) { console.log(`# ${agentId}: store unreadable, skipped`); continue; }
  for (const r of texts) {
    const text = String(r.text || '');
    if (text.trim() === SENTINEL) continue;
    messages += 1;
    const hebrewOutsideQuotes = HEB.test(scannable(text));
    const v = gateReply(text);
    actions[v.action] = (actions[v.action] || 0) + 1;
    const lines = text.split('\n');
    const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    let cursor = 0;
    paras.forEach((para, idx) => {
      paragraphs += 1;
      // which lines of the reply this paragraph spans, so its finding is its own
      const firstLine = lines.findIndex((l, i) => i >= cursor && l.trim() && para.startsWith(l.trim()));
      const lastLine = firstLine < 0 ? -1 : firstLine + para.split('\n').length - 1;
      cursor = lastLine + 1;
      const found = v.reported.filter((l) => l.line >= firstLine && l.line <= lastLine).map((l) => l.kind);
      const english = hebrewOutsideQuotes && englishParagraph(para);
      const survives = v.action === 'pass' || (v.action === 'trim' && v.text.includes(para.slice(0, 60)));
      if (!found.length && !english) return;
      rows.push({
        agentId, at: local(r.at), idx: idx + 1, n: paras.length, action: v.action,
        survives: survives ? 'delivered' : 'cut',
        found: found.length ? found.join('+') : (english ? 'english-only' : ''),
        para: para.replace(/\s+/g, ' ').slice(0, 180),
      });
    });
  }
}

console.log(`agents: ${agents.length}  days: ${DAYS}  assistant messages: ${messages}  paragraphs: ${paragraphs}`);
console.log(`gate today: pass ${actions.pass}  trim ${actions.trim}  cancel ${actions.cancel}`);
const residue = rows.filter((x) => x.found === 'english-only' && x.survives === 'delivered');
console.log(`English paragraphs the gate delivers with no finding at all: ${residue.length}  (read these — they are the next tier, or the proof there is none)`);
console.log('');
console.log('--- agent | local time | paragraph i/n | gate action | this paragraph | finding | text ---');
for (const x of rows) {
  console.log(`${x.agentId} | ${x.at} | ${x.idx}/${x.n} | ${x.action.padEnd(6)} | ${x.survives.padEnd(9)} | ${x.found.padEnd(14)} | ${x.para}`);
}
