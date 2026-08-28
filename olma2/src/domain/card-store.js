'use strict';
// Where a rendered card lives on disk, and for how long.
//
// The directory is not an arbitrary choice — it is the security boundary.
// The gateway will only attach outbound media it is allowed to read, and
// `resolveAgentScopedOutboundMediaAccess` builds that allow-list from the
// agent's own workspace (plus its managed media root). Nothing else on the box
// is readable for a send. So writing cards under the caller's workspace buys
// three things at once:
//
//   - the gateway can actually attach the file,
//   - one user's card can never be served into another user's chat, because
//     each agent's allow-list is its own workspace and nobody else's,
//   - a prompt-injected `MEDIA: /etc/shadow` still sends nothing, because that
//     path is outside every allow-list.
//
// The path comes from the users row, never from tool arguments. A tool that
// accepted a caller-supplied path would hand that boundary straight back.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ok, err } = require('./results');

const CARD_DIR = 'cards';
const DEFAULT_MAX_AGE_HOURS = 24;

function cardDirFor(user) {
  return path.join(user.workspace_path, CARD_DIR);
}

// Writes the file and returns its absolute path for the agent to put in a
// MEDIA: line. Random filename: the name is echoed into a model's reply, so it
// should carry nothing about the user or what is in the file. Same directory
// and same reasoning for every media kind — schedule cards, generated images,
// generated videos — because the boundary argument above does not care what
// the bytes are.
const MEDIA_EXTENSIONS = ['png', 'mp4'];

function saveMedia(user, buf, ext) {
  if (!MEDIA_EXTENSIONS.includes(ext)) {
    return err('invalid', `unsupported media extension: ${ext}`);
  }
  if (!user || !user.workspace_path) {
    return err('conflict', 'no workspace for this user yet — cannot store a card');
  }
  if (!fs.existsSync(user.workspace_path)) {
    return err('conflict', 'workspace directory is missing on this host');
  }
  const dir = cardDirFor(user);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${crypto.randomUUID()}.${ext}`);
  fs.writeFileSync(file, buf);
  return ok({ path: file, bytes: buf.length });
}

function saveCard(user, png) {
  return saveMedia(user, png, 'png');
}

// Cards are a delivery artefact, not a record: once the message carrying one
// has been sent, the file has no further job. Folded into the existing
// retention sweep rather than given its own timer.
async function purgeOldCards(client, maxAgeHours = DEFAULT_MAX_AGE_HOURS) {
  const cutoff = Date.now() - maxAgeHours * 3600_000;
  const { rows } = await client.query(
    `SELECT workspace_path FROM users WHERE workspace_path IS NOT NULL`
  );
  let purged = 0;
  for (const row of rows) {
    const dir = path.join(row.workspace_path, CARD_DIR);
    let entries;
    // A workspace that does not exist on this host is the normal case for test
    // rows and for any box that is not the live one — not an error.
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (!MEDIA_EXTENSIONS.some((ext) => name.endsWith('.' + ext))) continue;
      const file = path.join(dir, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) { fs.unlinkSync(file); purged++; }
      } catch { /* vanished under us, or unreadable — nothing to do either way */ }
    }
  }
  return purged;
}

module.exports = { saveCard, saveMedia, purgeOldCards, cardDirFor, CARD_DIR, DEFAULT_MAX_AGE_HOURS };
