'use strict';
// What a platform can render, and what happens to a style on one that cannot.
//
// The interesting assertions here are all about the DEGRADED path and about
// text nobody on this side wrote. A task title is the person's own words: it
// may contain an asterisk, and WhatsApp has no escape character, so the only
// question worth testing is what we do when wrapping would produce nonsense.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const format = require('../src/domain/message-format');
const { renderReminderText } = require('../src/domain/proactive-text');

test('WhatsApp renders all eight styles; a channel nobody has heard of renders none', () => {
  const wa = format.capabilitiesFor('whatsapp');
  assert.equal(format.ALL_KEYS.length, 8);
  for (const k of format.ALL_KEYS) assert.equal(wa[k], true, k);

  // The honest third state: unknown is PLAIN, never "probably WhatsApp".
  for (const unknown of ['sms', 'telegram', 'web', '', null, undefined, 'WHATSAPP  ']) {
    const can = format.capabilitiesFor(unknown);
    if (String(unknown || '').trim().toLowerCase() === 'whatsapp') continue;
    for (const k of format.ALL_KEYS) assert.equal(can[k], false, `${unknown}/${k}`);
  }
  // ...and case and padding do not make a known platform unknown.
  assert.equal(format.supports(' WhatsApp ', 'bold'), true);
});

test('every style is wrapped on WhatsApp and left alone everywhere else', () => {
  const wa = format.formatterFor('whatsapp');
  const plain = format.formatterFor('sms');

  assert.equal(wa.bold('שלום'), '*שלום*');
  assert.equal(wa.italic('שלום'), '_שלום_');
  assert.equal(wa.strikethrough('שלום'), '~שלום~');
  assert.equal(wa.inlineCode('npm test'), '`npm test`');
  assert.equal(wa.monospace('a\nb'), '```a\nb```');
  assert.equal(wa.quote('one\ntwo'), '> one\n> two');
  assert.equal(wa.bullets(['a', 'b']), '- a\n- b');
  assert.equal(wa.numbered(['a', 'b']), '1. a\n2. b');

  for (const call of ['bold', 'italic', 'strikethrough', 'inlineCode', 'monospace', 'quote']) {
    assert.equal(plain[call]('שלום'), 'שלום', call);
  }
  // A bullet is the one style with a plain-text stand-in that needs no
  // renderer; "- " on a platform without lists is just a stray hyphen.
  assert.equal(plain.bullets(['a', 'b']), '• a\n• b');
  assert.equal(plain.numbered(['a', 'b']), '1. a\n2. b');
});

test('a value carrying the marker is left plain, because WhatsApp cannot escape one', () => {
  const wa = format.formatterFor('whatsapp');
  // Real shapes: a title with a footnote star, a file name, a range.
  assert.equal(wa.bold('לקנות חלב *דל לקטוז*'), 'לקנות חלב *דל לקטוז*');
  assert.equal(wa.italic('report_final_v2'), 'report_final_v2');
  assert.equal(wa.strikethrough('7~8 בערב'), '7~8 בערב');
  assert.equal(wa.inlineCode('run `npm test`'), 'run `npm test`');
  assert.equal(wa.monospace('see `x`'), 'see `x`');
  // Emphasis does not survive a newline on WhatsApp, so it is not attempted.
  assert.equal(wa.bold('שורה\nשנייה'), 'שורה\nשנייה');
});

test('a marker must hug its text, so surrounding space stays outside it', () => {
  const wa = format.formatterFor('whatsapp');
  // "* x *" renders as three literal characters; the markers move in instead.
  assert.equal(wa.bold('  שלום  '), '  *שלום*  ');
  assert.equal(wa.bold('   '), '   ', 'nothing to emphasise');
  assert.equal(wa.bold(''), '');
  assert.equal(wa.bold(null), '');
});

test('styles nest, and the sampler proves it in the message itself', () => {
  const wa = format.formatterFor('whatsapp');
  assert.equal(wa.bold(wa.italic('כן')), '*_כן_*');

  const he = format.sampler('he');
  // Every style is named, in both languages, and demonstrated.
  for (const s of format.STYLES) {
    assert.ok(he.includes(s.he), `missing Hebrew name: ${s.he}`);
    assert.ok(he.includes(s.en), `missing English name: ${s.en}`);
  }
  assert.match(he, /\*ככה זה נראה\*/, 'bold is shown rendered');
  assert.match(he, /^> ככה זה נראה$/m, 'the quote is shown rendered');
  assert.match(he, /^- פריט ראשון$/m, 'the bulleted list is a real WhatsApp list');
  assert.match(he, /^1\. פריט ראשון$/m);
  assert.match(he, /\*_מודגש ונטוי יחד_\*/, 'the nesting example');
  // The syntax of each style is shown inside inline code, which is the only
  // way to put a literal asterisk on a WhatsApp screen. So the two styles
  // whose own syntax IS a backtick must be described in words instead — a
  // literal there would render the example rather than show it.
  assert.ok(!format.STYLES.find((s) => s.key === 'monospace').syntaxHe.includes('`'));
  assert.ok(!format.STYLES.find((s) => s.key === 'inlineCode').syntaxHe.includes('`'));
  assert.ok(!format.STYLES.find((s) => s.key === 'monospace').syntaxEn.includes('`'));

  // A channel that renders nothing is told so, rather than being handed eight
  // examples that all look identical and a syntax that does nothing there.
  const bare = format.sampler('he', 'sms');
  assert.doesNotMatch(bare, /[*_~`]/, `markers survived a plain channel: ${bare}`);
  assert.doesNotMatch(bare, /^> /m);
  assert.match(bare, /טקסט רגיל/);

  const en = format.sampler('en');
  assert.doesNotMatch(en, /[֐-׿]/, 'the English sampler is English');
});

test('a reminder list is a native WhatsApp list, and a bullet character elsewhere', () => {
  const payload = { items: ['לקחת תרופה', 'לשלם שכר דירה'] };
  assert.match(renderReminderText(payload, undefined, 'he', 'whatsapp'), /^- לקחת תרופה$/m);
  assert.match(renderReminderText(payload, undefined, 'he', 'sms'), /^• לקחת תרופה$/m);
  // Absent, it is plain: the platform is read at delivery off the person, and
  // a caller that never learned it must not be handed WhatsApp by default.
  assert.match(renderReminderText(payload, undefined, 'he'), /^• לקחת תרופה$/m);
  // The rung's own promise is untouched by any of this.
  const last = renderReminderText({ ...payload, attempt: 3, finalAttempt: true }, undefined, 'he', 'whatsapp');
  assert.match(last, /התזכורות האחרונות/);
});
