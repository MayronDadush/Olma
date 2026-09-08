'use strict';
// The personal dashboard over real HTTP, through the same server the operator
// page is served by. Mostly it tests what does NOT happen: what a link does on
// GET, what a signed-out request gets, and what the admin password does and
// does not open.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const { createDashboard } = require('../src/adapters/http/dashboard');
const auth = require('../src/domain/dashboard-auth');

let db, server, base, me;

before(async () => {
  db = await freshDb();
  me = await makeUser(db.pool, '+972531930001', { firstName: 'Miron' });
  await db.pool.query(`UPDATE users SET timezone = 'Asia/Jerusalem'`);
  server = createDashboard({ pool: db.pool, adminUser: 'admin', adminPass: 'test-password-123' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await db.teardown(); });

const get = (p, opts = {}) => fetch(base + p, { redirect: 'manual', ...opts });
const newToken = async () => {
  const r = await withTx(db.pool, (c) => auth.createLink(c, me.id));
  assert.equal(r.ok, true, r.ok ? '' : JSON.stringify(r.error));
  return r.data.token;
};
// The cookie the browser would send back. Set-Cookie carries Secure, which a
// real browser honours over HTTPS; the test server is plain http, so the value
// is read off the header rather than through a cookie jar.
const cookieFrom = (res) => String(res.headers.get('set-cookie') || '').split(';')[0];

async function signIn() {
  const token = await newToken();
  const res = await get('/d/' + token, { method: 'POST' });
  assert.equal(res.status, 303);
  return cookieFrom(res);
}

test('GET on a link shows a button and spends nothing — the crawler rule', async () => {
  const token = await newToken();
  const res = await get('/d/' + token);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Miron'), 'the page does not greet the person it is for');
  assert.ok(html.includes('method="POST"'), 'the button is not a POST, so a preview would spend the link');
  assert.equal(res.headers.get('set-cookie'), null, 'a GET opened a session');
  // Still usable: WhatsApp fetching it for a preview must not have burned it.
  const post = await get('/d/' + token, { method: 'POST' });
  assert.equal(post.status, 303, 'the link was spent by being looked at');
});

test('POST on a link opens a session and sends you to the page', async () => {
  const token = await newToken();
  const res = await get('/d/' + token, { method: 'POST' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/me');
  const setCookie = String(res.headers.get('set-cookie'));
  for (const bit of ['HttpOnly', 'Secure', 'SameSite=Lax']) {
    assert.ok(setCookie.includes(bit), `cookie missing ${bit}`);
  }
  const again = await get('/d/' + token, { method: 'POST' });
  assert.equal(again.status, 410, 'a spent link opened a second session');
});

test('an unknown or malformed link is a dead end, not a 500', async () => {
  for (const p of ['/d/' + 'f'.repeat(64), '/d/nothex', '/d/']) {
    const res = await get(p);
    assert.ok(res.status === 410 || res.status === 401 || res.status === 404,
      `${p} answered ${res.status}`);
  }
});

test('the page needs a session, and the admin password is not one', async () => {
  const anon = await get('/me');
  assert.equal(anon.status, 401);
  const anonHtml = await anon.text();
  // Somebody with no session gets the first screen — the two doors into a
  // conversation with her — not an error. It is still a 401: none of their
  // data is in it, and the stamp is the only thing that decides that.
  assert.match(anonHtml, /<html data-served="1" data-new="1">/,
    'an anonymous visitor was not handed the first screen');
  assert.ok(anonHtml.includes('w.hint'), 'that is not the dashboard file');
  assert.equal(anon.headers.get('content-type').includes('text/html'), true);

  const admin = await get('/me', {
    headers: { Authorization: 'Basic ' + Buffer.from('admin:test-password-123').toString('base64') },
  });
  assert.equal(admin.status, 401,
    'the operator password opened a private page it has no identity for');
});

test('a signed-in request gets the real page, and it is not indexable or cacheable', async () => {
  const cookie = await signIn();
  const res = await get('/me', { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control') || '', /no-store/);
  assert.match(res.headers.get('x-robots-tag') || '', /noindex/);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  const csp = res.headers.get('content-security-policy') || '';
  assert.match(csp, /connect-src 'self'/, 'a script on this page could ship the contents anywhere');
  assert.match(csp, /frame-ancestors 'none'/);
  const html = await res.text();
  assert.ok(html.length > 100_000 && html.includes('<title>'), 'that is not the dashboard');
});

test('the data endpoint answers only the person it belongs to', async () => {
  const anon = await get('/me/data');
  assert.equal(anon.status, 401);
  assert.equal((await anon.json()).error.code, 'unauthorized');
  assert.match(anon.headers.get('content-type') || '', /application\/json/,
    'the page fetches this — an HTML body reads as a parse error, not a 401');

  const cookie = await signIn();
  const res = await get('/me/data', { headers: { cookie } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(String(body.data.user.id), String(me.id));
  assert.equal(JSON.stringify(body).includes(me.phone), false, 'a phone number reached the browser');
});

test('a write needs a session, a POST, and an origin of ours', async () => {
  const cookie = await signIn();
  assert.equal((await get('/me/act', { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await get('/me/act', { method: 'GET', headers: { cookie } })).status, 405);

  const forged = await get('/me/act', {
    method: 'POST', headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'addTask', payload: { title: 'לא שלי' } }),
  });
  assert.equal(forged.status, 403, 'another origin wrote to this account');
});

test('a write lands, and comes back on the very next read', async () => {
  const cookie = await signIn();
  const res = await get('/me/act', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'addTask', payload: { title: 'לתקן את הדוד' } }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  const page = await (await get('/me/data', { headers: { cookie } })).json();
  assert.equal(page.data.tasks.some((t) => t.title === 'לתקן את הדוד'), true);
});

test('a refused write carries its reason and a status that agrees with it', async () => {
  const cookie = await signIn();
  const unknown = await get('/me/act', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'wipeEverything' }),
  });
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).error.code, 'invalid');

  const missing = await get('/me/act', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'completeTask', payload: { taskId: 99999 } }),
  });
  assert.equal(missing.status, 404);

  const junk = await get('/me/act', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: 'not json',
  });
  assert.equal(junk.status, 400);
});

