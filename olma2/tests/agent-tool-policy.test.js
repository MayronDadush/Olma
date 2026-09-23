'use strict';
// Which of our tools each agent is shown (src/intake/agent-tool-policy.js).
// Pure: a parsed config in, a config out, no database and no gateway.
//
// The number this protects, measured on the live g-7 agent on 2026-09-23 with
// one probe turn either side: 27,337 input tokens a turn shown every tool,
// 11,625 shown its six. The failure it must never allow is the other
// direction — an agent denied a tool it needs — so the audiences are asserted
// to be disjoint and to cover the registry, and a room is asserted to keep
// every group tool.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const occ = require('../src/intake/openclaw-config');
const policy = require('../src/intake/agent-tool-policy');
const { TOOLS, audienceOf, toolDefinitions } = require('../src/adapters/mcp/registry');

function cfg() {
  return {
    agents: { entries: { main: { name: 'main' }, intake: { name: 'intake' } } },
    mcp: { servers: { olma: { command: 'node', args: ['/opt/olma2/bin/olma-mcp.js'] } } },
  };
}

const names = (aud) => TOOLS.filter((t) => audienceOf(t) === aud).map((t) => `olma__${t.name}`).sort();

test('a room is shown exactly the group tools, a person exactly the rest', () => {
  const c = cfg();
  const room = policy.agentToolPolicy('g-7', c);
  const person = policy.agentToolPolicy('u-3', c);
  assert.deepEqual(room.deny, names('user'), 'a room denies every person tool and nothing else');
  assert.deepEqual(person.deny, names('group'), 'a person denies every room tool and nothing else');
  // Symmetry: together the two deny lists name every tool exactly once, so a
  // tool added to either side lands in the other side's list automatically.
  assert.equal(room.deny.length + person.deny.length, TOOLS.length);
  assert.equal(new Set([...room.deny, ...person.deny]).size, TOOLS.length);
  // The direction that would break a room: it keeps every one of its tools.
  for (const t of toolDefinitions({ audience: 'group' })) {
    assert.ok(!room.deny.includes(`olma__${t.name}`), `${t.name} is a room's own tool`);
  }
  assert.ok(names('group').length > 0 && names('user').length > 0);
});

test('agents that are not a person or a room are never narrowed', () => {
  for (const id of ['main', 'intake', 'ggreet', 'u-', 'g-x', 'u-3-old']) {
    assert.equal(policy.agentToolPolicy(id, cfg()), null, id);
  }
});

test('the prefix is the registered server name, and an unknown server writes nothing', () => {
  const c = cfg();
  c.mcp.servers = { other: { command: 'x' }, mine: { command: 'node', args: ['/opt/olma2/bin/olma-mcp.js'] } };
  assert.ok(policy.agentToolPolicy('g-1', c).deny.every((n) => n.startsWith('mine__')));
  // A deny under the wrong prefix would hide nothing and look like it worked.
  c.mcp.servers = { a: {}, b: {} };
  assert.equal(policy.agentToolPolicy('g-1', c), null);
  delete c.mcp;
  assert.equal(policy.agentToolPolicy('g-1', c), null);
});

test('addAgent writes the policy itself, in both roster formats', () => {
  const c = cfg();
  occ.addAgent(c, { id: 'g-9', workspace: '/w', agentDir: '/a' });
  assert.deepEqual(c.agents.entries['g-9'].tools.deny, names('user'));
  occ.addAgent(c, { id: 'intake2', workspace: '/w', agentDir: '/a' });
  assert.equal(c.agents.entries.intake2.tools, undefined, 'a non-person agent gets no tools key');
  occ.addAgent(c, { id: 'u-10', workspace: '/w', agentDir: '/a', tools: null });
  assert.equal(c.agents.entries['u-10'].tools, undefined, 'null overrides');

  const legacy = { agents: { list: [] }, mcp: cfg().mcp };
  occ.addAgent(legacy, { id: 'u-5', workspace: '/w', agentDir: '/a' });
  assert.deepEqual(legacy.agents.list[0].tools.deny, names('group'));
});

test('setAgentTools changes only deny, reports change honestly, and removes cleanly', () => {
  const c = cfg();
  c.agents.entries['g-2'] = { name: 'g-2', tools: { codeMode: { enabled: false } } };
  const p = policy.agentToolPolicy('g-2', c);
  assert.equal(occ.setAgentTools(c, 'g-2', p), true);
  assert.deepEqual(c.agents.entries['g-2'].tools.codeMode, { enabled: false }, 'other keys survive');
  assert.equal(occ.setAgentTools(c, 'g-2', p), false, 'an unchanged policy is not a change');
  assert.equal(policy.policyMatches(c.agents.entries['g-2'], p), true);
  assert.equal(occ.setAgentTools(c, 'g-2', null), true);
  assert.deepEqual(c.agents.entries['g-2'].tools, { codeMode: { enabled: false } });
  c.agents.entries['g-3'] = { name: 'g-3', tools: { deny: ['x'] } };
  occ.setAgentTools(c, 'g-3', null);
  assert.equal(c.agents.entries['g-3'].tools, undefined, 'an empty tools block is removed, not left as {}');
  assert.equal(occ.setAgentTools(c, 'nobody', p), false);
});

test('policyMatches ignores order but not content', () => {
  const p = { deny: ['olma__a', 'olma__b'] };
  assert.equal(policy.policyMatches({ tools: { deny: ['olma__b', 'olma__a'] } }, p), true);
  assert.equal(policy.policyMatches({ tools: { deny: ['olma__a'] } }, p), false);
  assert.equal(policy.policyMatches({}, p), false);
  assert.equal(policy.policyMatches({}, null), true);
});
