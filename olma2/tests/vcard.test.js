'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseVCards } = require('../src/domain/vcard');

const CRLF = (s) => s.replace(/\n/g, '\r\n');

test('basic vCard 3.0: FN + single TEL', () => {
  const [card] = parseVCards(CRLF(
    `BEGIN:VCARD\nVERSION:3.0\nFN:Dana Cohen\nTEL;TYPE=CELL:054-261-3404\nEND:VCARD\n`
  ));
  assert.equal(card.name, 'Dana Cohen');
  assert.deepEqual(card.phones, [{ value: '054-261-3404', type: 'mobile' }]);
});

// The critical path: Android exports a Hebrew display name as vCard 2.1
// Quoted-Printable. Missing this silently drops or mangles every Hebrew
// contact from an Android export.
test('vCard 2.1 quoted-printable Hebrew FN decodes correctly', () => {
  const [card] = parseVCards(CRLF(
    `BEGIN:VCARD\nVERSION:2.1\nFN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=D7=93=D7=A0=D7=94\nTEL;CELL:0542613404\nEND:VCARD\n`
  ));
  assert.equal(card.name, 'דנה');
});

test('quoted-printable soft line break joins a wrapped value before decoding', () => {
  // "דנה כהן" split mid-encoding across two physical lines, each ending in a
  // bare '=' with NO leading whitespace on the continuation — the QP soft
  // break, distinct from standard RFC2425 folding.
  const raw = CRLF(
    `BEGIN:VCARD\nVERSION:2.1\nFN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=D7=93=D7=A0=D7=94 =\n=D7=9B=D7=94=D7=9F\nEND:VCARD\n`
  );
  const [card] = parseVCards(raw);
  assert.equal(card.name, 'דנה כהן');
});

test('standard folding: a leading-space continuation line glues onto the previous one', () => {
  const raw = CRLF(
    `BEGIN:VCARD\nVERSION:3.0\nFN:Dana Cohen The Second Of Her Na\n me\nEND:VCARD\n`
  );
  const [card] = parseVCards(raw);
  assert.equal(card.name, 'Dana Cohen The Second Of Her Name');
});

test('N field fallback (given + family) when FN is absent', () => {
  const raw = CRLF(
    `BEGIN:VCARD\nVERSION:2.1\nN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=D7=9B=D7=94=D7=9F;=D7=93=D7=A0=D7=94;;;\nEND:VCARD\n`
  );
  const [card] = parseVCards(raw);
  assert.equal(card.name, 'דנה כהן'); // given family, both decoded
});

test('multiple TEL rows with mixed type styles: TYPE=, bare 2.1 params, unlabelled', () => {
  const raw = CRLF(
    `BEGIN:VCARD\nVERSION:3.0\nFN:Multi Number\nTEL;TYPE=CELL,VOICE:054-1111111\nTEL;WORK;VOICE:03-2222222\nTEL;TYPE=HOME:03-3333333\nTEL:03-4444444\nEND:VCARD\n`
  );
  const [card] = parseVCards(raw);
  assert.deepEqual(card.phones.map((p) => p.type), ['mobile', 'work', 'home', 'other']);
});

test('Apple grouped form (item1.TEL) has its group label stripped', () => {
  const raw = CRLF(
    `BEGIN:VCARD\nVERSION:3.0\nFN:Grouped\nitem1.TEL;TYPE=CELL:054-9999999\nitem1.X-ABLabel:Mobile\nEND:VCARD\n`
  );
  const [card] = parseVCards(raw);
  assert.deepEqual(card.phones, [{ value: '054-9999999', type: 'mobile' }]);
});

test('escaped separators in FN are unescaped', () => {
  const raw = CRLF(`BEGIN:VCARD\nVERSION:3.0\nFN:Cohen\\, Dana\nEND:VCARD\n`);
  const [card] = parseVCards(raw);
  assert.equal(card.name, 'Cohen, Dana');
});

test('PHOTO base64 blob is skipped without corrupting neighbouring properties', () => {
  const raw = CRLF(
    `BEGIN:VCARD\nVERSION:3.0\nFN:Has Photo\nPHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRgABAQEAYABgAAD=\n /2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEE=\nTEL;TYPE=CELL:054-1231234\nEND:VCARD\n`
  );
  const [card] = parseVCards(raw);
  assert.equal(card.name, 'Has Photo');
  assert.deepEqual(card.phones, [{ value: '054-1231234', type: 'mobile' }]);
});

test('multiple cards in one file, mixed CRLF and bare LF', () => {
  const raw = `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:First One\r\nTEL:0541111111\r\nEND:VCARD\r\n`
    + `BEGIN:VCARD\nVERSION:3.0\nFN:Second One\nTEL:0542222222\nEND:VCARD\n`;
  const cards = parseVCards(raw);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].name, 'First One');
  assert.equal(cards[1].name, 'Second One');
});

test('garbage or empty input yields no cards, never throws', () => {
  assert.deepEqual(parseVCards(''), []);
  assert.deepEqual(parseVCards(null), []);
  assert.deepEqual(parseVCards('not a vcard at all\njust some text'), []);
  assert.deepEqual(parseVCards('BEGIN:VCARD\nEND:VCARD\n'), []); // no name, no phone — nothing worth an entry
});

test('EMAIL, ADR, ORG, NOTE, X-* are all ignored — only FN/N/TEL matter', () => {
  const raw = CRLF(
    `BEGIN:VCARD\nVERSION:3.0\nFN:Plain Fields\nEMAIL:dana@example.com\nADR:;;Street 1;City;;;\nORG:Acme\nNOTE:hello\nX-CUSTOM:whatever\nTEL:0541111111\nEND:VCARD\n`
  );
  const [card] = parseVCards(raw);
  assert.equal(card.name, 'Plain Fields');
  assert.deepEqual(card.phones, [{ value: '0541111111', type: 'other' }]);
});