test('signing out ends it, and the cookie goes with it', async () => {
  const cookie = await signIn();
  const out = await get('/me/out', { method: 'POST', headers: { cookie } });
  assert.equal(out.status, 303);
  assert.match(String(out.headers.get('set-cookie')), /Max-Age=0/);
  assert.equal((await get('/me/data', { headers: { cookie } })).status, 401);
});

test('a nearly-ours path falls through to the operator page, not to us', async () => {
  // /mesh and /me/x are not this router's business; answering them here would
  // quietly put a chunk of the admin surface behind the wrong identity model.
  for (const p of ['/mesh', '/me/x', '/medata']) {
    const res = await get(p);
    assert.equal(res.status, 401);
    assert.ok((res.headers.get('www-authenticate') || '').startsWith('Basic'),
      `${p} was answered by the personal dashboard`);
  }
});

test('the payload carries every field the page reads out of it', async () => {
  // The page and the server are one file apart and there is no type between
  // them, so this is the contract. Each name here is read by `hydrate()` in
  // docs/design/user-dashboard.html; renaming one on the server without
  // renaming it there produces a page that renders with a piece missing and no
  // error anywhere — the failure this list exists to turn into a red test.
  const tasks = require('../src/domain/tasks');
  const shares = require('../src/domain/shares');
  const connections = require('../src/domain/connections');
  const friend = await makeUser(db.pool, '+972531930002', { firstName: 'Gali' });

  const mine = await withTx(db.pool, (c) => tasks.addTask(c, me.id, { title: 'קניות' }));
  const req = await withTx(db.pool, (c) => connections.requestConnection(c, me.id, friend.phone));
  await withTx(db.pool, (c) =>
    connections.respondToConnection(c, friend.id, req.data.connection.id, 'approve'));
  const offer = await withTx(db.pool, (c) =>
    shares.offerShare(c, me.id, mine.data.task.id, friend.id, 'viewer'));
  await withTx(db.pool, (c) => shares.respondToShare(c, friend.id, offer.data.share.id, 'accept'));
  const done = await withTx(db.pool, (c) => tasks.addTask(c, me.id, { title: 'לחדש ביטוח' }));
  await withTx(db.pool, (c) => tasks.completeTask(c, me.id, done.data.task.id));
  await withTx(db.pool, (c) => tasks.archiveTask(c, me.id, done.data.task.id));

  const cookie = await signIn();
  const { data } = await (await get('/me/data', { headers: { cookie } })).json();

  for (const k of ['id', 'firstName', 'timezone', 'timezoneConfirmed', 'paused']) {
    assert.ok(k in data.user, `user.${k} is gone — the page reads it`);
  }
  const shared = data.tasks.find((t) => t.who.length);
  assert.ok(shared, 'no shared task came back');
  for (const k of ['id', 'title', 'category', 'date', 'time', 'allDay',
    'reminder', 'items', 'mine', 'owner', 'who', 'source', 'caps']) {
    assert.ok(k in shared, `task.${k} is gone — the page reads it`);
  }
  assert.ok('shareId' in shared.who[0], 'who[].shareId is gone — removing a person needs it');
  assert.ok('completedAt' in data.archived[0], 'archived[].completedAt is gone — the "when" is built from it');
  for (const k of ['id', 'connectionId', 'name', 'timezone', 'since', 'features']) {
    assert.ok(k in data.friends[0], `friend.${k} is gone — the page reads it`);
  }
  for (const k of ['provider', 'connected', 'needsReauth', 'access', 'account']) {
    assert.ok(k in (data.integrations[0] || { [k]: null }), `integration.${k} is gone`);
  }
});

