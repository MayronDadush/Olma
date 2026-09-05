'use strict';
// combined connect — one slice of the tool registry (see ../registry.js).
const {
  calendar, mail, googleConnect, contacts, S, tool,
} = require('./_shared');

module.exports = [
  // One link for calendar + contacts + mail together, instead of three. ASK
  // the user which of the three they want (and, if calendar, which access
  // level) before calling this — never guess. Google's OWN consent screen
  // still shows one checkbox per item, so this does not remove their ability
  // to grant only some of it; it only removes clicking "connect" three times.
  // Prefer the single-purpose tools below (start_calendar_connection etc.)
  // when the user asked for only ONE of the three.
  tool('start_google_connection',
    'Connect several of the user\'s OWN Google services — calendar, contacts, mail — in ONE link and ONE consent screen, instead of separate links for each. ASK FIRST which they want (and, if calendar, view-only or also add/edit — never guess or reuse an earlier answer), then pass exactly those. At least one of calendar_access / contacts / mail is required. Returns one link; Google still shows a checkbox per item so they can decline any single one there too.',
    {
      calendar_access: S('string', 'read_only | read_write, or omit entirely if they do not want calendar connected this time.'),
      contacts: S('boolean', 'true if they also want Google Contacts imported (read-only).'),
      mail: S('boolean', 'true if they also want their Gmail connected (read-only).'),
    }, [],
    (client, user, a) => googleConnect.beginConnection(client, user, {
      calendarAccess: a.calendar_access || null, wantContacts: a.contacts === true, wantMail: a.mail === true,
    })),
];
