'use strict';
// The tool registry is split by domain: src/adapters/mcp/tools/*.js each
// export an array of tool() entries and registry.js is only the ORDER they
// are concatenated in. Two ways that arrangement can rot quietly, both held
// here: a tool file that exists but is not listed (its tools vanish from the
// agent with no error anywhere), and a file exporting something that is not
// a tool (BY_NAME would index `undefined`).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { TOOLS, BY_NAME, toolDefinitions } = require('../src/adapters/mcp/registry');
const { IDENTITY_PARAM } = require('../src/adapters/mcp/identity-param');

const DIR = path.join(__dirname, '..', 'src', 'adapters', 'mcp', 'tools');
const REGISTRY = fs.readFileSync(path.join(__dirname, '..', 'src', 'adapters', 'mcp', 'registry.js'), 'utf8');

test('every tool file is listed in the registry order, and nothing else is', () => {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.js') && f !== '_shared.js').map((f) => f.replace(/\.js$/, ''));
  const listed = [...REGISTRY.matchAll(/require\('\.\/tools\/([a-z0-9-]+)'\)/g)].map((m) => m[1]);
  assert.deepEqual([...listed].sort(), [...files].sort(), 'a tool file the registry does not list is a set of tools nobody can call');
  assert.deepEqual(listed, [...new Set(listed)], 'no file listed twice');
});

test('every entry is a tool: a name, a description, a schema carrying the identity parameter, a handler', () => {
  for (const t of TOOLS) {
    assert.ok(t && typeof t.name === 'string' && t.name, 'named');
    assert.ok(typeof t.description === 'string' && t.description.length > 20, `${t.name}: described`);
    assert.equal(typeof t.handler, 'function', `${t.name}: has a handler`);
    assert.ok(t.inputSchema.properties[IDENTITY_PARAM], `${t.name}: carries ${IDENTITY_PARAM}`);
    assert.ok(t.inputSchema.required.includes(IDENTITY_PARAM), `${t.name}: requires it`);
  }
  assert.equal(BY_NAME.size, TOOLS.length, 'no two tools share a name');
  assert.equal(toolDefinitions().length, TOOLS.length);
});

test('a tool file exports only tools built with the shared helper (an array, no stray exports)', () => {
  for (const f of fs.readdirSync(DIR)) {
    if (!f.endsWith('.js') || f === '_shared.js') continue;
    const mod = require(path.join(DIR, f));
    assert.ok(Array.isArray(mod) && mod.length > 0, `${f} exports a non-empty array`);
    for (const t of mod) assert.ok(BY_NAME.get(t.name) === t, `${f}: ${t && t.name} is in the registry`);
  }
});
