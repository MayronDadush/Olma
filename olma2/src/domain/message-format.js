'use strict';
// What a PLATFORM can render, and the one place that decides it.
//
// Every sentence Olma sends verbatim is written once and delivered to whatever
// channel that person is on. Today there is exactly one — `user_channels`
// defaults `channel_type` to 'whatsapp' and nothing else has ever been written
// — so "WhatsApp markup" and "our markup" have been the same thing, and
// domain/message-templates.js says so out loud ("no markdown beyond what
// WhatsApp renders itself"). That holds only while the roster is one platform
// wide. `*טקסט*` is bold on WhatsApp, two literal asterisks on SMS, and
// something else again on Telegram or a web widget.
//
// So a style is decided at DELIVERY, off the recipient's channel — the same
// rule proactive-text.localizedKey already applies to the LANGUAGE of a rung,
// and for the same reason: what the person can read is a property of who they
// are and how they are reached, never of what was enqueued hours earlier.
//
// The honest third state is the default: a channel this table has never heard
// of gets PLAIN, never WhatsApp's markup on the assumption that it probably
// renders it. A style that does not survive is not an error — the sentence
// still arrives, and it arrives readable.
//
// WHAT THIS DOES NOT DO. It builds formatted text; it does not parse it. Text
// the owner typed into the admin page with markup in it (message_templates)
// passes through untouched, so a second channel would receive his asterisks
// raw. Stripping them means parsing WhatsApp's own rules — where a `*` is a
// marker and where it is an asterisk somebody typed — and that is a guess
// nobody can check until a real second platform exists to check it against.
// The gap is named here rather than papered over with an untestable parser.
//
// Sources for the table: WhatsApp's four original styles (bold, italic,
// strikethrough, monospace) plus the four added in Feb 2024 (bulleted list,
// numbered list, block quote, inline code).

// ---- the vocabulary ---------------------------------------------------------
// The eight styles WhatsApp renders, each with the name WhatsApp itself uses
// and the name the owner reads on the admin page. `syntax` is written for a
// human, not parsed by anything: it is what the sampler below shows, and what
// documentation quotes.
const STYLES = [
  {
    key: 'bold', en: 'Bold', he: 'מודגש',
    marker: '*', inline: true,
    syntaxEn: '*text*', syntaxHe: '*טקסט*',
  },
  {
    key: 'italic', en: 'Italic', he: 'נטוי',
    marker: '_', inline: true,
    syntaxEn: '_text_', syntaxHe: '_טקסט_',
  },
  {
    key: 'strikethrough', en: 'Strikethrough', he: 'קו חוצה',
    marker: '~', inline: true,
    syntaxEn: '~text~', syntaxHe: '~טקסט~',
  },
  {
    key: 'monospace', en: 'Monospace', he: 'רוחב קבוע',
    marker: '```', inline: false,
    // Described rather than quoted, in both languages, and that is forced:
    // the sampler shows every syntax inside inline code, and a backtick
    // inside inline code cannot be escaped on WhatsApp — quoting these two
    // literally would render the EXAMPLE instead of showing it.
    syntaxEn: 'three backticks on each side', syntaxHe: 'שלושה גרשים אחוריים משני הצדדים',
  },
  {
    key: 'inlineCode', en: 'Inline code', he: 'קוד מוטבע',
    marker: '`', inline: true,
    syntaxEn: 'one backtick on each side', syntaxHe: 'גרש אחורי אחד משני הצדדים',
  },
  {
    key: 'quote', en: 'Block quote', he: 'ציטוט',
    marker: '> ', inline: false,
    syntaxEn: '> text', syntaxHe: '> טקסט (בתחילת שורה)',
  },
  {
    key: 'bulletedList', en: 'Bulleted list', he: 'רשימת תבליטים',
    marker: '- ', inline: false,
    syntaxEn: '- item', syntaxHe: '- פריט (מקף ורווח; גם כוכבית ורווח)',
  },
  {
    key: 'numberedList', en: 'Numbered list', he: 'רשימה ממוספרת',
    marker: '1. ', inline: false,
    syntaxEn: '1. item', syntaxHe: '1. פריט (מספר, נקודה ורווח)',
  },
];

