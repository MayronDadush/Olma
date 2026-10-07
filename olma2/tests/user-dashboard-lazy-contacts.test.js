'use strict';
// The address book is read when the contacts sheet opens, never on every read
// of the page.
//
// Until 2026-10-08 every /me/data carried the whole book — 217KB of 318KB for
// the owner, on the first open, every pull-to-refresh, every re-read after a
// write and every meeting poll that found news. It is used in one sheet.
//
// Text assertions against the served file and the route, like the rest of this
// page's suite; the behaviour was driven in a browser against
// scripts/demo-dashboard.js with 2,799 contacts, a failing fetch and an invite.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const page = fs.readFileSync(path.join(root, 'docs', 'design', 'user-dashboard.html'), 'utf8');
const domain = fs.readFileSync(path.join(root, 'src', 'domain', 'user-dashboard.js'), 'utf8');
const route = fs.readFileSync(path.join(root, 'src', 'adapters', 'http', 'user-dashboard.js'), 'utf8');

test('the page read no longer carries the address book', () => {
  const start = domain.indexOf('async function load(');
  assert.ok(start > -1, 'load moved — point this test at it');
  const body = domain.slice(start, domain.indexOf('\n}\n', start));
  assert.doesNotMatch(body, /loadContacts\(/, 'contacts belong to contactsPage only');
  assert.match(domain, /async function contactsPage\(client, userId\) \{[\s\S]{0,200}loadContacts\(client, userId\)/);
  assert.match(domain, /module\.exports = \{[^}]*\bcontactsPage\b/);
});

test('the book has its own read, on the path Caddy already passes', () => {
  assert.match(route, /searchParams\.get\('part'\) === 'contacts'/);
  assert.match(route, /dash\.contactsPage\(c, userId\)/);
});

test('the sheet asks for the book when it opens, and says when it is waiting or failed', () => {
  assert.match(page, /function openContacts\(\)\{[^}]*loadContacts\(\);/);
  assert.match(page, /fetch\("\/me\/data\?part=contacts"/);
  // A sheet already drawn keeps its rows while a fresh copy is read.
  assert.match(page, /if\(contactsState !== "ready"\) contactsState = "loading";/);
  assert.match(page, /"cn\.loading":"רק רגע, טוענים את אנשי הקשר…"/);
  assert.match(page, /"cn\.loadFailed":"לא הצלחנו לטעון את אנשי הקשר כרגע\. אפשר לסגור ולפתוח שוב\."/);
  assert.match(page, /"cn\.loading":"One moment — loading your contacts…"/);
  assert.match(page, /"cn\.loadFailed":"We could not load your contacts just now\. Close this and open it again\."/);
});

test('a page read without contacts does not wipe a book already loaded', () => {
  assert.match(page, /if\(d\.contacts\)\{ setContacts\(d\.contacts\); \}/);
});