test('the served page really is the one that knows how to hydrate', async () => {
  // Serving a copy that predates the wiring would produce a page showing seed
  // fixtures to a real person — the one outcome the hydration comment calls
  // out as worse than either extreme.
  const cookie = await signIn();
  const html = await (await get('/me', { headers: { cookie } })).text();
  assert.ok(html.includes('/me/data'), 'the served page never asks for any data');
  assert.ok(html.includes('/me/act'), 'the served page cannot write anything back');
});

// The file carries preview scaffolding — a language pair, a theme moon, and
// two buttons that replay the first visit — so the design can be checked in
// both languages, both themes and from a stranger's screen without reloading.
// None of it is product UI. The stamp on the root element is what removes it,
// and it has to be on the markup rather than applied by script: hiding them
// after hydrate() would show them for as long as the server takes to answer.
test('a served page is stamped, so the preview scaffolding never reaches anybody', async () => {
  const cookie = await signIn();
  const html = await (await get('/me', { headers: { cookie } })).text();
  assert.match(html, /^<html data-served="1" data-locale="he">/,
    'a served page was not stamped, so the preview buttons are live in production');
  // The stamp only means anything if the stylesheet still acts on it.
  assert.ok(html.includes('html[data-served] .langtog'),
    'nothing in the page hides the preview scaffolding on a served page');
  for (const id of ['langTog', 'themeTog', 'introTog', 'newTog']) {
    assert.ok(html.includes('html[data-served] .' + id.replace('Tog', '').toLowerCase() + 'tog'),
      `${id} is not covered by the rule that hides preview scaffolding`);
  }
  // And the one preview affordance with no button to hide asks for itself.
  assert.ok(html.includes('!document.documentElement.hasAttribute("data-served")'),
    'the language shortcut is not gated, so a stray L retranslates a real list');
});

// The groups section was designed and hidden whole, because nothing on the
// server kept a group and one made on this page was forgotten on reload. Since
// 2026-09-09 half of that is no longer true: the WhatsApp rooms Olma sits in
// arrive in the /me payload as groups that are already made. So the two halves
// part company — the LIST can show, the BUTTON still cannot, because a
// WhatsApp room is not something this page can create.
//
// The list stays hidden in CSS until `hydrate` puts `.live` on it. That is the
// half a `hidden = true` set after the fetch would get wrong: the three seeded
// design groups are in the markup, so hiding them from script shows a real
// person somebody else's example lists for as long as the server takes to
// answer.
test('a served page hides the groups it cannot keep, and shows the rooms it can', async () => {
  const cookie = await signIn();
  const html = await (await get('/me', { headers: { cookie } })).text();
  // The button that makes one is still gone on a served page, both ends checked
  // — the rule is worthless if it names a class the markup stopped carrying.
  assert.ok(html.includes('html[data-served] button.groupsblock'),
    'a served page still offers to make a group it cannot keep');
  assert.match(html, /class="addmini ghost groupsblock" id="addGroup"/,
    'the add-group button is not covered by the rule that hides it');
  // The list is hidden by the same stamp and re-shown only by hydrate, so the
  // seeded examples never reach a real person's screen.
  assert.ok(html.includes('html[data-served] .groupsblock:not(button){display:none}'),
    'the seeded design groups are visible on a served page before the fetch answers');
  assert.ok(html.includes('html[data-served] .groupsblock.live{display:block}'),
    'nothing can ever show the list again, so real rooms would never appear');
  assert.match(html, /<div style="--i:2" class="groupsblock">/,
    'the groups section no longer carries the class both rules name');
  assert.match(html, /classList\.toggle\("live", GROUPS\.length > 0\)/,
    'hydrate no longer turns the list on, so the rooms arrive and stay hidden');
  // And the seed is still there for the design copy — this hides it, it does
  // not delete the work.
  assert.ok(html.includes('\u05e4\u05d5\u05e7\u05e8'), 'the seeded groups were deleted rather than hidden');
});