// Asked for by name often enough to be worth stating: these are the things
// people reach for and WhatsApp has no syntax for at all. A `#` heading and a
// `[label](url)` link do not fail quietly — they arrive as the literal
// characters, which is worse than never having tried.
const UNSUPPORTED = [
  { en: 'Underline', he: 'קו תחתון' },
  { en: 'Headings', he: 'כותרות' },
  { en: 'Labelled links', he: 'קישור עם טקסט (הכתובת עצמה כן הופכת ללחיצה)' },
  { en: 'Tables', he: 'טבלאות' },
  { en: 'Colour and font size', he: 'צבע וגודל גופן' },
];

const ALL_KEYS = STYLES.map((s) => s.key);

function profile(on) {
  return Object.fromEntries(ALL_KEYS.map((k) => [k, on]));
}

// One entry per channel_type we have ever written into user_channels. A type
// absent from here is PLAIN — see the honest-third-state note above.
const PLATFORMS = {
  whatsapp: profile(true),
  plain: profile(false),
};

function capabilitiesFor(channelType) {
  const key = String(channelType || '').trim().toLowerCase();
  return PLATFORMS[key] || PLATFORMS.plain;
}

function supports(channelType, styleKey) {
  return Boolean(capabilitiesFor(channelType)[styleKey]);
}

// ---- building formatted text -----------------------------------------------
// WhatsApp has NO escape character. There is no way to write a literal `*` next
// to bold text and be sure which one is which, so the only safe rule for a
// value we did not write — a task title is the person's own words — is: if it
// already contains the marker, do not wrap it. The sentence loses its emphasis
// and stays correct, which is the right way round. A marker must also hug its
// text (`* x *` renders as three literal characters), and inline emphasis does
// not survive a newline.
function wrapInline(marker, value, allowed) {
  const s = String(value == null ? '' : value);
  if (!allowed) return s;
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
  const [, lead, core, trail] = m;
  if (!core) return s;
  if (core.includes(marker) || core.includes('\n')) return s;
  return `${lead}${marker}${core}${marker}${trail}`;
}

// The block form. Unlike the inline styles it may span lines, so only the
// marker collision disqualifies it.
function wrapBlock(marker, value, allowed) {
  const s = String(value == null ? '' : value);
  const core = s.trim();
  if (!allowed || !core || core.includes('`')) return s;
  return `${marker}${core}${marker}`;
}

