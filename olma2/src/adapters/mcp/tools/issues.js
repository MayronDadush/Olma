'use strict';
// issues — one slice of the tool registry (see ../registry.js).
const {
  issues, searchLink, S, tool,
} = require('./_shared');

module.exports = [
  tool('report_issue', 'Log a bug / edge case / feature request / friction. A capability the user wanted and Olma lacks = feature_request, source agent_detected — log it silently, never ask permission for your own observation. Ask the user only before logging their own words as user_reported.',
    { category: S('string', 'bug | edge_case | feature_request | friction'),
      source: S('string', 'user_reported | agent_detected'),
      title: S('string', 'Short title'), detail: S('string', 'Optional detail') },
    ['category', 'source', 'title'],
    (client, user, a) => issues.reportIssue(client, user.id, a)),
  // You supply WORDS. The server builds the URL, from a base you cannot reach.
  // That is deliberate — see domain/search-link.js — and it is what keeps this
  // on the right side of the never-fake-a-lookup rule.
  tool('search_link',
    'Turn something Olma cannot look up into a search THEY can open: returns a Google link for the '
    + 'words you give it. Use it whenever you have just said you cannot do something webby — write an '
    + 'essay, check a share price, find a product, compare anything — before you offer to save it as a '
    + 'task. Write the query the way a person would type it, in THEIR language, specific to what they '
    + 'actually asked ("עבודה על בן גוריון לכיתה ח", not "בן גוריון"). Send the url back as-is, on its '
    + 'own line, with one short line saying what it searches. '
    + 'This is a QUESTION handed over, never an answer: it does not mean you looked, so never add what '
    + 'you think is on the other side — no price, no summary, no "מצאתי לך". Never pass a URL as the '
    + 'query, and never write any other link yourself; a link to a specific page or product is exactly '
    + 'the thing you must not invent.',
    { query: S('string', 'The search words, in the user\'s own language') }, ['query'],
    (client, user, a) => searchLink.buildSearchLink(client, user.id, a.query)),
];
