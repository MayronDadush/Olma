'use strict';
// Everything the personal dashboard can CHANGE. The read model next door
// assembles the page; this is the other half, and it is deliberately a thin
// router rather than a second implementation of anything.
//
// The rules it exists to hold:
//
//  - **Every action goes through the same domain function the agent calls.**
//    A person editing their own list from a browser and Olma editing it from a
//    tool call must produce the same row, the same validation and the same
//    audit event. The page is a second FACE, never a second write path.
//  - **The actor id comes from the session, never from the payload.** There is
//    no `userId` field in any action; ids that DO arrive (a task, a friend, a
//    meeting) are re-checked for ownership by the function that uses them, the
//    same way an identity token is.
//  - **An imported task is only editable in the fields its source can hold.**
//    The page greys the rest out; the server refuses them, because a greyed
//    control is a hint and this is the rule. Reminders are the exception in the
//    other direction: a reminder is OURS, not theirs, so an imported task can
//    always be reminded about.
//  - **A refusal names its reason.** `paused`, `imported`, `not_found` — the
//    page has a different thing to offer for each, and a flat "no" gives it
//    nothing to say.
const { ok, err } = require('./results');
const tasks = require('./tasks');
const reminders = require('./reminders');
const shares = require('./shares');
const grants = require('./grants');
const users = require('./users');
const pause = require('./pause');
const audit = require('./audit');
const taskCalendar = require('./task-calendar');
const connections = require('./connections');
const contacts = require('./contacts');
const invites = require('../intake/invites');
const meetings = require('./meetings');
const meetingFanout = require('./meeting-fanout');
const calendar = require('./calendar');
const googleContacts = require('./google-contacts');
const mail = require('./mail');
const googleConnect = require('./google-connect');
const { SOURCE_CAPS } = require('./user-dashboard');

// What a task's origin system can actually hold, for the fields this page can
// edit. Mirrors the map the page draws its locks from — the page must not be
// the only thing that knows. A title has no entry because every source has one:
// it IS the row.
const CAP_FOR_FIELD = { dueAt: 'date', category: 'category' };

async function taskOrigin(client, ownerId, taskId) {
  const { rows } = await client.query(
    `SELECT id, source, archived_at FROM tasks WHERE id = $1 AND owner_id = $2`,
    [taskId, ownerId]
  );
  if (!rows[0]) return null;
  return rows[0];
}

// Why this edit cannot land, or null if it can. Two different refusals, because
// the page has two different things to say:
//
//  - `unsupported_by_source` — the origin system has no such field at all.
//    Slack has no category. This is permanent, and it is what the greyed-out,
//    `inert` control on the page is already telling them.
//  - `no_writeback` — the field exists over there, and we still cannot change
//    it, because writing back is per-source and no source has that mechanism
//    yet. Every import will get its own, deliberately: some of these lists are
//    shared with other people's work.
//
// The second is the interesting one. Accepting the edit locally would look
// like it worked and then be erased by the next sync — a change the person
// believes they made, silently reverted. Refusing is the honest answer until
// there is somewhere to send it.
function importedRefusal(source, fields) {
  const caps = SOURCE_CAPS[source];
  if (!caps) return null;          // ours, or an origin we do not model: editable
  if (fields.length === 0) return null;
  for (const f of fields) {
    const cap = CAP_FOR_FIELD[f];
    if (cap && !caps.includes(cap)) {
      return err('forbidden', `${source} has no ${f}`,
        { reason: 'unsupported_by_source', source, field: f });
    }
  }
  return err('forbidden', `a ${source} task is changed in ${source}, not here — not yet`,
    { reason: 'no_writeback', source, field: fields[0] });
}

// Anything that ends in Olma sending a message later is refused while paused,
// and says so. Setting a reminder on a paused account is not a small
// inconsistency: the delivery gate DROPS a paused user's rows outright, so the
// reminder would be accepted, stored, and then silently never arrive — which
// is worse than being told no. The page has `resume` right there to offer.
async function refuseIfPaused(client, userId) {
  if (await pause.isPaused(client, userId)) {
    return err('forbidden', 'Olma is paused for this user', { reason: 'paused' });
  }
  return null;
}

