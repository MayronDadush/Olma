'use strict';
// The USER.md section that holds what a person wrote to the greeter before
// their own line existed. Provisioning WRITES this heading; the leak detector
// (jobs/config-guard.js) and its repair (domain/carryover-repair.js) FIND the
// section by it, and two prompts point the model at it by name.
//
// It used to be four copies of the same Hebrew sentence, and a reader that
// cannot find the heading does not fail — it skips the card, which reads
// exactly like "no leak here". Rewording the heading in one place would have
// switched the leak check off in silence.
//
// Readers match MATCH, a prefix, never TITLE: every card already on disk keeps
// the wording it was written with, so a new TITLE must still start with MATCH
// (tests/carryover-heading.test.js holds that), and if MATCH itself ever has
// to change, the readers must go on matching the old one too.
const TITLE = 'מה שכבר שיתפו לפני שהמערכת האישית הייתה מוכנה';
const HEADING = `## ${TITLE}`;
const MATCH = '## מה שכבר שיתפו';

module.exports = { TITLE, HEADING, MATCH };
