'use strict';
// A write from the page that did not land must never look like one that did.
//
// Until 2026-10-06 API.send counted only an answer carrying `ok:false` as a
// failure. A 500 (the router answers one in plain text), a dropped connection
// and a request the phone killed when the app went to the background all
// reached the caller as an ordinary success: the row stayed drawn the way it
// was typed, "נשמר" had already flashed, and the change was gone at the next
// reload. The owner saw it as "changes sometimes don't save".
//
// Text assertions against the served file, like the rest of this page's suite;
// the behaviour behind each was driven in a browser against
// scripts/demo-dashboard.js with fetch failing on purpose.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const page = fs.readFileSync(
  path.join(__dirname, '..', 'docs', 'design', 'user-dashboard.html'), 'utf8');

function sendBody() {
  const start = page.indexOf('    send: function(action, payload, onOk, keepalive){');
  assert.ok(start > -1, 'API.send moved — find it and point this test at it');
  return page.slice(start, page.indexOf('\n    },', start));
}

test('success is a 2xx whose body says ok:true, and nothing else', () => {
  const send = sendBody();
  assert.match(send, /res\.status >= 200 && res\.status < 300 && b && b\.ok/,
    'a 500 or an unparseable body has to fall through to the lost branch');
  assert.match(send, /else \{ API\.lost\(\);/, 'and that branch has to say so');
  assert.match(send, /\.catch\(function\(\)\{ API\.lost\(\);/,
    'a request that never reached the server is lost too, not "offline: keep what it shows"');
  // A body that does not parse is not a success with no data.
  assert.doesNotMatch(send, /r\.json\(\)\.catch\(function\(\)\{ return null; \}\)/);
});

test('a lost write is said out loud and re-read, in both languages', () => {
  assert.match(page, /lost: function\(\)\{\s*toast\(t\("toast\.notSaved"\), null, true\);\s*API\.reload\(\);/);
  assert.match(page, /"toast\.notSaved":"השינוי לא נשמר\. אפשר לנסות שוב"/);
  assert.match(page, /"toast\.notSaved":"That change wasn't saved\. Please try again"/);
});

test('every small write survives the app going to the background', () => {
  assert.match(sendBody(), /keepalive:!!keepalive \|\| body\.length < KEEPALIVE_MAX/);
  const max = Number((page.match(/var KEEPALIVE_MAX = (\d+) \* 1024;/) || [])[1]);
  // The browser's budget is 64KB across every keepalive request in flight.
  assert.ok(max > 0 && max <= 16, 'leave room under the 64KB budget for several at once');
});

test('the title on its timer is flushed when the page is left, not only on blur', () => {
  assert.match(page, /window\.addEventListener\("pagehide", flushTitle\);/);
  assert.match(page, /addEventListener\("visibilitychange", function\(\)\{ if\(document\.hidden\) flushTitle\(\); \}\);/);
});

test('an edit that did not land is not remembered as sent', () => {
  // Otherwise typing the same value again sends nothing: "nothing moved".
  assert.match(page,
    /API\.send\("editTask", patch, function\(data, ok\)\{\s*if\(!ok && lastSent\[key\] === payload\) lastSent\[key\] = was;/);
});

test('an expired session asks for the page again instead of failing every tap', () => {
  assert.match(page, /if\(error && error\.code === "unauthorized"\)\{ location\.reload\(\); return; \}/);
});
