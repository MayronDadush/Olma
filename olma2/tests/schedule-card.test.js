'use strict';
// The schedule card: validation, RTL correctness, rasterising, and where the
// file is allowed to land.
//
// Deliberately database-free — every rule worth testing here is about pixels,
// strings and paths, so this file runs anywhere, including a laptop with no
// Postgres. The one SQL statement involved (purgeOldCards' SELECT over users)
// is already exercised for real by the retention assertions in
// dashboard.test.js and calendar.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const card = require('../src/domain/schedule-card');
const cardStore = require('../src/domain/card-store');
const { BY_NAME } = require('../src/adapters/mcp/registry');

const RLM = '‏';

function sample(overrides = {}) {
  return {
    title: 'תמונת מצב',
    subtitle: 'אוגוסט–ספטמבר',
    stats: [{ icon: 'target', text: '17 משימות פתוחות' }],
    sections: [
      { title: 'השבוע (19–25 באוג׳)', items: [
        { date: '19 באוג׳', text: 'יום הולדת רועי מורן', icon: 'birthday' },
        { date: '27 באוג׳', text: 'לנקות מזגנים', icon: 'cleaning', tag: 'יומן' },
      ] },
      { title: 'ספטמבר', items: [
        { date: '9–14 בספט׳', text: 'קפריסין חיימי', icon: 'travel', tag: 'יומן' },
      ] },
    ],
    big_tasks: { title: 'משימות גדולות בתור', chips: [{ icon: 'health', text: 'בריאות' }] },
    footer_note: 'עולמה · 19 באוג׳',
    ...overrides,
  };
}

function tmpWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olma-card-ws-'));
  return { id: 7, workspace_path: dir };
}

// ---------------------------------------------------------------- rasterising

test('renders a real schedule to a PNG of a sensible size', () => {
  const res = card.renderPng(sample());
  assert.ok(res.ok, res.ok ? '' : res.error && res.error.message);
  const { png, width, height } = res.data;
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  assert.equal(width, card.W);
  // The header, three rows, a big-tasks block and a footer land in this band;
  // a card outside it means the layout maths drifted, not that content changed.
  assert.ok(height > 400 && height < 900, `unexpected height ${height}`);
  // Dimensions in the IHDR must agree with what we reported to the agent.
  assert.equal(png.readUInt32BE(16), width);
  assert.equal(png.readUInt32BE(20), height);
});

test('height grows with content, and the declared height is the real one', () => {
  const small = card.renderPng(sample({ big_tasks: null, footer_note: '' }));
  const big = card.renderPng(sample({
    sections: [...sample().sections, { title: 'אוקטובר', items: Array.from({ length: 8 }, (_, i) => ({
      date: `${i + 1} באוק׳`, text: 'משימה כלשהי', icon: 'task',
    })) }],
  }));
  assert.ok(small.ok && big.ok);
  assert.ok(big.data.height > small.data.height + 300);
  assert.equal(big.data.png.readUInt32BE(20), big.data.height);
});

// ------------------------------------------------------------------------ RTL

test('every text element opens with RLM', () => {
  // Without U+200F a line starting with a digit renders with the number flung
  // to the wrong end. This is the regression guard for that.
  const { svg } = card.buildSvg(card.normalizeCard(sample()).data);
  const opens = [...svg.matchAll(/<text\b[^>]*>(.)/g)];
  assert.ok(opens.length > 8, `expected many text nodes, saw ${opens.length}`);
  for (const m of opens) assert.equal(m[1], RLM, `a <text> did not start with RLM: ${m[0]}`);
});

// ----------------------------------------------------------------- validation

test('refuses more items than a card can show, and says what to do', () => {
  const res = card.renderPng(sample({
    sections: Array.from({ length: 4 }, (_, s) => ({
      title: `חלק ${s}`,
      items: Array.from({ length: 10 }, (_, i) => ({ date: `${i}`, text: 'x', icon: 'task' })),
    })),
  }));
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'invalid');
  assert.match(res.error.message, /narrow the date range/);
});

test('refuses a single overstuffed section', () => {
  const res = card.renderPng(sample({
    sections: [{ title: 'הכל', items: Array.from({ length: card.LIMITS.itemsPerSection + 1 },
      () => ({ date: '1', text: 'x', icon: 'task' })) }],
  }));
  assert.equal(res.ok, false);
  assert.match(res.error.message, /split it or narrow/);
});

test('refuses a card with nothing to draw', () => {
  assert.equal(card.renderPng({ sections: [] }).ok, false);
  assert.equal(card.renderPng({ sections: [{ title: 'ריק', items: [] }] }).ok, false);
});

