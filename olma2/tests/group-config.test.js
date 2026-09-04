'use strict';
// The gateway-config half of group mode. Pure mutations over a parsed object,
// so the whole thing runs without a database or a gateway.
//
// The exact SHAPES asserted here are not taste — they were run through the
// gateway's own `resolveSendPolicy` on the box (2026-09-04) against all 46
// live session keys plus every other key shape it mints. Change a string here
// and the mute silently stops matching, which fails in the one direction that
// matters: she starts talking in a locked group.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const occ = require('../src/intake/openclaw-config');

const JID = '120363424282127706@g.us';

function baseConfig() {
  return {
    agents: { entries: { main: { name: 'main' } } },
    channels: { whatsapp: { accounts: { default: { dmPolicy: 'open', allowFrom: ['*'] } } } },
    session: { dmScope: 'per-channel-peer' },
    bindings: [],
  };
}

test('the mute is a deny rule on the group session prefix, with default allow', () => {
  const cfg = baseConfig();
  assert.equal(occ.muteGroup(cfg, JID), true);
  assert.deepEqual(cfg.session.sendPolicy, {
    rules: [{ action: 'deny', match: { keyPrefix: `whatsapp:group:${JID}` } }],
    default: 'allow',
  });
  // dmScope must survive: sendPolicy lives in the same top-level block.
  assert.equal(cfg.session.dmScope, 'per-channel-peer');
});

// `default` decides every session no rule matched. Anything but 'allow' there
// mutes the entire system, users included.
test('an inherited policy with a bad default is corrected, not trusted', () => {
  const cfg = baseConfig();
  cfg.session.sendPolicy = { rules: [], default: 'deny' };
  occ.muteGroup(cfg, JID);
  assert.equal(cfg.session.sendPolicy.default, 'allow');
});

test('muting is idempotent and unmuting removes exactly one group', () => {
  const cfg = baseConfig();
  occ.muteGroup(cfg, JID);
  assert.equal(occ.muteGroup(cfg, JID), false, 'a second mute must not stack a duplicate rule');
  const other = '120363999999999999@g.us';
  occ.muteGroup(cfg, other);
  assert.equal(cfg.session.sendPolicy.rules.length, 2);

  assert.equal(occ.unmuteGroup(cfg, JID), true);
  assert.equal(occ.isGroupMuted(cfg, JID), false);
  assert.equal(occ.isGroupMuted(cfg, other), true, 'unlocking one group must not unlock another');
  assert.equal(occ.unmuteGroup(cfg, JID), false, 'unmuting an unmuted group changes nothing');
});

// The resolver lowercases both sides before comparing, so a rule written with
// an upper-case JID would never match the key it was meant to stop.
test('the rule is written lower-case, whatever case the JID arrives in', () => {
  const cfg = baseConfig();
  occ.muteGroup(cfg, '120363ABCDEF@G.US');
  assert.equal(cfg.session.sendPolicy.rules[0].match.keyPrefix, 'whatsapp:group:120363abcdef@g.us');
  assert.equal(occ.isGroupMuted(cfg, '120363ABCDEF@G.US'), true);
});

test('unmuting a config that never had a policy is a no-op, not a crash', () => {
  const cfg = baseConfig();
  assert.equal(occ.unmuteGroup(cfg, JID), false);
  assert.equal(occ.isGroupMuted(cfg, JID), false);
});

// The groups map is an allowlist the moment it is non-empty: admitting the
// first group blocks every other group on the account. That is the intended
// behaviour and the reason it is a registration-time lever only.
test('admitting a group creates the allowlist entry, mention-gated', () => {
  const cfg = baseConfig();
  assert.equal(occ.isGroupAdmitted(cfg, JID), false);
  assert.equal(occ.admitGroup(cfg, JID), true);
  assert.deepEqual(cfg.channels.whatsapp.groups, { [JID]: { requireMention: true } });
  assert.equal(occ.admitGroup(cfg, JID), false);
  assert.equal(occ.isGroupAdmitted(cfg, JID), true);

  assert.equal(occ.unadmitGroup(cfg, JID), true);
  assert.deepEqual(cfg.channels.whatsapp.groups, {});
  assert.equal(occ.unadmitGroup(cfg, JID), false);
});

// Only a real @-mention or a reply wakes her. Mention PATTERNS would also make
// her name in free text a trigger, so nothing may ever write them.
test('admission never writes mention patterns', () => {
  const cfg = baseConfig();
  occ.admitGroup(cfg, JID);
  const json = JSON.stringify(cfg);
  assert.ok(!json.includes('mentionPatterns'), 'a name in free text must not wake her');
});

test('a group binding routes by group peer and leaves direct bindings alone', () => {
  const cfg = baseConfig();
  occ.addBinding(cfg, { agentId: 'u-12', phone: '+972500000000' });
  assert.equal(occ.addGroupBinding(cfg, { agentId: 'g-3', jid: JID }), true);
  assert.equal(occ.addGroupBinding(cfg, { agentId: 'g-3', jid: JID }), false);

  const group = cfg.bindings.find((b) => b.match.peer.kind === 'group');
  assert.equal(group.agentId, 'g-3');
  assert.equal(group.match.peer.id, JID);
  assert.equal(group.match.channel, 'whatsapp');

  assert.equal(occ.removeGroupBinding(cfg, JID), true);
  assert.equal(cfg.bindings.length, 1, 'the direct binding must survive');
  assert.equal(cfg.bindings[0].match.peer.kind, 'direct');
  assert.equal(occ.removeGroupBinding(cfg, JID), false);
});

// A group whose id happens to collide with a phone-shaped string must not let
// removeGroupBinding take a user's route with it.
test('removing a group binding never matches a direct peer of the same id', () => {
  const cfg = baseConfig();
  occ.addBinding(cfg, { agentId: 'u-12', phone: '+972500000000' });
  occ.removeGroupBinding(cfg, '+972500000000');
  assert.equal(cfg.bindings.length, 1);
});
