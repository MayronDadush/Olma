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

const JSON_CEILING = 55_000;
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
  // The registry, plus any per-domain tool files a later split moves the
  // handlers into (src/adapters/mcp/tools/*.js) — the hints must exist
  // somewhere the registry assembles from, not in one particular file.
  const fs = require('node:fs'); const path = require('node:path');
  const dir = path.join(__dirname, '..', 'src', 'adapters', 'mcp');
  const files = [path.join(dir, 'registry.js')];
  const toolsDir = path.join(dir, 'tools');
  if (fs.existsSync(toolsDir)) for (const f of fs.readdirSync(toolsDir)) if (f.endsWith('.js')) files.push(path.join(toolsDir, f));
  const src = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  for (const field of ['offerResume', 'recentReminders', 'planHeadline', 'languageNudge', 'replyTarget', 'genderForms']) {
    assert.match(src, new RegExp(`hints\\.${field} = `), `a hint is built for ${field}`);
  }
  const turnStart = toolDefinitions().find((d) => d.name === 'turn_start');
  assert.match(turnStart.description, /hints/, 'and the description points at hints');
});