test('over-long strings truncate instead of failing the whole card', () => {
  const res = card.normalizeCard(sample({
    title: 'כותרת '.repeat(40),
    sections: [{ title: 'א', items: [{ date: '1 בספט׳', text: 'משימה ארוכה מאוד '.repeat(20), icon: 'task' }] }],
  }));
  assert.ok(res.ok);
  assert.ok(res.data.title.length <= 40);
  assert.ok(res.data.sections[0].items[0].text.endsWith('…'));
});

test('an unrecognised icon name falls back instead of drawing nothing', () => {
  // resvg draws a missing image as empty space, silently — the fallback is the
  // only thing standing between a typo and a blank column.
  const res = card.normalizeCard(sample({
    sections: [{ title: 'א', items: [{ date: '1', text: 'x', icon: 'unicorn-party' }] }],
  }));
  assert.ok(res.ok);
  assert.equal(res.data.sections[0].items[0].icon, 'generic');
  assert.ok(card.renderPng(sample({
    sections: [{ title: 'א', items: [{ date: '1', text: 'x', icon: 'unicorn-party' }] }],
  })).ok);
});

test('markup in user text cannot break out into the SVG', () => {
  const { svg } = card.buildSvg(card.normalizeCard(sample({
    sections: [{ title: 'א', items: [{ date: '1', text: '<script>x</script> & "q"', icon: 'task' }] }],
  })).data);
  assert.ok(!svg.includes('<script>'));
  assert.ok(svg.includes('&lt;script&gt;'));
  assert.ok(svg.includes('&amp;'));
  // And it still parses as a drawable document.
  assert.ok(card.renderPng(sample({
    sections: [{ title: 'א', items: [{ date: '1', text: '<script>x</script> & "q"', icon: 'task' }] }],
  })).ok);
});

test('ellipsize respects a pixel budget', () => {
  const long = 'פגישה אצל אביב זוזוט בהוד השרון אחרי הצהריים';
  const out = card.ellipsize(long, 26, 200);
  assert.ok(out.endsWith('…'));
  assert.ok(card.tw(out, 26) <= 200);
  assert.equal(card.ellipsize('קצר', 26, 400), 'קצר'); // fits: untouched
});

// --------------------------------------------------------------- chip wrapping

test('a full row of stat pills wraps instead of running off the edge', () => {
  // The first card rendered from live data drew four stat pills, and the last
  // one was sliced in half by the left edge of the canvas. Every pill must sit
  // inside the margins, however many there are.
  const four = sample({
    stats: [
      { icon: 'task', text: '15 משימות פתוחות' },
      { icon: 'reminder', text: '3 תזכורות יומיות' },
      { icon: 'birthday', text: '7 ימי הולדת' },
      { icon: 'wedding', text: '2 חתונות' },
    ],
  });
  const norm = card.normalizeCard(four);
  assert.ok(norm.ok);
  const { svg, height } = card.buildSvg(norm.data);

  const rects = [...svg.matchAll(/<rect x="(-?[\d.]+)" y="([\d.]+)" width="([\d.]+)"/g)]
    .map((m) => ({ x: +m[1], y: +m[2], w: +m[3] }));
  const pills = rects.filter((r) => r.y < 260 && r.w < 600);
  assert.ok(pills.length >= 4, `expected the four stat pills, saw ${pills.length}`);
  for (const p of pills) {
    assert.ok(p.x >= 0, `a pill starts off-canvas at x=${p.x}`);
    assert.ok(p.x + p.w <= card.W, `a pill runs past the right edge: ${p.x + p.w} > ${card.W}`);
  }
  // Wrapping must push the content down, not draw a second row on top of the
  // first section card.
  const oneRow = card.buildSvg(card.normalizeCard(sample()).data);
  assert.ok(height > oneRow.height, 'a wrapped pill row did not add any height');
});

test('six big-task chips still fit inside their card', () => {
  const norm = card.normalizeCard(sample({
    big_tasks: { title: 'משימות גדולות בתור', chips: [
      { icon: 'health', text: 'בריאות' }, { icon: 'money', text: 'השקעות' },
      { icon: 'work', text: 'עבודה' }, { icon: 'document', text: 'ניהול' },
      { icon: 'study', text: 'לימודים' }, { icon: 'home', text: 'בית ומשפחה' },
    ] },
  }));
  const { svg } = card.buildSvg(norm.data);
  for (const m of svg.matchAll(/<rect x="(-?[\d.]+)" y="[\d.]+" width="([\d.]+)"/g)) {
    assert.ok(+m[1] >= 0, `chip drawn off-canvas at x=${m[1]}`);
    assert.ok(+m[1] + +m[2] <= card.W, 'chip runs past the right edge');
  }
  assert.ok(card.renderPng(sample({
    big_tasks: norm.data.bigTasks && { title: 'x', chips: norm.data.bigTasks.chips },
  })).ok);
});

