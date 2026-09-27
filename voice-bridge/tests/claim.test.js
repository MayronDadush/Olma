'use strict';
// lib/claim: the sentences from the 2026-09-27 call are held; offers,
// questions and honest negatives are not.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { claimsWrite, WRITE_TOOLS } = require('../lib/claim');

test('the two sentences from the call that had nothing behind them are claims', () => {
  assert.equal(claimsWrite('אוקיי, הוספתי לך משימה "פיזיותרפיה" למחר בשעה תשע בבוקר.'), true);
  assert.equal(claimsWrite('אני אעדכן את זה.'), true);
});

test('other past and future first-person writes are claims', () => {
  for (const s of ['רשמתי ביומן.', 'עדכנתי את השעה.', 'סימנתי כבוצע.', 'אוסיף את זה לרשימה.', 'העברתי את זה למחר.']) {
    assert.equal(claimsWrite(s), true, s);
  }
});

test('a question, an offer and an honest negative are not claims', () => {
  for (const s of ['אוסיף את זה?', 'רוצה שאוסיף את זה לרשימה?', 'לא הוספתי את זה עדיין.',
    'עוד לא עדכנתי.', 'המשימות שלך השבוע הן: סופר ביום רביעי.', 'בטח, מתי הפגישה?', '']) {
    assert.equal(claimsWrite(s), false, s);
  }
});

test('a verb inside a longer word is not a claim', () => {
  assert.equal(claimsWrite('ההוספתיות של המערכת.'), false);
});

test('only writes can back a claim', () => {
  assert.ok(WRITE_TOOLS.has('add_task'));
  assert.ok(WRITE_TOOLS.has('reschedule_task'));
  assert.ok(!WRITE_TOOLS.has('refresh_data'));
  assert.ok(!WRITE_TOOLS.has('end_call'));
});
