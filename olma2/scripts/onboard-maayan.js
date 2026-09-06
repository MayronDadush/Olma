#!/usr/bin/env node
'use strict';
// One-off: onboard the person whose first message the gateway silently
// dropped, and arm the two reminders she asked for in it.
//
// 2026-09-05 23:06 Israel time, +972502200581 wrote to Olma for the first
// time. The message reached the box — the WhatsApp session/identity/tctoken
// files for her LID (70278717694032) were written at 20:06:11 UTC, and the
// gateway's durable ingress queue holds exactly one row for that lane — and
// was then discarded 21ms later without ever being dispatched: no `Inbound
// message` log line, no agent run in audit_events, no session, no user row.
// processDurableInboundMessage has six paths that return "completed" and log
// only under `verbose`, which production does not run, so a dropped message
// leaves no operator-visible trace at all. Her config was not the cause:
// openclaw.json as it stood that minute (openclaw.json.bak-groupsmap-
// 20260905-1948) had dmPolicy=open, allowFrom=["*"] and the catch-all binding
// to `intake`.
//
// Nothing here messages her. She is provisioned and PAUSED in the same
// transaction, because a freshly onboarded user is immediately eligible for
// the day-one check-in ladder (jobs/checkin.js, onboardingStepDue is checked
// before the idle gate) and would otherwise be written to within minutes.
// Resuming her is a separate, deliberate act — scripts/../src/domain/pause.js
// resumeUser — done only once the owner has approved what she is told.
//
// The two reminders are set to their NEXT occurrence, not the ones she asked
// for: she asked on the 5th for "מחר ב-11:00" (the 6th) and a daily 12:00,
// and both of those hours had passed before this ran. Monday the 7th is a
// school day, so the cheque errand still lands where she meant it.
//
// Rehearses by default: the transaction is rolled back AND the filesystem and
// gateway config are redirected at a throwaway directory, so a dry run cannot
// seed a workspace or edit the live roster. --apply uses the real paths and
// commits.
//
//   node scripts/onboard-maayan.js
//   node scripts/onboard-maayan.js --apply
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPool } = require('../src/db/pool');
const provision = require('../src/intake/provision');
const pause = require('../src/domain/pause');
const tasks = require('../src/domain/tasks');
const reminders = require('../src/domain/reminders');

const PHONE = '+972502200581';
const FIRST_NAME = 'מעיין';
const TZ = 'Asia/Jerusalem';

// What she actually told us, as facts rather than a transcript — this is what
// seedWorkspace puts in USER.md, which the agent reads every turn.
const FIRST_MESSAGE = [
  'פנתה לראשונה ב-5.9.2026 בערב. ההודעה שלה נבלעה בתקלה בצד שלנו ולא נענתה —',
  'אם היא מזכירה שלא קיבלה מענה, זה נכון והאשמה שלנו.',
  'ביקשה שתי תזכורות: יומית ב-12:00 לשלוח החזרים לקופה (עד שתגיד שטופל),',
  'ותזכורת חד-פעמית לקחת צ׳ק מבית ספר היובל.',
].join(' ');

const LIVE_CONFIG = '/root/.openclaw/openclaw.json';

// Her two reminders, at the next occurrence of the hour she named.
const CASH_REGISTER_AT = '2026-09-07T12:00:00+03:00';
const CHEQUE_AT = '2026-09-07T11:00:00+03:00';

async function main() {
  const apply = process.argv.includes('--apply');
  let configPath = LIVE_CONFIG;
  let sandbox = null;

  if (!apply) {
    // A rehearsal that seeds a real workspace or edits the real roster is not
    // a rehearsal. Redirect both, and hand provision a COPY of the live config
    // so the write path is exercised against the real shape.
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-rehearsal-'));
    process.env.OLMA_OPENCLAW_HOME = sandbox;
    process.env.OLMA_IMMUTABLE_IDENTITY = 'off'; // never chattr +i under /tmp
    configPath = path.join(sandbox, 'openclaw.json');
    fs.copyFileSync(LIVE_CONFIG, configPath);
    console.log(`[rehearsal] filesystem + config redirected to ${sandbox}`);
  }

  const pool = createPool();
  const client = await pool.connect();
  const undos = [];
  try {
    await client.query('BEGIN');

    const prov = await provision.provisionUser(client, {
      phone: PHONE,
      firstName: FIRST_NAME,
      timezone: TZ,
      locale: 'he',
      firstMessage: FIRST_MESSAGE,
      configPath,
      registerUndo: (fn) => undos.push(fn),
      // Never shell out to systemctl from a one-off repair script.
      restartGateway: async () => false,
    });
    if (!prov.ok) throw new Error(`provision failed: ${prov.error.message}`);
    const userId = prov.data.user.id;
    console.log(`user ${userId} (${prov.data.agentId}) -> ${prov.data.workspace}`);

    // Before anything can sweep her. Committed together with the row itself,
    // so there is no window in which she is active and unpaused.
    const paused = await pause.pauseUser(client, userId);
    if (!paused.ok) throw new Error(`pause failed: ${paused.error.message}`);
    console.log(`paused at ${paused.data.pausedAt} — nothing will be delivered until resumed`);

    // "תשלחי לי בבקשה תזכורות כל יום בשעה 12:00 לשלוח החזרים לקופה.
    //  עד שאני יגיד שטופל" — no due_at: the errand has no moment of its own,
    // 12:00 is the hour SHE named, so it is the reminder and nothing else.
    const cash = await tasks.addTask(client, userId, {
      title: 'לשלוח החזרים לקופה', source: 'whatsapp',
    });
    if (!cash.ok) throw new Error(`cash task failed: ${cash.error.message}`);
    const cashRem = await reminders.setReminder(
      client, userId, cash.data.task.id, CASH_REGISTER_AT, 'daily');
    if (!cashRem.ok) throw new Error(`cash reminder failed: ${cashRem.error.message}`);
    console.log(`task ${cash.data.task.id} "${cash.data.task.title}" — daily from ${CASH_REGISTER_AT}`);

    // "תזכורת מחר בשעה 11:00 לקחת צ״ק מבית ספר היובל" — one-off, passed as
    // remind_at so the automatic hour-before never gets a say.
    const cheque = await tasks.addTask(client, userId, {
      title: 'לקחת צ׳ק מבית ספר היובל', source: 'whatsapp', remindAt: CHEQUE_AT,
    });
    if (!cheque.ok) throw new Error(`cheque task failed: ${cheque.error.message}`);
    console.log(`task ${cheque.data.task.id} "${cheque.data.task.title}" — once at ${CHEQUE_AT}`);
    console.log(`  armed for: ${JSON.stringify(cheque.data.remindersAt)}`);

    if (apply) {
      await client.query('COMMIT');
      console.log('\nCOMMITTED. She is in the system, paused, with both reminders armed.');
      console.log('Nothing has been sent to her. To let messages flow:');
      console.log('  node -e "..." resumeUser, or the dashboard\'s resume control.');
    } else {
      await client.query('ROLLBACK');
      for (const undo of undos.reverse()) {
        try { await undo(); } catch (e) { console.error(`undo failed: ${e.message}`); }
      }
      console.log('\nROLLED BACK (rehearsal). Re-run with --apply to commit.');
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    for (const undo of undos.reverse()) {
      try { await undo(); } catch (err) { console.error(`undo failed: ${err.message}`); }
    }
    throw e;
  } finally {
    client.release();
    await pool.end();
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
