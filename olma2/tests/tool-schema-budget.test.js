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
// The surface stood at 55,453 — a margin of 47 — after the five group tools
// (2026-09-07) paid for themselves by trimming their own four descriptions
// rather than anything a user tool had earned. The next tool, or the next
// sentence added to a description, goes red, and a twenty-character shave will
// not save it. That is the ceiling doing its job: what is left to cut are the
// compressed incidents, so the next person should expect to argue for raising
// this deliberately rather than to find easy fat.
//
// It went red immediately, on `quiet_days` (2026-09-08), and the ceiling held:
// a first draft explaining the key in the description cost 248 and was
// rejected here, so what shipped is the KEY NAME only — 36 chars, inside the
// margin — while the sentence that says what the value means moved to the
// discovery ladder's timezone rung, an outbox payload that costs nothing on
// the turns it does not apply to. That is the intended answer to this test,
// and it is available more often than it looks: the description has to carry
// only what the model needs on a turn nobody could predict. 55,494 now, margin
// of 6 — the next one really does have to argue.
//
// Raised deliberately, the second time ever, on 2026-09-22: 55,500 -> 56,500,
// for `relay_to_group` — 924 chars all in, and the owner cleared the raise in
// as many words ("אפשר לעלות את מכסת התווים שלנו בשביל מה שאתה צריך") when
// told what it would cost. What the tool buys is the one thing a room hears
// that somebody actually asked for: Sharon told Olma privately that the group
// should know the time had moved, and there was no shape in the system for a
// sentence a MEMBER decided on, so the room never heard it. The description
// could not shrink much further either — most of it is the boundary against
// the two tools it is NOT (`record_meeting_constraint`,
// `respond_to_meeting_slot`), and a model that gets that boundary wrong relays
// an answer about a time into a room. The ceiling still matters at 56,500: the
// margin is 449, one ordinary tool, so the argument the paragraphs above make
// is unchanged and the next one has to be made again.
//
// Raised the third time, on 2026-09-23: 56,500 -> 57,000, for
// `add_group_coordination_option` — 607 chars all in, cleared by the owner as
// a choice put to him with the cost on it. What it buys is the room's own
// times: עמית asked the room for poker on Friday afternoon and מירון added
// Thursday and Saturday evening, in front of everyone; the room's agent had no
// tool that could write a time, was refused on the person's one, told the room
// the times were going out privately, and the coordination's page showed an
// empty table. It paid 26 chars of its own first — `start_group_coordination`
// lost the "never collect times here" the new tool makes false, and the new
// description carries no sentence its error message already says. 56,827 now,
// a margin of 173: not one more ordinary tool.
//
// **Every number above went stale, and one of them inside a day.** The line
// before this one said 449 on 2026-09-22 and measured 255 on 2026-09-23; this
// one says 173 and does not reproduce either — 55,927 for the same 91 tools,
// nearly 900 off. Whatever the cause (a description trimmed afterwards, a
// measurement taken mid-branch), the lesson is the same one this file keeps
// teaching about numbers nobody reconciles: **ask the code, not the
// paragraph.** One line answers it, and it is the same call the test makes:
//
//   node -e "const{toolDefinitions}=require('./src/adapters/mcp/registry');\
//            console.log(JSON.stringify(toolDefinitions()).length)"
//
// `add_task`'s `when_said` (2026-09-25, 182 chars) takes it to 56,109 — a
// margin of 891, which is room enough that the thing it was NOT given is now
// a choice rather than a constraint: `edit_task`, `snooze_task` and
// `set_task_reminder` still have no weekday guard, and roughly 540 chars would
// cover all three. It was left at one door because the margin looked like 72
// at the time, and it is worth re-deciding rather than inheriting.
// **English on purpose, and that is not a style choice**: JSON escapes every
// Hebrew character as \uXXXX at six chars each, so the founding example
// ("ביום הראשון הקרוב") would cost more than the rule it illustrates.
const JSON_CEILING = 57_000;
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