// The three Google services this page draws, by the key it draws them under.
// Turning one ON is a consent round trip and goes through startGoogle; only
// the off direction is a plain write, so only that direction is a table.
const GOOGLE_STOP = {
  cal: (client, userId) => calendar.disconnect(client, userId),
  contacts: (client, userId) => googleContacts.disconnect(client, userId),
  mail: (client, userId) => mail.disconnect(client, userId),
};

const ACTIONS = {
  // ---- tasks ---------------------------------------------------------------
  async addTask(client, userId, p) {
    return tasks.addTask(client, userId, {
      title: p.title, category: p.category, dueAt: p.dueAt, parentId: p.parentId,
      // Written here, from a browser, by the person themselves — as distinct
      // from 'chat' (they said it) and from an import. The distinction is what
      // lets the fact/commitment sweeps know this line already exists.
      source: 'dashboard',
    });
  },

  async editTask(client, userId, p) {
    const origin = await taskOrigin(client, userId, p.taskId);
    if (!origin) return err('not_found', 'task not found');
    const fields = ['title', 'category', 'dueAt'].filter((f) => Object.hasOwn(p, f));
    const refused = importedRefusal(origin.source, fields);
    if (refused) return refused;
    const patch = {};
    for (const f of fields) patch[f] = p[f];
    return tasks.editTask(client, userId, p.taskId, patch);
  },

  async completeTask(client, userId, p) {
    return tasks.completeTask(client, userId, p.taskId);
  },

  async snoozeTask(client, userId, p) {
    return tasks.snoozeTask(client, userId, p.taskId, p.dueAt);
  },

  async archiveTask(client, userId, p) {
    return tasks.archiveTask(client, userId, p.taskId);
  },

  // The other half of the archive. The page calls the archiving "delete", so
  // this is the only way back from a tap somebody did not mean — and the
  // archive screen offers it, which made its absence from here a button that
  // moved a row on screen and nowhere else.
  async restoreTask(client, userId, p) {
    return tasks.unarchiveTask(client, userId, p.taskId);
  },

  // ---- this task, on their calendar ---------------------------------------
  // A switch inside one task, about that one task (migration 029). Turning it
  // on is refused outright when no calendar is connected or the grant is
  // view-only, rather than stored as a wish nothing can carry out: the sheet
  // would then show a lit switch and the event would never appear.
  async setTaskCalendar(client, userId, p) {
    return taskCalendar.setTaskSync(client, userId, p.taskId, p.on === true);
  },

  // ---- reminders -----------------------------------------------------------
  async setReminder(client, userId, p) {
    const paused = await refuseIfPaused(client, userId);
    if (paused) return paused;
    return reminders.setReminder(client, userId, p.taskId, p.remindAt, p.repeatRule);
  },

  async cancelReminder(client, userId, p) {
    // Never refused while paused: cancelling is the direction that reduces
    // what Olma will send, and a paused person must always be able to.
    return reminders.cancelReminder(client, userId, p.reminderId);
  },

  // One switch, two directions, and — the part that matters — never a second
  // reminder alongside the first. `reminders.setReminder` always INSERTs,
  // which is right for a tool call ("remind me again an hour before") and
  // wrong for a control that shows a single on/off state: flipping it twice
  // would leave two rows and the person would be told twice.
  //
  // So this is a replace. Everything still pending on the task is cancelled
  // first, and only then is the new one written.
  async setTaskReminder(client, userId, p) {
    const { rows: pending } = await client.query(
      `SELECT r.id FROM task_reminders r JOIN tasks t ON t.id = r.task_id
        WHERE r.task_id = $1 AND t.owner_id = $2
          AND r.sent_at IS NULL AND r.cancelled_at IS NULL`,
      [p.taskId, userId]
    );
    if (p.on !== true) {
      // Turning it OFF is allowed while paused, for the same reason cancelling
      // one is: it can only ever reduce what Olma will send.
      for (const r of pending) {
        const res = await reminders.cancelReminder(client, userId, r.id);
        if (!res.ok) return res;
      }
      return ok({ taskId: p.taskId, on: false, cancelled: pending.length });
    }
    const paused = await refuseIfPaused(client, userId);
    if (paused) return paused;
    // Cancel first, and only once the new one is known to be writable — the
    // task has to exist and be open, which setReminder checks. Doing it the
    // other way round can leave a task with no reminder at all after a refusal.
    const probe = await client.query(
      `SELECT status FROM tasks WHERE id = $1 AND owner_id = $2 AND archived_at IS NULL`,
      [p.taskId, userId]
    );
    if (!probe.rows[0]) return err('not_found', 'task not found');
    if (probe.rows[0].status !== 'open') {
      return err('invalid', 'cannot set a reminder on a completed task');
    }
    for (const r of pending) {
      const res = await reminders.cancelReminder(client, userId, r.id);
      if (!res.ok) return res;
    }
    return reminders.setReminder(client, userId, p.taskId, p.remindAt, p.repeatRule ?? null);
  },

  // ---- sharing -------------------------------------------------------------
  async shareTask(client, userId, p) {
    return shares.offerShare(client, userId, p.taskId, p.viewerId, p.role || 'viewer');
  },

  // Both "stop sharing this with them" and "take me off this" are the same
  // row being revoked; shares.revokeShare already accepts either side, and
  // giving the page two names for one operation would only invite them to
  // drift apart.
  async revokeShare(client, userId, p) {
    return shares.revokeShare(client, userId, p.shareId);
  },

  async respondToShare(client, userId, p) {
    return shares.respondToShare(client, userId, p.shareId, p.decision);
  },

  // ---- friends -------------------------------------------------------------
  // Asking somebody to connect. The same call the agent makes, including the
  // part that is easy to forget: requestConnection writes the row, and
  // `afterConnectionRequest` is what actually reaches the other person. Without
  // it the request would sit in the table and nobody would ever be asked.
  //
  // The number is resolved from THEIR OWN address book, by contact id, and
  // never taken from the payload — a page that could post a phone number
  // straight into requestConnection would be a way to invite anybody at all
  // from a stolen session, and to find out who is on Olma by watching which
  // ones come back 'already connected'.
  async inviteContact(client, userId, p) {
    const { rows } = await client.query(
      `SELECT phone FROM user_contacts WHERE id = $1 AND user_id = $2`,
      [p.contactId, userId]
    );
    if (!rows[0]) return err('not_found', 'no such contact');
    const phone = contacts.normalisePhone(rows[0].phone, null) || rows[0].phone;
    const res = await connections.requestConnection(client, userId, phone, {});
    if (!res.ok) return res;
    const me = await users.getById(client, userId);
    const notified = await invites.afterConnectionRequest(
      client, me, res.data.connection, res.data.targetKnown);
    return ok({ connection: res.data.connection, notified: notified.data.notified });
  },

  async grantFeature(client, userId, p) {
    return grants.grantFeature(client, userId, p.connectionId, p.feature);
  },

  async revokeFeature(client, userId, p) {
    return grants.revokeFeatureGrant(client, userId, p.connectionId, p.feature);
  },

  // ---- meetings ------------------------------------------------------------
  // Answering a coordination with a tap. The domain call and everything that
  // follows from it are the SAME ones the chat tool uses (domain/meetings.js +
  // domain/meeting-fanout.js) — a yes given here and a yes given in a
  // conversation have to produce the same rows, or the two faces would tell
  // different people different things about one meeting.
  //
  // `acceptedStartAt` is the guard that makes this safe from a screen: it pins
  // the yes to the exact slot that was on the page when they read it. If the
  // meeting moved while the tab sat open, the call is refused with the current
  // slot rather than landing their agreement on a time they never saw.
  async respondToMeeting(client, userId, p) {
    const accept = p.accept === true;
    const res = await meetings.respondToSlot(
      client, userId, p.meetingId, accept, null, null, accept ? p.acceptedStartAt : null);
    if (!res.ok) return res;
    const me = await users.getById(client, userId);
    return meetingFanout.afterSlotResponse(client, me, p.meetingId, res, { accept });
  },

  // Leaving is one person bowing out, never a cancellation for everyone — the
  // page says so in its own words and this is the call that matches them.
  async leaveMeeting(client, userId, p) {
    const res = await meetings.optOut(client, userId, p.meetingId);
    if (!res.ok) return res;
    const me = await users.getById(client, userId);
    return meetingFanout.afterOptOut(client, me, p.meetingId, res);
  },

  // The way back out of the archive. Leaving was one tap and reversing it was
  // nothing at all, which is a bad trade for an action whose commonest cause
  // is a mis-tap. `meetings.rejoin` refuses everything it should — a
  // coordination that closed when you left cannot be reopened by you alone —
  // and the others are told, because they were told when you went.
  async rejoinMeeting(client, userId, p) {
    const res = await meetings.rejoin(client, userId, p.meetingId);
    if (!res.ok) return res;
    const me = await users.getById(client, userId);
    return meetingFanout.afterRejoin(client, me, p.meetingId, res);
  },

  // ---- accounts ------------------------------------------------------------
  // The only provider on this page with a connection behind it. It returns a
  // URL and nothing else: the grant happens on Google's own consent screen,
  // which lists the exact scopes and is the only place a person can actually
  // agree to them. Nothing is connected when this resolves — which is why the
  // page must not draw a tick until the callback has come back.
  //
  // Write access, deliberately: read-only is a live choice the agent offers in
  // chat, but a calendar Olma cannot write to makes the per-task calendar
  // switch two rows away refuse every time it is touched, and a page whose own
  // controls contradict each other is worse than one that asks for more.
  // Google's screen still spells out what is being asked before anything is
  // granted.
  //
  // Not gated on pause. Being paused means Olma does not send; it does not
  // mean a person cannot manage their own accounts, and this sends nothing.
  async startGoogle(client, userId, p) {
    const access = p.calendarAccess;
    if (access && access !== 'read_only' && access !== 'read_write') {
      return err('invalid', 'calendarAccess must be read_only or read_write');
    }
    const me = await users.getById(client, userId);
    // ONE consent screen for however many services were asked for — the whole
    // point of google-connect.js. Three separate round trips would mean three
    // Google screens for a person who pressed one button, and three refresh
    // tokens where the family logic expects one.
    return googleConnect.beginConnection(client, me, {
      calendarAccess: access || undefined,
      wantContacts: p.contacts === true,
      wantMail: p.mail === true,
    });
  },

  // Turning one service off. Not the same as ending the account: the other two
  // keep working, and each disconnect decides for itself whether the shared
  // refresh token may be revoked at Google.
  async stopGoogleService(client, userId, p) {
    const stop = GOOGLE_STOP[p.service];
    if (!stop) return err('invalid', 'unknown service');
    return stop(client, userId);
  },

  // The page draws Google as one account, so ending it ends all of it —
  // anything less leaves a row the person believes they just removed.
  //
  // Order does not matter and the sequence is not conditional: each disconnect
  // already answers `{connected:false}` for a service that was never on, and
  // each decides for itself whether the shared refresh token may be revoked at
  // Google (googleFamily.hasOtherGoogleConnection) — which is the whole reason
  // these are three calls rather than one DELETE. Doing it by hand here would
  // mean re-deriving that rule in a second place and getting it wrong the day
  // a fourth Google service arrives.
  async stopGoogle(client, userId) {
    const calRes = await calendar.disconnect(client, userId);
    if (!calRes.ok) return calRes;
    const conRes = await googleContacts.disconnect(client, userId);
    if (!conRes.ok) return conRes;
    const mailRes = await mail.disconnect(client, userId);
    if (!mailRes.ok) return mailRes;
    return ok({ connected: false });
  },

  // ---- me ------------------------------------------------------------------
  async setTimezone(client, userId, p) {
    // Always confirmed from here: a person picking their own city on their own
    // screen is the definition of confirmed, and it is what lets setTimezone
    // repair the rows a guessed zone had already converted wrongly.
    return users.setTimezone(client, userId, p.timezone, true);
  },

  async pause(client, userId) {
    return pause.pauseUser(client, userId, { note: 'from the dashboard' });
  },

  async resume(client, userId) {
    return pause.resumeUser(client, userId);
  },
};

// One door. `action` is a key of ACTIONS and nothing else — never a path, never
// a function name pulled out of the request.
async function perform(client, userId, action, payload = {}) {
  if (!Object.hasOwn(ACTIONS, action)) {
    return err('invalid', `unknown action: ${String(action).slice(0, 40)}`);
  }
  const res = await ACTIONS[action](client, userId, payload);
  // The domain function writes its own audit row for what CHANGED; this one
  // records where the change came from, the same distinction the admin
  // dashboard draws with its `admin.*` events. An operator reading the trail
  // has to be able to tell a person tapping their own phone from their agent
  // acting on their behalf.
  if (res.ok) await audit.record(client, userId, 'dashboard.' + action, payload);
  return res;
}

module.exports = { perform, ACTIONS: Object.keys(ACTIONS) };
