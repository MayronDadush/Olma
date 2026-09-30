'use strict';
// The settlement as people read it, drawn — never a model's words. Used by the
// tools (a result the model relays) and by the close announcement (a message
// brokerd sends as is). The Hebrew is the page's own summaryText word for
// word; tests/page-parity.test.js holds the two together.
const { settlementOf } = require('./money');

/* ── the page's formatting, for the lines people read ── */
const nfHe = new Intl.NumberFormat('he-IL');
const fmtChips = n => nfHe.format(Math.round(n));
const fmtAg = a => {
  const x = Math.abs(a), whole = x % 100 === 0;
  return '⁦' + (a < 0 ? '−' : '') + (x / 100).toLocaleString('he-IL', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 }) + ' ₪⁩';
};
const fmtAgEn = a => '₪' + (Math.abs(a) / 100).toLocaleString('en-US', { minimumFractionDigits: a % 100 ? 2 : 0, maximumFractionDigits: 2 });

function summaryText(st, D, locale = 'he') {
  const name = id => st.players[id]?.name || '?';
  if (locale === 'en') {
    // Words, not an arrow, and every name isolated behind a left-to-right
    // mark: a line that opens on a Hebrew name is laid out right to left, and
    // "יוסי → מירון" then reads as the other person paying.
    const lines = xs => xs.map(x => `‎⁨${name(x.from)}⁩ pays ⁨${name(x.to)}⁩: ${fmtAgEn(x.amt)}`).join('\n') || 'No transfers';
    let t = `${st.game.name} — settlement\nBuy-in ${fmtAgEn(D.price)} = ${D.cpb.toLocaleString('en-US')} chips\n\n`;
    if (D.merge) t += lines(D.xAll) + (D.hasFood ? '\n(food included)' : '');
    else { if (D.closed) t += 'Poker:\n' + lines(D.xPoker); if (D.hasFood) t += (D.closed ? '\n\n' : '') + 'Food:\n' + lines(D.xFood); }
    return t;
  }
  // The page's summaryText, word for word (public/night.html).
  const lines = xs => xs.map(x => `מ${name(x.from)} ל${name(x.to)}: ${fmtAg(x.amt)}`).join('\n') || 'אין העברות';
  let t = `סיכום ${st.game.name}\nכניסה ${fmtAg(D.price)} = ${fmtChips(D.cpb)} ז'יטונים\n\n`;
  if (D.merge) t += lines(D.xAll) + (D.hasFood ? '\n(כולל האוכל)' : '');
  else { if (D.closed) t += 'פוקר:\n' + lines(D.xPoker); if (D.hasFood) t += (D.closed ? '\n\n' : '') + 'אוכל:\n' + lines(D.xFood); }
  return t;
}

// Both languages at once, for the announcement: brokerd picks one per reader.
function textsOf(st) {
  const D = settlementOf(st);
  return { he: summaryText(st, D, 'he'), en: summaryText(st, D, 'en') };
}

module.exports = { summaryText, textsOf, fmtChips, fmtAg, fmtAgEn };
