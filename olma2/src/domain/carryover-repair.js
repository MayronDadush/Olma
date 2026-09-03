'use strict';
// Strip a carryover section that quotes words its owner never sent.
//
// The "מה שכבר שיתפו" section is meant to hold the person's OWN first message
// to the greeter, quoted into their own card so their personal agent can pick
// the conversation up mid-sentence. When provisioning attributed the wrong
// session it wrote a stranger's private message there instead — and that text
// is then read aloud to the wrong person on their next turn.
//
// Two things make it outlive its own fix. refreshUserCard rewrites only the
// head of USER.md and copies everything from the first `\n## ` onward VERBATIM,
// so a bad section is re-emitted on every refresh, for ever; and the guard that
// was supposed to catch it only ever looked at cards whose text collided with
// another card's. Prevention has been in jobs/intake.readIntakeFirstMessage
// since 2026-08-27 and the live reader was re-verified correct on 2026-09-03 —
// so this is purely going back for the damage already written down.
//
// The section is REMOVED, never rewritten with the right text. Their real first
// message is days old by now; re-injecting it would hand the agent a stale
// errand ("book a nail appointment for next week") as though it had just
// arrived. It also stays recoverable from the greeter's own transcript, which
// is where it belongs. Deleting the wrong words is the whole job.
const fs = require('node:fs');
const path = require('node:path');
const audit = require('./audit');
const sessions = require('../channels/sessions');

const CARRYOVER_HEADING = '## מה שכבר שיתפו';
const QUOTED_RE = /<<<([\s\S]*?)>>>/;
const INTAKE_AGENT_ID = 'intake';
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

// Cut the carryover section out of a card: from its heading to the next `## `
// at the start of a line, or to the end. Returns null when there is nothing to
// cut, so a caller can tell "already clean" from "rewritten".
function stripCarryover(card) {
  const at = card.indexOf(CARRYOVER_HEADING);
  if (at < 0) return null;
  const rest = card.slice(at + CARRYOVER_HEADING.length);
  const nextRel = rest.search(/\n## /);
  const end = nextRel < 0 ? card.length : at + CARRYOVER_HEADING.length + nextRel + 1;
  return (card.slice(0, at).replace(/\s+$/, '') + '\n' + card.slice(end)).replace(/\n{3,}/g, '\n\n');
}

// verdict for one card: 'clean' | 'ok' | 'unverifiable' | 'leak'
function classify(card, ownText) {
  const at = card.indexOf(CARRYOVER_HEADING);
  if (at < 0) return { verdict: 'clean' };
  const m = card.slice(at).match(QUOTED_RE);
  const quoted = m ? norm(m[1]) : null;
  // A legacy section with no fence has nothing quotable to check. Leaving it
  // is the safe half of the bet: removing text we cannot prove is foreign
  // would delete a real person's real words to tidy up a report.
  if (!quoted) return { verdict: 'unverifiable', reason: 'no <<< >>> fence' };
  if (ownText === null) return { verdict: 'unverifiable', quoted, reason: 'intake session unreadable' };
  // Containment, not equality: the greeter's session keeps growing after
  // provisioning, so the card holds a prefix of what is there now.
  return norm(ownText).includes(quoted)
    ? { verdict: 'ok', quoted }
    : { verdict: 'leak', quoted };
}

async function repairCarryovers(pool, { apply = false, log = () => {}, readPeerText } = {}) {
  const read = readPeerText || ((phone) => sessions.readPeerUserText(INTAKE_AGENT_ID, phone));
  const { rows } = await pool.query(
    `SELECT id, phone, first_name, workspace_path FROM users
     WHERE status = 'active' AND workspace_path IS NOT NULL
     ORDER BY id`
  );
  const out = { repaired: [], ok: 0, clean: 0, unverifiable: [], failed: [] };
  for (const u of rows) {
    const file = path.join(u.workspace_path, 'USER.md');
    let card;
    try { card = fs.readFileSync(file, 'utf8'); } catch { continue; }
    let own = null;
    try { own = read(u.phone); } catch { own = null; }
    const { verdict, quoted, reason } = classify(card, own == null ? null : own);

    if (verdict === 'clean') { out.clean++; continue; }
    if (verdict === 'ok') { out.ok++; continue; }
    if (verdict === 'unverifiable') {
      out.unverifiable.push({ id: u.id, reason });
      log(`  user ${u.id} (${u.first_name || '—'}): left alone — ${reason}`);
      continue;
    }

    // A leak. Report the LENGTH and the owner if we can name them, never the
    // text: copying a stranger's private message into audit_log to record that
    // it leaked would spread it one table further.
    const owner = rows.find((o) => {
      if (o.id === u.id) return false;
      let t = null; try { t = read(o.phone); } catch { return false; }
      return t && norm(t).includes(quoted);
    });
    log(`  user ${u.id} (${u.first_name || '—'}): LEAK — quotes ${quoted.length} chars they never sent`
      + (owner ? `, which belong to user ${owner.id}` : ''));
    if (!apply) { out.repaired.push({ id: u.id, ownerId: owner ? owner.id : null }); continue; }
    const next = stripCarryover(card);
    try {
      fs.writeFileSync(file, next);
    } catch (e) {
      out.failed.push({ id: u.id, error: e.message });
      log(`  user ${u.id}: WRITE FAILED — ${e.message}`);
      continue;
    }
    const client = await pool.connect();
    try {
      await audit.record(client, u.id, 'admin.carryover_leak_repaired', {
        removedChars: quoted.length, ownerUserId: owner ? owner.id : null,
      });
    } finally { client.release(); }
    out.repaired.push({ id: u.id, ownerId: owner ? owner.id : null });
  }
  return out;
}

module.exports = { repairCarryovers, stripCarryover, classify, CARRYOVER_HEADING };
