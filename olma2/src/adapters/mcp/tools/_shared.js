'use strict';
// Everything the per-domain tool files share: the domain modules, the
// `tool`/`S` schema helpers, and the few handler helpers more than one
// domain needs. This is the old head of registry.js, moved verbatim; the
// registry itself is now just the ordered concatenation of ./*.js.
//
// A tool file imports what it uses from here and exports an array of
// tool() entries. Adding a tool is one entry in the file for its domain;
// adding a domain is one file plus one line in ../registry.js — order
// there is the order the gateway lists tools in, so it is kept explicit.
const users = require('../../../domain/users');
const onboardingDomain = require('../../../domain/onboarding');
const selfInitiated = require('../../../domain/self-initiated');
const tasks = require('../../../domain/tasks');
const reminders = require('../../../domain/reminders');
const preferences = require('../../../domain/preferences');
const connections = require('../../../domain/connections');
const grants = require('../../../domain/grants');
const shares = require('../../../domain/shares');
const meetings = require('../../../domain/meetings');
const availability = require('../../../domain/availability');
const dashboardAuth = require('../../../domain/dashboard-auth');
const issues = require('../../../domain/issues');
const digest = require('../../../domain/digest');
const quota = require('../../../domain/quota');
const calendar = require('../../../domain/calendar');
const taskCalendar = require('../../../domain/task-calendar');
const googleContacts = require('../../../domain/google-contacts');
const mail = require('../../../domain/mail');
const googleConnect = require('../../../domain/google-connect');
const scheduleCard = require('../../../domain/schedule-card');
const media = require('../../../domain/media');
const liveUpdates = require('../../../domain/live-updates');
const pause = require('../../../domain/pause');
const voice = require('../../../domain/voice');
const relay = require('../../../domain/relay');
const cardStore = require('../../../domain/card-store');
const facts = require('../../../domain/facts');
const searchLink = require('../../../domain/search-link');
const contacts = require('../../../domain/contacts');
const reactions = require('../../../domain/reactions');
const audit = require('../../../domain/audit');
const { ok, err } = require('../../../domain/results');
const { scrubTokens } = require('../render');
const { IDENTITY_PARAM } = require('../identity-param');

const { ICON_NAMES } = scheduleCard;

const { enqueue } = require('../../../outbox/enqueue');
// Everything that follows a meeting answer — who hears about it, which queued
// questions are now wrong, the shared calendar event — lives in the domain
// now, because the dashboard answers meetings too and the two faces must
// produce identical rows. These names are re-exported here unchanged so the
// handlers below read as they always did.
const meetingFanout = require('../../../domain/meeting-fanout');
const {
  actorName, fanout, supersedeQueuedMeetingRows, activeParticipantsExcept,
  meetingCalendarFanout, calendarRoleFor, cancelCalendarCleanup, calendarHintFor,
  meetingBrief, CANCEL_CLEANUP_HINTS,
} = meetingFanout;

const S = (type, description, extra) => ({ type, description, ...(extra || {}) });

// ---- cross-user event fan-out ----------------------------------------------
// Every state change someone else must hear about becomes an outbox row —
// same respectful-delivery gate as everything else. Live-negotiation events
// are urgent (bypass the daily budget, still respect night windows).

// A WhatsApp display name is one free-text field, not a first/last pair, so it
// splits at the first space and stops there: "חיים דדוש" → חיים + דדוש,
// "גלי" → גלי. When the peer has set no display name the gateway falls back to
// putting the number itself in that field, which tells us nothing — a `sender`
// that is mostly digits is dropped rather than saved as somebody's name.
// A display name is also where people put decoration — "חיים 🌊", "🌊 חיים",
// or nothing but the emoji. Letterless words are dropped BEFORE the split, so
// the real half survives whichever side it sits on; users.setName refuses what
// is left if there is no name in it at all (that is the guard, this is only
// about not throwing away a name standing next to an emoji).
async function captureDisplayName(client, user, raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return err('invalid', 'no display name in this turn');
  if (text.replace(/\D/g, '').length >= 7) return err('invalid', 'that is their phone number');
  const words = text.split(' ').filter((w) => /\p{L}/u.test(w));
  if (!words.length) return err('invalid', 'that display name has no name in it');
  const [first, ...rest] = words;
  return users.setName(client, user.id, first, rest.join(' ') || null,
    { confirmed: false, source: 'whatsapp_display_name' });
}

// Marks the caller's USER.md as needing a re-render, for a handler whose tool
// only sometimes changes something the card shows. It rides the result
// ENVELOPE, never result.data — render.js serialises data alone, so the model
// never sees this (see brokerd/server.js for the other half).
function stale(result, when) {
  if (when) result.cardStale = true;
  return result;
}

function tool(name, description, props, required, handler) {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: {
        // Repeated on every one of the 86 schemas, on every turn: each word here
        // costs 86 times what it looks like.
        [IDENTITY_PARAM]: S('string', 'your identity string from AGENTS.md'),
        ...props,
      },
      required: [IDENTITY_PARAM, ...required],
    },
    handler,
  };
}

// Resolve a connected counterparty by phone. Deliberately does NOT reveal
// whether an unknown phone belongs to a user — the not_connected error is
// identical either way.
async function connectedUserByPhone(client, actorId, phone, feature) {
  const target = await users.getByPhone(client, phone);
  if (!target) return err('forbidden', 'not connected to this person', { reason: 'not_connected' });
  const gate = await grants.requireFeatureBetween(client, actorId, target.id, feature);
  if (!gate.ok) return gate;
  return ok({ target, connection: gate.data.connection });
}


module.exports = {
  users, onboardingDomain, selfInitiated, tasks, reminders, preferences, connections, grants, shares, meetings, availability, dashboardAuth, issues, digest, quota, calendar, taskCalendar, googleContacts, mail, googleConnect, scheduleCard, media, liveUpdates, pause, voice, relay, cardStore, facts, searchLink, contacts, reactions, audit, meetingFanout, S, ok, err, scrubTokens, IDENTITY_PARAM, ICON_NAMES, enqueue, actorName, fanout, supersedeQueuedMeetingRows, activeParticipantsExcept, meetingCalendarFanout, calendarRoleFor, cancelCalendarCleanup, calendarHintFor, meetingBrief, CANCEL_CLEANUP_HINTS, captureDisplayName, stale, tool, connectedUserByPhone,
};
