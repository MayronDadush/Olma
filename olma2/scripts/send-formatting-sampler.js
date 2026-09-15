#!/usr/bin/env node
'use strict';
// Put one message on a phone showing every style that phone's platform can
// render, each next to its name and the characters that produce it.
//
// It exists because "which styles does WhatsApp have" is a question with a
// screenshot for an answer, not a paragraph: the owner asked to see them all
// at once before deciding which of them Olma should start using. The message
// is BUILT from domain/message-format.STYLES, so the demo and the table the
// code formats with cannot drift apart — a style added there appears here on
// the next run, and one that is wrong here is wrong in production too.
//
// It goes out on the RAW pipe, never through an agent turn. A sampler is the
// one message whose exact characters are the entire content: a model asked to
// relay it would helpfully tidy the asterisks away. The same reason reminders
// ride this pipe, for once not about billing.
//
// It is an operator probe aimed at a phone the operator names, so it is not
// gated, budgeted or audited like a message Olma decided to send. Do not point
// it at a user to tell them something — that is what the outbox is for.
//
//   node scripts/send-formatting-sampler.js --user 1            # print only
//   node scripts/send-formatting-sampler.js --to +9725... --apply
//   node scripts/send-formatting-sampler.js --user 1 --lang en --apply
const { createPool } = require('../src/db/pool');
const format = require('../src/domain/message-format');
const users = require('../src/domain/users');
const { runOpenclaw } = require('../src/channels/openclaw');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
}

async function target() {
  const to = arg('--to');
  const userId = arg('--user');
  // A phone given by hand has no row to read a platform off, so it is
  // WhatsApp — the only channel the raw pipe speaks. A user id resolves the
  // real one, which is the point: the sampler shows what THAT person's
  // platform can do, not what WhatsApp can do.
  if (to) return { phone: to, channelType: 'whatsapp', pool: null };
  if (!userId) throw new Error('one of --to <E.164> or --user <id> is required');

  const pool = createPool();
  const client = await pool.connect();
  try {
    const ch = await users.primaryChannel(client, Number(userId));
    if (!ch.ok) throw new Error(`user ${userId}: ${ch.error.message}`);
    return {
      phone: ch.data.channel.channel_identifier,
      channelType: ch.data.channel.channel_type,
      pool,
    };
  } finally {
    client.release();
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  const lang = arg('--lang') === 'en' ? 'en' : 'he';
  const { phone, channelType, pool } = await target();
  try {
    const text = format.sampler(lang, channelType);
    const can = format.capabilitiesFor(channelType);
    const on = format.ALL_KEYS.filter((k) => can[k]);

    console.log(`target   ${phone} (${channelType})`);
    console.log(`styles   ${on.length ? on.join(', ') : 'none — this platform renders plain text'}`);
    console.log(`${'-'.repeat(60)}\n${text}\n${'-'.repeat(60)}`);

    if (!apply) {
      console.log('\nDry run. Re-run with --apply to send it.');
      return;
    }
    const res = await runOpenclaw([
      'message', 'send',
      '--channel', channelType,
      '--target', phone,
      '--message', text,
    ]);
    // A timeout is not a failure on this pipe — the CLI hands the message over
    // and only then waits (channels/openclaw.runOpenclaw). Say which happened
    // rather than reporting "not sent" for a message that very likely landed.
    if (res.ok) console.log('\nsent');
    else if (res.timedOut) console.log('\nthe CLI timed out after handing it over — check the phone before re-running');
    else throw new Error(`send failed: ${res.error}`);
  } finally {
    if (pool) await pool.end();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
