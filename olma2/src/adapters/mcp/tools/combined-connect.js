'use strict';
// combined connect — one slice of the tool registry (see ../registry.js).
const {
  googleConnect, S, tool,
} = require('./_shared');

module.exports = [
  // One link for calendar + contacts together, instead of two. ASK the user
  // which they want (and, if calendar, which access level) before calling
  // this — never guess. Google's OWN consent screen still shows one checkbox
  // per item, so this does not remove their ability to grant only some of it;
  // it only removes clicking "connect" twice. Prefer the single-purpose tools
  // (start_calendar_connection etc.) when the user asked for only ONE.
  //
  // `mail` was the third member. It left the schema on 2026-09-07 and the
  // code on 2026-09-30 — `gmail.readonly` is a RESTRICTED scope and prices the
  // whole app into Google's paid verification track.
  tool('start_google_connection',
    'Connect several of the user\'s OWN Google services — calendar and contacts — in ONE link and ONE consent screen. ASK FIRST which they want (and, for calendar, view-only or also add/edit — never guess or reuse an earlier answer), then pass exactly those; at least one is required. Google still shows a checkbox per item, so they can decline any single one there.',
    {
      calendar_access: S('string', 'read_only | read_write, or omit entirely if they do not want calendar connected this time.'),
      contacts: S('boolean', 'true if they also want Google Contacts imported (read-only).'),
    }, [],
    (client, user, a) => googleConnect.beginConnection(client, user, {
      calendarAccess: a.calendar_access || null, wantContacts: a.contacts === true,
    })),
];
