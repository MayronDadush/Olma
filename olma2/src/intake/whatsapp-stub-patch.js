'use strict';
// A patch to the gateway's WhatsApp plugin, not to our code — the one place
// this repo edits a file it does not own, so everything about it is here.
//
// THE FAULT (2026-10-07, `incidents.md`, "The first message that reached
// nobody"). Baileys cannot always read somebody's first message: a decrypt
// that fails, or a Click-to-WhatsApp ad's "Message absent from node". It
// upserts a CIPHERTEXT stub (messageStubType 2, no `message`) under the real
// key id, and asks for the content again — a retry receipt to the sender, or a
// placeholder resend from the phone — which arrives later through the same
// `messages.upsert` under the SAME id (baileys 7.0.0-rc14,
// Socket/messages-recv.js "fall through to upsertMessage so the stub is
// emitted"; Utils/process-message.js PLACEHOLDER_MESSAGE_RESEND). The plugin's
// durable ingress queue keys on sha256(remoteJid\nid): the stub is admitted,
// normalises to nothing and completes in milliseconds, and the real message is
// then a duplicate of a completed event and is dropped. Two of three new
// people that evening heard nothing.
//
// THE PATCH admits the stub under its OWN id (`<id>:olma-stub`), so the real
// message keeps the real one. Not skipping the stub outright: when the resend
// never comes (the phone offline) the stub's lane is the only trace that
// somebody wrote, and `jobs/stranger-greet.js` reads exactly that. Each stub
// is logged with its id and Baileys' reason and nothing of the person's, so
// the cause is measured from now on rather than inferred.
//
// It lives in the installed package and is lost on any plugin update.
// `config_guard.checkWhatsAppStubPatch` says so; `scripts/patch-whatsapp-stub.js
// --apply` puts it back. Restart the gateway after applying.
const fs = require('node:fs');
const path = require('node:path');

const MARKER = 'olma2:ciphertext-stub-v1';

// The two lines the patch replaces, verbatim from @openclaw/whatsapp on
// gateway 2026.8.1. Matched whole and required to occur exactly once: a
// rebuilt bundle that moved them is refused, never patched by a guess.
const ANCHOR = '\t\tif (upsert.type !== "notify" && upsert.type !== "append") return;\n'
  + '\t\tfor (const msg of upsert.messages ?? []) {\n';

const REPLACEMENT = '\t\tif (upsert.type !== "notify" && upsert.type !== "append") return;\n'
  + '\t\tfor (const olmaUpsertMsg of upsert.messages ?? []) {\n'
  + `\t\t\t/* ${MARKER}: a CIPHERTEXT stub is admitted under its own id, so the resend `
  + 'that carries the real message under the real id is not dropped as a duplicate. '
  + 'Patched by olma2/scripts/patch-whatsapp-stub.js. */\n'
  + '\t\t\tconst olmaIsStub = olmaUpsertMsg?.messageStubType === 2 && !olmaUpsertMsg?.message && Boolean(olmaUpsertMsg?.key?.id);\n'
  + '\t\t\tif (olmaIsStub) console.warn(`[olma2] whatsapp ciphertext stub ${olmaUpsertMsg.key.id} '
  + '(${String((olmaUpsertMsg.messageStubParameters ?? [])[0] ?? "no reason")}) admitted as its own event`);\n'
  + '\t\t\tconst msg = olmaIsStub ? { ...olmaUpsertMsg, key: { ...olmaUpsertMsg.key, id: `${olmaUpsertMsg.key.id}:olma-stub` } } : olmaUpsertMsg;\n';

const occurrences = (src, needle) => src.split(needle).length - 1;

// Pure. -> { state: 'patched' | 'unpatched' | 'unknown', source? }
// 'unknown' is a bundle this patch was not written against, and is never
// written to.
function patchSource(src) {
  if (src.includes(MARKER)) return { state: 'patched', source: src };
  if (occurrences(src, ANCHOR) !== 1) return { state: 'unknown' };
  return { state: 'unpatched', source: src.replace(ANCHOR, REPLACEMENT) };
}

// Every installed copy of the plugin's monitor that holds the upsert handler.
// The project directory name carries a hash, and the bundle's file name
// another, so both are found rather than written down.
// -> null when the plugin directory cannot be read (unreadable is not broken).
function findMonitorFiles(home) {
  const projects = path.join(home, 'npm', 'projects');
  let dirs;
  try { dirs = fs.readdirSync(projects); } catch { return null; }
  const out = [];
  for (const d of dirs.filter((n) => n.startsWith('openclaw-whatsapp-'))) {
    const dist = path.join(projects, d, 'node_modules', '@openclaw', 'whatsapp', 'dist');
    let files;
    try { files = fs.readdirSync(dist); } catch { continue; }
    for (const f of files) {
      if (!/^monitor-.*\.js$/.test(f)) continue;
      const file = path.join(dist, f);
      try {
        if (fs.readFileSync(file, 'utf8').includes('const handleMessagesUpsert = async')) out.push(file);
      } catch { /* unreadable copy: not ours to judge */ }
    }
  }
  return out;
}

module.exports = { MARKER, ANCHOR, REPLACEMENT, patchSource, findMonitorFiles };