function lines(items) {
  return (Array.isArray(items) ? items : [items])
    .map((i) => String(i == null ? '' : i).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

// A formatter bound to one recipient's channel. Everything on it is safe to
// call whatever the channel is: on a platform without the style it returns the
// text unchanged, so no caller needs to branch on the platform itself.
function formatterFor(channelType) {
  const can = capabilitiesFor(channelType);
  return {
    channelType: String(channelType || '').trim().toLowerCase() || 'plain',
    can,
    bold: (v) => wrapInline('*', v, can.bold),
    italic: (v) => wrapInline('_', v, can.italic),
    strikethrough: (v) => wrapInline('~', v, can.strikethrough),
    inlineCode: (v) => wrapInline('`', v, can.inlineCode),
    monospace: (v) => wrapBlock('```', v, can.monospace),
    // WhatsApp does not carry a quote across a line break, so every line
    // carries its own marker. Without the style the text is simply itself:
    // there is no plain-text stand-in for a quote that is not noise.
    quote: (v) => {
      const s = String(v == null ? '' : v).trim();
      if (!can.quote || !s) return s;
      return s.split('\n').map((l) => `> ${l}`).join('\n');
    },
    // The one place the platform difference is visible in what already ships:
    // "- " is a real list on WhatsApp and a stray hyphen anywhere else, so
    // everywhere else keeps the bullet CHARACTER, which needs no renderer.
    bullets: (items) => lines(items)
      .map((t) => (can.bulletedList ? `- ${t}` : `• ${t}`)).join('\n'),
    // Numbering reads the same either way; the platform only decides whether
    // it is also indented and aligned.
    numbered: (items) => lines(items).map((t, i) => `${i + 1}. ${t}`).join('\n'),
  };
}

// ---- text somebody else wrote ----------------------------------------------
// A task title is the person's own words and may contain an asterisk. Passing
// it through means WhatsApp renders THEIR characters as emphasis: "לקנות חלב
// *דל לקטוז*" arrives with two words in bold that nobody chose to bold. The
// owner's call, after seeing it on a phone (2026-09-09), is to clean those
// markers rather than live with them.
//
// This is the other half of the no-escape-character problem, and the two
// defences are not interchangeable: `wrapInline` refuses to ADD emphasis to a
// value that already carries a marker, and this removes emphasis the value
// would otherwise produce on its own. Both stay. This one runs only on the
// VERBATIM path — a reminder, a first contact, a line in a group — because
// there is no model there to retype the words; anything a model writes is its
// own output and is not somebody else's text any more.
//
// The rule narrows rather than widens, because deleting a character out of
// somebody's words is a thing you get to be wrong about once. A pair is
// removed only when BOTH markers sit at a word boundary, which is the shape
// of emphasis a person typed on purpose. A marker glued inside a token is
// part of the token:
//
//   לקנות חלב *דל לקטוז*  →  the asterisks go, the words stay
//   report_final_v2       →  untouched; that underscore is the file's name
//   7~8 בערב              →  untouched; a lone marker pairs with nothing
//   3 * 4 שולחנות         →  untouched; the marker hugs no word
//
// The cost of that narrowness is that a stray slant can still survive a file
// name. That is the right way round — a mangled name is a worse message than
// an unintended italic, and Olma does not use italic herself.
const USER_MARKERS = ['*', '_', '~', '`'];

// What may follow a closing marker. Deliberately not `\\b`: the text is mostly
// Hebrew, where a word boundary between two Hebrew letters does not exist as
// far as JS is concerned.
const CLOSE_AFTER = '\\s.,!?;:)\\]}"\'\u05f3\u05f4';

function pairRe(marker) {
  const m = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)${m}(?!\\s)([^\\n${m === '`' ? '`' : m}]*?)(?<!\\s)${m}(?=$|[${CLOSE_AFTER}])`, 'gm');
}

function stripUserMarkup(value) {
  let s = String(value == null ? '' : value);
  for (const marker of USER_MARKERS) {
    const re = pairRe(marker);
    // Looped because removing one pair can put the next one at a boundary,
    // and because a title may carry two.
    for (let before = null; before !== s;) { before = s; s = s.replace(re, '$1$2'); }
  }
  return s;
}

// ---- what to do with a result ----------------------------------------------
// Styling a message is the MODEL's job on every path except the verbatim one,
// and the model is told what to do where it can act on it: on the tool result
// that produced the thing to style, never in a tool description and never in
// the doctrine. A description is injected on every turn for every user; a
// result costs tokens only on the turns it applies to. Same rule the kinds
// hint and set_my_timezone already follow.
//
// They live together here rather than one per tool so five tools cannot drift
// into five different phrasings of the same instruction, and so the whole
// house style can be read in one place.
//
// Each is deliberately a CEILING as much as a permission — "at most one", "not
// a sentence", "never a heading". The failure mode of this whole feature is
// not that the model ignores it, it is that the model enjoys it, and a morning
// digest that looks like a newsletter is worse than the paragraph it replaced.
const HINTS = Object.freeze({
  // D — the twelve tools that read a list back. "- " is a real WhatsApp list;
  // a comma-separated sentence is what these produced before.
  list: 'Lay these out as a WhatsApp list: "- " at the start of each line, one item per line, '
    + 'with a *bold* short heading above each group when there is more than one group. '
    + 'Never as a comma-separated sentence, and never a heading over a single line.',
  // C — the only styling here that changes what the person can DO.
  numberedChoice: 'Number the options "1. ", "2. ", "3. " on their own lines and tell them they '
    + 'can answer with just the number — that is the point of numbering them.',
  // B — what left is information, so it is shown leaving rather than removed.
  struckOut: 'Something that is no longer on the table is written ~struck through~ and kept in '
    + 'place rather than dropped: they need to see that it went, not to wonder whether it did.',
  // A — the visual form of a rule this system already enforces internally.
  quoteTheirWords: 'Their words go on a line of their own as a WhatsApp block quote — "> " at '
    + 'the start of every line of it — so the person can see what is theirs and what is yours. '
    + 'Quote the words, never the fence markers around them.',
});

// ---- the reference message --------------------------------------------------
// One message showing every style THIS channel renders, each next to its name
// and the characters that produce it, built from the table above so the demo
// and what the formatter actually does cannot drift apart.
//
// The syntax is shown inside inline code because markup is not interpreted
// there — the only way to put a literal `*` on a WhatsApp screen at all. Which
// is also why a style the channel cannot render is DROPPED rather than shown
// unrendered: with no inline code to hold them, its example and its syntax
// would arrive as the same bare characters, teaching a syntax that does
// nothing on the platform reading it.
//
// It is deliberately not a message_templates entry: nothing sends it on a
// schedule and nobody reads it twice. scripts/send-formatting-sampler.js is
// what puts it on a phone.
function sampler(lang = 'he', channelType = 'whatsapp') {
  const f = formatterFor(channelType);
  const he = lang !== 'en';
  const name = (s) => (he ? `${s.he} (${s.en})` : s.en);
  const syntax = (s) => (he ? s.syntaxHe : s.syntaxEn);
  const demo = he ? 'ככה זה נראה' : 'this is how it looks';
  const items = he ? ['פריט ראשון', 'פריט שני'] : ['first item', 'second item'];

  const rendered = {
    bold: () => f.bold(demo),
    italic: () => f.italic(demo),
    strikethrough: () => f.strikethrough(demo),
    monospace: () => f.monospace(demo),
    inlineCode: () => f.inlineCode(demo),
    quote: () => f.quote(demo),
    bulletedList: () => f.bullets(items),
    numberedList: () => f.numbered(items),
  };

  const shown = STYLES.filter((s) => f.can[s.key]);
  if (!shown.length) {
    return he
      ? 'הפלטפורמה הזאת לא יודעת להציג עיצוב טקסט — כל הודעה מגיעה כטקסט רגיל.'
      : 'This platform renders no text styling — every message arrives as plain text.';
  }

  const blocks = shown.map((s) => [
    f.bold(name(s)),
    rendered[s.key](),
    `${he ? 'כותבים' : 'you type'}: ${f.inlineCode(syntax(s))}`,
    '',
  ].join('\n'));

  return [
    f.bold(he ? 'כל הסגנונות שוואטסאפ יודע להציג' : 'Every style WhatsApp renders'),
    '',
    ...blocks,
    f.bold(he ? 'שילוב' : 'Combining'),
    f.bold(f.italic(he ? 'מודגש ונטוי יחד' : 'bold and italic together')),
    he
      ? 'אפשר לקנן סגנונות זה בזה, חוץ מרוחב-קבוע וקוד — אלה לא מצטרפים לאף אחד.'
      : 'Styles nest inside each other, except monospace and code — those combine with nothing.',
    '',
    f.bold(he ? 'מה שאין בוואטסאפ' : 'What WhatsApp has no syntax for'),
    f.bullets(UNSUPPORTED.map((u) => (he ? u.he : u.en))),
  ].join('\n');
}

module.exports = {
  STYLES, UNSUPPORTED, PLATFORMS, ALL_KEYS,
  capabilitiesFor, supports, formatterFor, sampler, stripUserMarkup, HINTS,
};
