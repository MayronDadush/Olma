-- The mailbox connection is gone (2026-09-30, `incidents.md`, "The mailbox
-- connection was removed"). Its tools left on 2026-09-07; this release takes
-- out the domain (`domain/mail.js`, `mail-gmail.js`), the hourly mailbox
-- watch, the `Email:` line in USER.md and the combined consent's Gmail half.
-- What is left in the DATABASE is what this file clears.
--
-- The `gmail` integration rows. On the day this was written there were three,
-- and every one of them shared its refresh token with that person's calendar
-- row (google-family.js: one combined consent, one token). So nothing is
-- revoked at Google here — revoking would kill their calendar with it. The
-- grant for gmail.readonly stays on their Google account until they connect
-- again or remove the app themselves; nothing of ours can use it any more.
-- Each removal is audited as the old `mail.disconnect` did, with a reason.
INSERT INTO audit_log (actor_id, event, detail)
SELECT user_id, 'email.disconnected',
       jsonb_build_object('provider', provider, 'reason', 'feature_removed',
                          'revokedAtProvider', false)
  FROM integrations
 WHERE provider = 'gmail';

DELETE FROM integrations WHERE provider = 'gmail';

-- A consent link minted for a mailbox before the deploy and never used.
DELETE FROM oauth_states WHERE provider = 'gmail';

-- A mailbox watch nobody can be served any more. Cancelled, never deleted —
-- the same rule as the outbox. None existed on the box when this was written.
UPDATE live_subscriptions SET cancelled_at = now()
 WHERE source = 'mail_query' AND cancelled_at IS NULL;

-- The allowlist flag for a feature that no longer exists. Deleting the row is
-- backward-compatible: the old code reads a missing key as its default, which
-- was closed.
DELETE FROM feature_flags WHERE key = 'email_access_phones';
