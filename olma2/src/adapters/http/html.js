'use strict';
// HTML helpers shared by every server-rendered page in adapters/http.
//
// `esc` used to be defined three times (dashboard.js, user-dashboard.js,
// picker.js) — byte-identical, and each a place a future fix could miss. One
// definition, one place. Everything a page interpolates from the database or
// a request goes through it; the five characters are the HTML metacharacters
// plus the single quote, so a value is safe inside a double- OR
// single-quoted attribute.
//
// Deliberately NOT the escaper in domain/schedule-card.js: that one targets
// XML/SVG (no single quote, strips control characters, `String(s)` rather
// than `String(s ?? '')`) and must not be folded in here.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

module.exports = { esc };
