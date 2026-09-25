'use strict';
// How a person is addressed, read out of the words they used for it.
//
// Two stores hold the same fact and they drifted apart: `users.gender` (the
// profile page, and since 2026-09-23 what somebody says about themselves in a
// room) and the `gender_forms` preference (free text the private agent writes
// when they say it in a chat — "נשי" on the box). The room read the first, the
// private chat's turn_start read the second, so a change made in one place was
// invisible in the other. The owner's rule is that they agree, whichever side
// the change came from (`users.setPersonal` and `preferences.remember` keep
// them in step, both through this one reading).
//
// Both readings or neither is null, never a coin toss: a wrong form in front
// of somebody is the thing this exists to end.
const FEMININE_RE = /נקב|נשי|אישה|feminine|\bfemale\b|\bwoman\b/i;
const MASCULINE_RE = /זכר|גברי|masculine|\bmale\b|\bman\b/i;

function genderFromWords(text) {
  const said = String(text == null ? '' : text);
  const f = FEMININE_RE.test(said), m = MASCULINE_RE.test(said);
  return f === m ? null : (f ? 'female' : 'male');
}

// What the preference says when the profile column is the one that moved.
const WORDS = { male: 'לשון זכר', female: 'לשון נקבה' };

module.exports = { genderFromWords, WORDS };
