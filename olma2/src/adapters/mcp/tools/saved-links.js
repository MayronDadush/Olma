'use strict';
// saved links ("שמורים") — one slice of the tool registry (see ../registry.js).
//
// ONE tool with an `action`, not eleven: the schema budget had about 53 chars
// free and the owner approved exactly +1,100 for this (2026-10-08,
// tests/tool-schema-budget.test.js). A message that is only a link never
// reaches it — the gateway plugin saves that by code (brokerd
// `save_link_shortcut`); this is the door for everything said around a link,
// for the correction ("לחתונה" right after a save) and for reading back.
//
// Every result carries `action`, because the mark is chosen off the result
// (reactions.stateFor): a write earns 👍, a read earns nothing.
const { S, tool } = require('./_shared');
const savedLinks = require('../../../domain/saved-links');
const { err } = require('../../../domain/results');

const ACTIONS = {
  save: (c, u, a) => (a.url
    ? savedLinks.saveUrls(c, u, { urls: [a.url], list: a.list, line: a.line })
    : err('invalid', 'url required')),
  move: (c, u, a) => savedLinks.move(c, u.id, { linkId: a.link_id, list: a.list }),
  list: (c, u, a) => savedLinks.list(c, u.id, { list: a.list }),
  search: (c, u, a) => savedLinks.search(c, u.id, { query: a.query }),
  set_line: (c, u, a) => savedLinks.setLine(c, u.id, { linkId: a.link_id, line: a.line }),
  done: (c, u, a) => savedLinks.setStatus(c, u.id, { linkId: a.link_id, done: true }),
  delete: (c, u, a) => savedLinks.remove(c, u.id, { linkId: a.link_id }),
  lists: (c, u) => savedLinks.lists(c, u.id),
  rename_list: (c, u, a) => savedLinks.renameList(c, u.id, { list: a.list, to: a.name }),
  delete_list: (c, u, a) => savedLinks.deleteList(c, u.id, { list: a.list }),
  to_task: (c, u, a) => savedLinks.toTask(c, u, { linkId: a.link_id }),
};

async function handle(client, user, a) {
  const run = ACTIONS[String(a.action || '').trim()];
  if (!run) return err('invalid', `action must be one of: ${Object.keys(ACTIONS).join(', ')}`);
  const r = await run(client, user, a);
  return r && r.ok ? { ...r, data: { action: a.action, ...(r.data || {}) } } : r;
}

module.exports = [
  tool('saved_links', 'Links they keep for later, sorted into lists. A message that is only a URL was already saved by code. Never ask which list first: save, then say where it went. move without link_id moves their latest save (30 min). line = one short line about the link (price, rooms, prep time); their words beat what was read. to_task makes an ordinary task carrying the link. Rows carry url: send it verbatim, never retype it.',
    { action: S('string', 'save | move | list | search | set_line | done | delete | lists | rename_list | delete_list | to_task'),
      url: S('string', 'save: the URL'),
      link_id: S('number', 'From list/search'),
      list: S('string', 'List name; save/move/list'),
      line: S('string', 'save/set_line'),
      query: S('string', 'search'),
      name: S('string', 'rename_list: new name') },
    ['action'], handle),
];