// Two of the three permission rows on a connected person carry a "+", and each
// one opens the thing its own switch is for with that person already on it.
// The rule the pair has to keep is that the button never outlives the grant
// beside it: both end at a domain call that asks `requireFeatureBetween` for
// exactly the feature the switch holds (`sharing`, `meetings`), so a "+" on a
// row that is switched off would be an offer the server refuses. Checked on
// the SERVED page rather than the file on disk, because this is the copy a
// person actually presses.
test('a permission that has a screen behind it offers to open it, and only while granted', async () => {
  const cookie = await signIn();
  const html = await (await get('/me', { headers: { cookie } })).text();
  // Both rows, and only these two — `msg` is something you ask her for in
  // words, and there is no screen to send anyone to.
  assert.match(html, /tasks:\{attr:"newshared", label:"fr\.newTask"\}/,
    'the shared-task "+" is no longer declared on the tasks row');
  assert.match(html, /meet: \{attr:"newmeet",\s+label:"fr\.newMeet"\}/,
    'the coordination "+" is no longer declared on the meet row');
  assert.ok(!/msg:\s*\{attr:/.test(html), 'the message row grew a "+" with nothing behind it');
  // Rendered hidden unless the grant is on, and revealed by the same switch.
  assert.ok(html.includes('(f.p[k] ? "" : " hidden")'),
    'the "+" no longer follows the grant on its own row');
  assert.ok(html.includes('if(pact) refreshPermAction(pact.attr, f.id, on);'),
    'flipping a permission no longer opens or shuts the button beside it');
  // And what the coordination one does: the other screen, in the mode that
  // owns coordinations, with the person already picked and nothing started.
  assert.ok(html.includes('startMeetingWith(+nm.dataset.newmeet)'),
    'nothing handles a press on the coordination "+"');
  assert.match(html, /go\("cal"\);\s*\n\s*setCalMode\("meet"\);\s*\n\s*openMtNew\(\[fid\]\);/,
    'the coordination "+" no longer lands on the meetings screen with that person on it');
});

// The page draws in whatever `data-locale` the root element carries and falls
// back to Hebrew without one. For a signed-in person that attribute IS the
// language decision, and until 2026-09-07 nothing set it: Sarah's row said
// `en`, the JSON the page fetched said `en`, and the page — which never reads
// the JSON for this — rendered Hebrew. Same for the sign-in page in front of it.
test('a signed-in page and its sign-in page speak the language on file', async () => {
  const sarah = await makeUser(db.pool, '+972531930003', { firstName: 'Sarah', locale: 'en' });
  const link = await withTx(db.pool, (c) => auth.createLink(c, sarah.id));
  assert.equal(link.ok, true);

  const front = await (await get('/d/' + link.data.token)).text();
  assert.match(front, /<html dir="ltr" lang="en">/, 'the sign-in page for an English user is not English');
  assert.ok(front.includes('Hi Sarah'), 'the sign-in page greeted her in the wrong language');
  assert.ok(!/שלום|כניסה/.test(front), 'Hebrew copy survived on an English sign-in page');

  const opened = await get('/d/' + link.data.token, { method: 'POST' });
  assert.equal(opened.status, 303);
  const html = await (await get('/me', { headers: { cookie: cookieFrom(opened) } })).text();
  assert.match(html, /^<html data-served="1" data-locale="en">/,
    'an English user was served a page with no language on it, which the page reads as Hebrew');

  // And the house language is still the default for someone with nothing on
  // file — the Hebrew user above (no locale set) gets `he`, and so does the
  // sign-in page in front of them.
  const heFront = await (await get('/d/' + await newToken())).text();
  assert.match(heFront, /<html dir="rtl" lang="he">/);
  assert.ok(heFront.includes('שלום Miron'));
});
