'use strict';
// A hand-rolled vCard reader — no dependency exists in this zero-dep
// codebase, and the shapes actually needed (FN/N + TEL) are a small slice of
// the spec. Two dialects both show up from real phones: vCard 3.0/4.0 uses
// generic line-folding (a continuation line starts with a space or tab);
// vCard 2.1 exports from Android additionally use Quoted-Printable soft line
// breaks (a trailing bare '=', no shared leading whitespace) on
// CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE properties — which is how Android
// encodes a Hebrew display name (e.g. `FN;CHARSET=UTF-8;
// ENCODING=QUOTED-PRINTABLE:=D7=93=D7=A0=D7=94` for "דנה"). Missing that path
// silently drops or mangles every Hebrew contact from an Android export.
//
// Deliberately narrow: only FN/N (name) and TEL (phone) are read.
// Everything else — EMAIL, ADR, ORG, NOTE, PHOTO's base64 blob, X-* — is
// skipped without being decoded; contacts.importContacts never needed it,
// and PHOTO in particular is exactly the kind of content unfold() below must
// NOT try to interpret as a QP soft break (its base64 lines often end in '='
// padding too, coincidentally — see the comment on unfold()).

const TEL_TYPE_RE = { mobile: /^(CELL|MOBILE)$/i, work: /^WORK$/i, home: /^HOME$/i };

function decodeQuotedPrintable(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(str.slice(i + 1, i + 3))) {
      bytes.push(parseInt(str.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(c.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

// Backslash-unescape and, if `sep` is given, split on it in the same pass —
// a component separator escaped as "\;" must not be treated as a split point.
function unescapeSplit(str, sep) {
  const parts = [];
  let cur = '';
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === '\\' && i + 1 < str.length) { cur += str[i + 1]; i++; continue; }
    if (sep && c === sep) { parts.push(cur); cur = ''; continue; }
    cur += str[i];
  }
  parts.push(cur);
  return parts;
}
const unescapeAll = (str) => unescapeSplit(str, null)[0];

// Join folded/soft-broken physical lines into logical ones. Two mechanisms,
// applied in the order real vCards need them: standard folding (any line — a
// leading space/tab glues onto the previous line) always runs first; a
// bare-'=' QP soft break is then applied only while the CURRENT property's
// own params declare quoted-printable encoding, checked per property rather
// than globally, which is what keeps a base64 PHOTO block — whose lines also
// often end in '=' padding, purely by coincidence — from being merged into
// whatever property comes after it.
function unfold(rawLines) {
  const logical = [];
  let i = 0;
  while (i < rawLines.length) {
    let line = rawLines[i]; i++;
    while (i < rawLines.length && /^[ \t]/.test(rawLines[i])) {
      line += rawLines[i].slice(1);
      i++;
    }
    const colon = line.indexOf(':');
    const head = colon >= 0 ? line.slice(0, colon) : line;
    const isQp = /ENCODING=(QUOTED-PRINTABLE|Q)\b/i.test(head) || /;QUOTED-PRINTABLE(;|$)/i.test(head);
    if (isQp) {
      while (line.endsWith('=') && i < rawLines.length) {
        line = line.slice(0, -1) + rawLines[i];
        i++;
      }
    }
    logical.push(line);
  }
  return logical;
}

// One "PROPNAME;PARAM=val;bareparam:value" logical line → { name, types, value }.
function parseLine(line) {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const rawValue = line.slice(colon + 1);
  const segs = head.split(';');
  // Apple's grouped form ("item1.TEL;type=CELL:...") — strip a leading
  // "<token>." group label before the actual property name.
  const name = segs.shift().replace(/^[A-Za-z0-9-]+\.(?=[A-Za-z])/, '').toUpperCase();
  const types = [];
  let isQp = false;
  for (const seg of segs) {
    const eq = seg.indexOf('=');
    if (eq < 0) {
      // Bare 2.1-style param — a TYPE value, or the encoding keyword itself.
      const bare = seg.toUpperCase();
      if (bare === 'QUOTED-PRINTABLE' || bare === 'Q') isQp = true;
      else if (bare && bare !== 'UTF-8') types.push(bare);
      continue;
    }
    const key = seg.slice(0, eq).toUpperCase();
    const val = seg.slice(eq + 1);
    if (key === 'ENCODING') { if (/^(QUOTED-PRINTABLE|Q)$/i.test(val)) isQp = true; }
    else if (key === 'TYPE') { types.push(...val.split(',').map((t) => t.toUpperCase())); }
  }
  const value = isQp ? decodeQuotedPrintable(rawValue) : rawValue;
  return { name, types, value };
}

function telType(types) {
  if (types.some((t) => TEL_TYPE_RE.mobile.test(t))) return 'mobile';
  if (types.some((t) => TEL_TYPE_RE.work.test(t))) return 'work';
  if (types.some((t) => TEL_TYPE_RE.home.test(t))) return 'home';
  return 'other';
}

function nameFromN(value) {
  const parts = unescapeSplit(value, ';'); // family;given;additional;prefix;suffix
  const given = (parts[1] || '').trim();
  const family = (parts[0] || '').trim();
  return [given, family].filter(Boolean).join(' ').trim();
}

// text -> [{ name, phones: [{ value, type }] }], one entry per BEGIN/END
// block. Never throws — garbage input just yields fewer or zero entries; the
// caller (contacts.importContacts) already treats a nameless/numberless
// entry as skipped.
function parseVCards(text) {
  if (!text) return [];
  const rawLines = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const logical = unfold(rawLines);

  const cards = [];
  let current = null;
  for (const line of logical) {
    const trimmed = line.trim();
    if (/^BEGIN:VCARD$/i.test(trimmed)) { current = { fn: null, n: null, phones: [] }; continue; }
    if (/^END:VCARD$/i.test(trimmed)) {
      if (current) {
        const name = current.fn || (current.n ? nameFromN(current.n) : '');
        if (name || current.phones.length) cards.push({ name, phones: current.phones });
      }
      current = null;
      continue;
    }
    if (!current || !line) continue;
    const prop = parseLine(line);
    if (!prop) continue;
    if (prop.name === 'FN') current.fn = unescapeAll(prop.value).trim();
    else if (prop.name === 'N') current.n = prop.value;
    else if (prop.name === 'TEL') {
      const v = unescapeAll(prop.value).trim();
      if (v) current.phones.push({ value: v, type: telType(prop.types) });
    }
    // Everything else — EMAIL, ADR, ORG, PHOTO, NOTE, X-*, ... — is ignored.
  }
  return cards;
}

module.exports = { parseVCards };
