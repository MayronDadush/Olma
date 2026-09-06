'use strict';
// The tool schemas are injected into every turn, for every user, before a
// single word of the conversation — the largest fixed cost per message after
// the doctrine, and the one nothing reconciled. On 2026-09-05 the JSON stood
// at 57,993 chars; the ten longest descriptions alone were 8,259 of that, and
// the identity parameter's sentence was paid 86 times over. This file is the
// ceiling: a description that grows back, or a tool added with a paragraph
// for a description, fails here and has to be paid for by trimming another —
// the same rule tests/intake.test.js enforces on the doctrine.
//
// The numbers are the measurement after that trim plus a little room, not a
// target. Raising them is allowed; doing it without noticing is not.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toolDefinitions } = require('../src/adapters/mcp/registry');
const { IDENTITY_PARAM } = require('../src/adapters/mcp/identity-param');

// Raised once, deliberately, on 2026-09-06: 55,000 -> 55,500, to fit the 89th
// tool. `settle_meeting` is the sentence half of the settle button the owner
// asked for, and without it the meeting can be ended from the page and not
// from a conversation — the exact shape of bug this project keeps finding
// ("the agent understood, and the outcome had nowhere to go"). Its own
// description was trimmed to 339 chars first; what is left is the floor cost
// of any tool at all — name, schema, and the identity parameter every tool
// carries. The four descriptions long enough to pay for it are each a
// compressed incident, so the cost was taken here in the open instead.
//
// It was NOT raised a second time the same day. Descriptions elsewhere grew
// 135 chars while that branch was open and put the surface at 55,570; rather
// than move the line again for growth that was not its own, `settle_meeting`
// was cut 339 -> 261. **Read this before your next trim:** most of that came
// out of the Hebrew, because JSON escapes every Hebrew character as \uXXXX
// and each one costs SIX. A Hebrew example is the most expensive sentence in
// any description here and the cheapest place to find room.
//
// The surface now stands at 55,492 — a margin of EIGHT. The next tool, or the
// next sentence added to a description, goes red, and a twenty-character
// shave will not save it. That is the ceiling doing its job: what is left to
// cut are the compressed incidents, so the next person should expect to argue
// for raising this deliberately rather than to find easy fat.
const JSON_CEILING = 55_500;
const DESCRIPTION_CEILING = 700;
const IDENTITY_DESCRIPTION_CEILING = 40;

test('the whole tool surface stays under its ceiling', () => {
  const defs = toolDefinitions();
  const json = JSON.stringify(defs).length;
  assert.ok(json <= JSON_CEILING,
    `tool schemas are ${json} chars, over the ${JSON_CEILING} ceiling — trim a description rather than raise this`);
});

test('no single tool description is a paragraph', () => {
  const over = toolDefinitions()
    .filter((d) => d.description.length > DESCRIPTION_CEILING)
    .map((d) => `${d.name}:${d.description.length}`);
  assert.deepEqual(over, [],
    `over ${DESCRIPTION_CEILING} chars: ${over.join(', ')} — put result-handling guidance in the RESULT, not the description`);
});

test('the identity parameter is described in a few words, because it is repeated on every schema', () => {
  const defs = toolDefinitions();
  for (const d of defs) {
    const p = d.inputSchema.properties[IDENTITY_PARAM];
    assert.ok(p, `${d.name} carries the identity parameter`);
    assert.ok(p.description.length <= IDENTITY_DESCRIPTION_CEILING,
      `${d.name}: identity description is ${p.description.length} chars, x${defs.length} schemas`);
  }
});

// The guidance that left the descriptions has to have landed somewhere the
// model still sees it: on the result, on the turns it applies to.
test('turn_start explains its optional fields on the result, not in the description', () => {
  // The hints are built by domain/turn.turnHints — shared since Phase B by
  // turn_start's result and by the Turn context the gateway plugin prepends
  // — so it is the function that is asserted on, not a file.
  const { turnHints } = require('../src/domain/turn');
  const all = turnHints({
    offerResume: true, recentReminders: [{ title: 'x' }], planHeadline: 'y',
    languageNudge: { theyWriteIn: 'en' }, replyTarget: true, genderForms: 'feminine',
  }).hints;
  for (const field of ['offerResume', 'recentReminders', 'planHeadline', 'languageNudge', 'replyTarget', 'genderForms']) {
    assert.equal(typeof all[field], 'string', `a hint is built for ${field}`);
  }
  assert.deepEqual(turnHints({}), {}, 'and nothing is said when nothing applies');
  const turnStart = toolDefinitions().find((d) => d.name === 'turn_start');
  assert.match(turnStart.description, /hints/, 'and the description points at hints');
});