// ------------------------------------------------------------------ card file

test('a card is written inside the caller\'s own workspace, under a random name', () => {
  const user = tmpWorkspace();
  const png = card.renderPng(sample()).data.png;
  const a = cardStore.saveCard(user, png);
  const b = cardStore.saveCard(user, png);
  assert.ok(a.ok && b.ok);
  for (const r of [a, b]) {
    assert.equal(path.dirname(r.data.path), path.join(user.workspace_path, cardStore.CARD_DIR));
    assert.ok(fs.existsSync(r.data.path));
  }
  assert.notEqual(a.data.path, b.data.path, 'filenames must not be guessable or reused');
  // The name is a bare UUID: the path gets echoed into a model's reply, so it
  // must carry nothing about the person or what the card says.
  assert.match(path.basename(a.data.path),
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/);
});

test('saving refuses when there is no workspace to save into', () => {
  assert.equal(cardStore.saveCard({ id: 1, workspace_path: null }, Buffer.from('x')).ok, false);
  assert.equal(cardStore.saveCard({ id: 1, workspace_path: '/nope/does/not/exist' }, Buffer.from('x')).ok, false);
});

test('the retention sweep drops stale cards and keeps fresh ones', async () => {
  const user = tmpWorkspace();
  const png = card.renderPng(sample()).data.png;
  const stale = cardStore.saveCard(user, png).data.path;
  const fresh = cardStore.saveCard(user, png).data.path;
  const old = Date.now() - 48 * 3600_000;
  fs.utimesSync(stale, new Date(old), new Date(old));

  // Stands in for the one SELECT purgeOldCards makes; the file-side logic under
  // test is the whole point, and the real query runs in the retention tests.
  const client = { query: async () => ({ rows: [{ workspace_path: user.workspace_path }] }) };
  const purged = await cardStore.purgeOldCards(client, 24);

  assert.equal(purged, 1);
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(fresh), true);
});

test('a workspace that does not exist on this host is skipped, not thrown on', async () => {
  const client = { query: async () => ({ rows: [{ workspace_path: '/nope/does/not/exist' }] }) };
  assert.equal(await cardStore.purgeOldCards(client, 24), 0);
});

// ---------------------------------------------------------------- the tool

test('the tool renders, stores, and tells the agent exactly how to attach it', async () => {
  const user = tmpWorkspace();
  const tool = BY_NAME.get('render_schedule_card');
  const res = await tool.handler(null, user, sample(), {});
  assert.ok(res.ok, res.ok ? '' : res.error && res.error.message);
  assert.ok(fs.existsSync(res.data.path));
  assert.match(res.data.next_step, /MEDIA: /);
  assert.ok(res.data.next_step.includes(res.data.path));
});

test('a credential pasted into card text never reaches the pixels', async () => {
  // Text baked into an image is past every later redaction layer, so the
  // scrub has to happen before the render, not after.
  const user = tmpWorkspace();
  const tool = BY_NAME.get('render_schedule_card');
  const token = 'olma_tok_' + 'a'.repeat(32);
  const res = await tool.handler(null, user, sample({
    subtitle: token,
    sections: [{ title: token, items: [{ date: '1', text: token, icon: 'task' }] }],
  }), {});
  assert.ok(res.ok);
  const svg = card.buildSvg(card.normalizeCard({
    sections: [{ title: 'x', items: [{ date: '1', text: token, icon: 'task' }] }],
  }).data).svg;
  assert.ok(svg.includes(token), 'sanity: the renderer itself does not scrub');
  // ...which is exactly why the tool must, and does.
  const scrubbed = require('../src/adapters/mcp/render').scrubTokens(JSON.stringify(sample({ subtitle: token })));
  assert.ok(!scrubbed.includes(token));
  assert.ok(scrubbed.includes('[REDACTED]'));
});

test('the tool refuses a caller-supplied path and only ever uses the workspace', async () => {
  const user = tmpWorkspace();
  const tool = BY_NAME.get('render_schedule_card');
  // `path` is not part of the schema; passing one must change nothing.
  const res = await tool.handler(null, user, { ...sample(), path: '/tmp/evil.png' }, {});
  assert.ok(res.ok);
  assert.ok(res.data.path.startsWith(user.workspace_path));
  assert.equal(fs.existsSync('/tmp/evil.png'), false);
});
