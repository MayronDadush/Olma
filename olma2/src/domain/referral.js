'use strict';
// A friend's invitation to Allma, and how we know one when it arrives
// (owner, 2026-09-30 — the growth plan to 100 weekly active users).
//
// The person shares a message from their page (docs/design/user-dashboard.html,
// the home tab). It carries a wa.me link that opens a chat with Allma with the
// friend's first words already typed, and those words carry a five-character
// code. When the friend sends them, the intake sweep finds the code in their
// first message and writes `users.joined_via = 'friend_link'` and
// `referred_by_user_id` (migration 101).
//
// The code is the user id run through a bijection, never a stored column: the
// read model behind the page reads and nothing else (domain/user-dashboard.js),
// so a code minted lazily on first view would have been a write in a reader,
// and a column minted at provisioning would have needed a backfill and a
// uniqueness retry. Guessing one buys nothing but a wrong line in a growth
// table. The id itself is already in the page's own payload.
//
// Nothing here sends anything. The friend writes first, which is the one
// shape of first contact that cannot get the number reported.

// 30 symbols — no I, L, O, Z, 0 or 1, nothing a person misreads — five of
// them: 24.3M codes.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXY23456789';
const BASE = BigInt(ALPHABET.length);
const LEN = 5;
const N = BASE ** BigInt(LEN);
// Coprime with 30, so multiplying by it permutes 0..N-1.
const P = 9_999_991n;
const OFFSET = 1_234_567n;

function modInverse(a, m) {
  let [r0, r1] = [a % m, m];
  let [s0, s1] = [1n, 0n];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  return ((s0 % m) + m) % m;
}
const P_INV = modInverse(P, N);

const WA_NUMBER = String(process.env.OLMA_WA_NUMBER || '972559347282').replace(/\D/g, '');

// id → five characters. Null for anything that is not a positive id in range.
function codeFor(userId) {
  let id;
  try { id = BigInt(userId); } catch { return null; }
  if (id <= 0n || id >= N) return null;
  let v = (id * P + OFFSET) % N;
  let out = '';
  for (let i = 0; i < LEN; i++) { out = ALPHABET[Number(v % BASE)] + out; v /= BASE; }
  return out;
}

// five characters → id, or null. Exact inverse of codeFor.
function idFor(code) {
  if (typeof code !== 'string' || code.length !== LEN) return null;
  let v = 0n;
  for (const ch of code) {
    const d = ALPHABET.indexOf(ch);
    if (d < 0) return null;
    v = v * BASE + BigInt(d);
  }
  const id = (((v - OFFSET) % N + N) % N * P_INV) % N;
  return id > 0n ? Number(id) : null;
}

// Every standalone run of five code characters in a message, as candidate ids.
// Uppercase only, with no letter or digit either side: the code is pasted by a
// link, never typed, so a lowercase or embedded match is somebody's word.
const TOKEN_RE = new RegExp(`(?<![A-Za-z0-9])[${ALPHABET}]{${LEN}}(?![A-Za-z0-9])`, 'g');
function candidateIds(text) {
  if (typeof text !== 'string' || !text) return [];
  const ids = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const id = idFor(m[0]);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

// Who invited the person writing `text` from `phone`, or null. A candidate
// counts only if it names a real, provisioned person who is not them: a random
// five-letter word that happens to decode lands in a 24M space holding a few
// dozen ids, and this is where such a miss is refused.
async function referrerFor(client, text, phone) {
  for (const id of candidateIds(text)) {
    const { rows } = await client.query(
      `SELECT id FROM users
        WHERE id = $1 AND status = 'active' AND agent_id IS NOT NULL
          AND NOT is_eval AND phone IS DISTINCT FROM $2`,
      [id, phone || null]);
    if (rows[0]) return Number(rows[0].id);
  }
  return null;
}

const COPY = {
  he: {
    // What the FRIEND sends Allma. Their words, so gender-neutral about both of
    // them; the name is the inviter's, exactly as they spell it.
    firstWords: (name, code) => (name
      ? `היי עולמה 👋 הגעתי דרך ${name} (קוד ${code})`
      : `היי עולמה 👋 הגעתי בהמלצה (קוד ${code})`),
    // What the PERSON sends their friend. Plural address, so it fits anybody.
    share: (link) => `מכירים את עולמה? 😊 עוזרת אישית בוואטסאפ למשימות, תזכורות ותיאום פגישות — הכל בהודעה. אפשר להתחיל כאן:\n${link}`,
  },
  en: {
    firstWords: (name, code) => (name
      ? `Hi Allma 👋 ${name} sent me (code ${code})`
      : `Hi Allma 👋 a friend sent me (code ${code})`),
    share: (link) => `Have you met Allma? 😊 A personal assistant on WhatsApp for tasks, reminders and scheduling, all by message. Start here:\n${link}`,
  },
};
const lang = (locale) => (String(locale || '').toLowerCase().startsWith('en') ? 'en' : 'he');

// Everything the page needs to offer an invitation, or null when there is no
// id to build one from. `share` is the text they send; `shareUrl` opens
// WhatsApp's own picker with it; `link` is the chat-with-Allma link inside it.
function inviteFor({ id, firstName, locale }) {
  const code = codeFor(id);
  if (!code) return null;
  const c = COPY[lang(locale)];
  const name = typeof firstName === 'string' ? firstName.trim() : '';
  const link = `https://wa.me/${WA_NUMBER}?text=${encodeURIComponent(c.firstWords(name, code))}`;
  const share = c.share(link);
  return { code, link, share, shareUrl: `https://wa.me/?text=${encodeURIComponent(share)}` };
}

module.exports = { codeFor, idFor, candidateIds, referrerFor, inviteFor, ALPHABET, WA_NUMBER };
