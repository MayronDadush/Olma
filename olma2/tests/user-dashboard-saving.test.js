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
  assert.match(send, /\.catch\(function\(\)\{ (if\(!answered\)\{ )?API\.lost\(\);/,
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

// A re-read that lands in the middle of an edit draws the picture from BEFORE
// it: the title just typed goes back, a task just added leaves the list. And
// with the task sheet open, every control kept writing into a row that was no
// longer in the list, so the list behind the sheet showed the old copy.
function reloadBody() {
  const start = page.indexOf('    reload: function(done){');
  assert.ok(start > -1, 'API.reload moved — find it and point this test at it');
  return page.slice(start, page.indexOf('\n    },', start));
}

test('a re-read waits for every write on the wire', () => {
  const reload = reloadBody();
  assert.match(reload, /if\(writesInFlight > 0\)\{ reloadDeferred = true; return; \}/);
  assert.match(sendBody(), /writesInFlight\+\+; writeGen\+\+;/);
  assert.match(page, /writesInFlight--;\s*if\(writesInFlight === 0 && reloadDeferred\)\{ reloadDeferred = false; API\.reload\(\); \}/,
    'and the last write to settle is what runs it');
});

test('a re-read a write overtook is thrown away and asked again', () => {
  assert.match(reloadBody(), /if\(writeGen !== gen\)\{ API\.reload\(\); return; \}/);
});

test('every caller of reload is answered, even when its read was superseded', () => {
  // The pull-to-refresh spinner waited on a `done` that a newer read dropped.
  assert.match(reloadBody(), /if\(done\) reloadWaiting\.push\(done\);/);
  assert.match(reloadBody(), /flushReloadWaiting\(ok\);/);
  assert.match(page, /API\.reload\(function\(ok\)\{ if\(ok\) toast\(t\("news\.done"\)\); \}\);/,
    '"updated" is said only when the read actually landed');
});

test('a caller that throws in onOk is not reported as a write that failed', () => {
  assert.match(sendBody(), /\.catch\(function\(\)\{ if\(!answered\)\{ API\.lost\(\);/);
});

test('the task open in the sheet stays the object the list draws', () => {
  const at = page.indexOf('if(editing && !isNew && $("#sheet").classList.contains("show")){');
  assert.ok(at > -1, 'hydrate has to put the edited task back into `open`');
  assert.ok(at > page.indexOf('    lastSent = {};\n    open.forEach'),
    'after lastSent is seeded from the SERVER rows, or a failed edit would read as already sent');
  assert.ok(at < page.indexOf('    archived = (d.archived || []).map'), 'inside hydrate');
});
