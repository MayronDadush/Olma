'use strict';
// The retention promise every table was born with, kept: routine audit rows
// age out; permanent (consent/privacy) rows never do. Sent outbox rows and
// stale session snapshots age out too. Days tunable via flag, no deploy.
const flags = require('../domain/flags');
const cardStore = require('../domain/card-store');
const fileRetention = require('../domain/file-retention');

async function daysFlag(client, key, fallback) {
  const v = Number(await flags.getFlag(client, key) ?? fallback);
  return Number.isFinite(v) ? v : fallback;
}

async function sweepRetention(client) {
  const days = Number(await flags.getFlag(client, 'audit_retention_days') ?? 180);
  const audit = await client.query(
    `DELETE FROM audit_log WHERE retention_class = 'routine'
       AND created_at < now() - make_interval(days => $1)`,
    [days]
  );
  const outbox = await client.query(
    `DELETE FROM outbox WHERE sent_at IS NOT NULL
       AND sent_at < now() - make_interval(days => $1)`,
    [days]
  );
  const snapshots = await client.query(
    `DELETE FROM usage_session_snapshots WHERE updated_at < now() - interval '30 days'`
  );
  // Consent flows people started and abandoned. Kept a day past expiry so a
  // replay still reads as "already used" rather than "never existed" while
  // anyone might still be looking at it.
  const states = await client.query(
    `DELETE FROM oauth_states WHERE expires_at < now() - interval '1 day'`
  );
  // Availability-picker links, same idea with a longer grace: a week past
  // expiry the URL in the person's WhatsApp history should say "expired",
  // not "never existed". The submissions themselves (meeting_availability)
  // stay with their meeting.
  const pickerLinks = await client.query(
    `DELETE FROM picker_links WHERE expires_at < now() - interval '7 days'`
  );
  // Rendered schedule cards: files, not rows. Once the message that carried one
  // is delivered the file is dead weight, so they age out in hours rather than
  // days. Folded in here rather than given a timer of its own — a second
  // near-identical sweeper is how the v1 cron jobs got hard to reason about.
  const cardHours = Number(await flags.getFlag(client, 'card_retention_hours') ?? cardStore.DEFAULT_MAX_AGE_HOURS);
  const cardsPurged = await cardStore.purgeOldCards(client, cardHours);
  // What people said, in files: gateway session archives, the voice notes and
  // photos they sent, finished call transcripts (domain/file-retention.js).
  // Read per call, never at load, so the test isolation in tests/helpers.js
  // cannot be outrun by require order.
  const files = fileRetention.purgeFiles({
    home: process.env.OLMA_OPENCLAW_HOME || '/root/.openclaw',
    voiceDir: process.env.VOICE_TRANSCRIPTS_DIR || '/opt/olma2-voice-bridge/transcripts',
    days: {
      archives: await daysFlag(client, 'session_archive_retention_days', fileRetention.DEFAULT_DAYS.archives),
      media: await daysFlag(client, 'inbound_media_retention_days', fileRetention.DEFAULT_DAYS.media),
      callTranscripts: await daysFlag(client, 'call_transcript_retention_days', fileRetention.DEFAULT_DAYS.callTranscripts),
    },
  });
  return {
    auditPurged: audit.rowCount, outboxPurged: outbox.rowCount,
    snapshotsPurged: snapshots.rowCount, oauthStatesPurged: states.rowCount,
    pickerLinksPurged: pickerLinks.rowCount,
    cardsPurged,
    ...files,
  };
}

module.exports = { sweepRetention };
