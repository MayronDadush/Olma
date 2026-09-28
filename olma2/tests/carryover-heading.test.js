'use strict';
// The heading provisioning writes into USER.md is the same heading the leak
// detector and its repair look for. They used to be separate copies of one
// Hebrew sentence, and a reader that cannot find the heading skips the card
// in silence — so rewording it in one place would have switched the leak
// check off while it went on reading green.
// helpers first: it sets OLMA_IMMUTABLE_IDENTITY=off before provision loads.
// Without it seedWorkspace chattr +i's the fixture, which only bites as root —
// on the box, inside deploy.sh — where the rmSync below then fails EPERM.
require('./helpers');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const heading = require('../src/domain/carryover-heading');
const { seedWorkspace } = require('../src/intake/provision');
const repair = require('../src/domain/carryover-repair');

test('the heading provisioning writes is one the readers can find', () => {
  assert.ok(heading.HEADING.startsWith(heading.MATCH),
    'a new TITLE must still start with MATCH, or every reader goes blind');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'olma-carryover-'));
  try {
    seedWorkspace(workspace, { firstName: 'X', identityToken: 't', firstMessage: 'לקנות חלב' });
    const card = fs.readFileSync(path.join(workspace, 'USER.md'), 'utf8');
    assert.ok(card.includes(heading.HEADING));
    // Both readers, through what they actually do with it.
    assert.notEqual(repair.classify(card, 'לקנות חלב').verdict, 'clean', 'the repair sees the section');
    assert.notEqual(repair.stripCarryover(card), null, 'and can cut it');
    assert.equal(repair.CARRYOVER_HEADING, heading.MATCH);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('the leak detector reads the same constant, not a copy', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/jobs/config-guard.js'), 'utf8');
  assert.match(src, /require\('\.\.\/domain\/carryover-heading'\)\.MATCH/);
  assert.doesNotMatch(src, /'## מה שכבר שיתפו/, 'no second copy of the heading');
});

test('the doctrine names the section by the title provisioning writes', () => {
  const tpl = fs.readFileSync(path.join(__dirname, '../src/intake/agents-template.md'), 'utf8');
  assert.ok(tpl.includes(heading.TITLE),
    'agents-template.md tells the model to look under this heading; reword both or neither');
});
