'use strict';
require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const orphans = require('../src/intake/orphan-agents');

test('planPurge: only an Olma agent nothing names any more is purged', () => {
  const plan = orphans.planPurge({
    dirs: ['main', 'intake', 'ggreet', 'u-1', 'u-2', 'u-3', 'g-4', 'g-5', 'probe', 'u-3-test'],
    configIds: ['main', 'intake', 'ggreet', 'u-1', 'g-4'],
    userAgentIds: ['u-1', 'u-2'],
    groupAgentIds: ['g-4', 'g-5'],
  });
  assert.deepEqual(plan.purge, ['u-3']);
  const why = Object.fromEntries(plan.keep.map((k) => [k.id, k.reason]));
  assert.equal(why.main, 'system agent');
  assert.equal(why['u-1'], 'in the gateway config');
  assert.equal(why['u-2'], 'a users row still names it', 'a row without a config entry is a fault to look at, not garbage');
  assert.equal(why['g-5'], 'a chat_groups row still names it');
  assert.equal(why.probe, 'not an agent Olma provisions');
  assert.equal(why['u-3-test'], 'not an agent Olma provisions');
});

// A fake /proc: pid 42 holds u-5's sqlite open.
function fakeProc(root, links) {
  for (const [pid, targets] of Object.entries(links)) {
    const fdDir = path.join(root, pid, 'fd');
    fs.mkdirSync(fdDir, { recursive: true });
    targets.forEach((t, i) => fs.symlinkSync(t, path.join(fdDir, String(i))));
  }
}

test('purge: a dir any process holds is refused, a free one is removed', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'olma2-orph-'));
  const proc = fs.mkdtempSync(path.join(os.tmpdir(), 'olma2-proc-'));
  for (const id of ['u-5', 'u-6']) {
    fs.mkdirSync(path.join(home, 'agents', id, 'agent'), { recursive: true });
    fs.writeFileSync(path.join(home, 'agents', id, 'agent', 'openclaw-agent.sqlite'), 'x');
  }
  fakeProc(proc, { 42: [path.join(home, 'agents', 'u-5', 'agent', 'openclaw-agent.sqlite')], self: [] });
  const out = orphans.purge(home, ['u-5', 'u-6'], { procRoot: proc });
  assert.deepEqual(out, [
    { id: 'u-5', removed: false, why: 'a process has it open' },
    { id: 'u-6', removed: true },
  ]);
  assert.ok(fs.existsSync(path.join(home, 'agents', 'u-5')));
  assert.ok(!fs.existsSync(path.join(home, 'agents', 'u-6')));
});

test('purge: a host that cannot say who holds what removes nothing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'olma2-orph-'));
  fs.mkdirSync(path.join(home, 'agents', 'u-7'), { recursive: true });
  const out = orphans.purge(home, ['u-7'], { procRoot: path.join(home, 'no-proc') });
  assert.equal(out[0].removed, false);
  assert.match(out[0].why, /cannot tell/);
  assert.ok(fs.existsSync(path.join(home, 'agents', 'u-7')));
});

test('purge: refuses the live gateway home from a test process', () => {
  assert.throws(() => orphans.purge('/root/.openclaw', ['u-1']), /refusing to touch the live gateway/);
});
