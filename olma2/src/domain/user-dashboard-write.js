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
  async grantFeature(client, userId, p) {
    return grants.grantFeature(client, userId, p.connectionId, p.feature);
  },

  async revokeFeature(client, userId, p) {
    return grants.revokeFeatureGrant(client, userId, p.connectionId, p.feature);
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
