'use strict';
// The pages allma.world has to serve to a stranger: a home page that
// explains what this is, a privacy policy, terms, and (since 2026-09-28) an
// accessibility statement.
//
// They exist because Google's OAuth verification requires both — an app
// asking for calendar or contacts scopes must have a working home page
// describing its functionality and a reachable privacy policy on the same
// verified domain, or the "Google hasn't verified this app" screen never
// goes away. Until now allma.world answered 404 to everything except
// four allowlisted routes (see CLAUDE.md, "Two hostnames"), which is exactly
// right for a dashboard nobody should reach and exactly wrong for this.
//
// English first, Hebrew second: the product's own users are mostly Hebrew
// speakers today, but Google's verification reviewer reads English, and the
// company is meant to go global. Both languages say the same thing in full —
// neither is a summary of the other, because a policy that says different
// things in two languages is worse than one language. The brand string
// "Allma - Personal Assistant" must stay byte-identical to the OAuth consent
// screen's configured App name (Google Auth Platform → Branding), or
// verification flags a name mismatch between the app and its homepage.
//
// TWO THINGS THAT MUST STAY TRUE, because a verification reviewer checks
// them and because they are the honest description either way:
//
//   1. Every permission named here matches a scope the code actually
//      requests (domain/google-connect.js). Claiming less than we ask for
//      fails review; claiming more is a lie to the user — and, since
//      2026-09-07, claiming more can also cost money. These pages described
//      Gmail (`gmail.readonly`) for a day after the tools that used it were
//      deleted, and a RESTRICTED scope named on the privacy policy is a
//      restricted scope as far as a reviewer reading that page is concerned:
//      the free sensitive track is decided by what the app DECLARES, in the
//      console and here alike, never by what it happens to call.
//   2. The Limited Use paragraph is not decoration — it is the specific
//      disclosure Google requires for sensitive scopes.
//
// No JS, no forms, no state: these are the only two pages in this codebase a
// completely unauthenticated stranger can read, so they get no moving parts.
// Their fonts come from this file's own response since 2026-09-29, never from
// Google: a privacy policy whose page hands the reader's IP to Google before
// it has said a word about privacy is the one page that must not (fonts.js).
const { FONT_CSS } = require('./fonts');
const { linkCard } = require('./link-card');

const BRAND = 'Allma - Personal Assistant';
const ASSISTANT = 'עולמה';
const WA_NUMBER = '972559347282';
const CONTACT_EMAIL = 'info@allma.world';
const { markSvg } = require('./brand-mark');

// The brand the owner chose on 2026-09-28, Cypress + Mustard: sand ground and
// cypress ink. (The home page's cypress band and mustard button went with the
// home page itself, 2026-09-29: `/` is the locked dashboard now.) The
// same day tokens the /me dashboard carries
// (docs/design/user-dashboard.html), so the front door and the product are
// one thing. Only the tokens these pages actually use were carried over.
// ALWAYS light, whatever the phone is set to (the owner, 2026-09-29): this is
// the first impression, and there is no toggle here to change it. The
// dashboard keeps its own day/night.
const SHELL_CSS = `
:root{
  color-scheme:light;
  --bg:#F0EDE5;--surface:#FFFFFF;--sep:#D7D6CF;
  --text:#0E1F1E;--text-2:#44504E;--text-3:#646D6A;
  --link:#004643;--code:#E6ECEC;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  background:var(--bg);color:var(--text);
  font-family:'IBM Plex Sans Hebrew','IBM Plex Sans',system-ui,-apple-system,'Segoe UI',Arial,sans-serif;
  font-size:16px;line-height:1.6;
  min-height:100vh;
}
.wrap{max-width:720px;margin:0 auto;padding:44px 22px 64px}
.mark{width:72px;height:72px}
.mark svg{width:100%;height:100%;display:block}
h1{font-weight:700;font-size:38px;line-height:1.08;letter-spacing:-.02em;margin:20px 0 0;text-wrap:balance}
h2{font-weight:700;font-size:21px;margin:36px 0 10px;letter-spacing:-.01em;text-wrap:balance}
h3{font-size:16.5px;font-weight:600;margin:22px 0 6px}
.lede{margin-top:11px;font-size:17px;color:var(--text-2);max-width:32em}
p{margin:0 0 12px}
ul{margin:0 0 14px;padding-inline-start:1.25em}
li{margin-bottom:7px}
a{color:var(--link);text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px}
code{font-family:'IBM Plex Mono',ui-monospace,Menlo,monospace;font-size:.86em;background:var(--code);border-radius:6px;padding:1px 6px}
.card{background:var(--surface);border:1px solid var(--sep);border-radius:18px;padding:18px 20px;margin:14px 0}
.card h3{margin-top:0}
.card p:last-child{margin-bottom:0}
.perm{font-size:13.5px;color:var(--text-3);margin-top:6px}
.foot{margin-top:44px;padding-top:18px;border-top:1px solid var(--sep);font-size:13px;color:var(--text-3)}
.foot a{color:var(--text-2)}
.he{margin-top:52px;padding-top:26px;border-top:1px solid var(--sep);direction:rtl;text-align:right}
.updated{font-size:13.5px;color:var(--text-3);margin-top:4px}
.he.only{margin-top:0;padding-top:0;border-top:0}
.langbar{display:flex;justify-content:flex-end;margin-bottom:8px}
.lang{display:inline-flex;align-items:center;min-height:44px;padding:0 16px;border:1px solid var(--sep);border-radius:99px;
  background:var(--surface);color:var(--text);font-size:14.5px;font-weight:600;text-decoration:none}
.lang:hover{text-decoration:underline}
`;

// The round mark with its ring, on sand: the dark half is cypress and the
// ring follows the text colour. `id` keeps its clip paths apart from any
// other mark on the page.
const LOGO_PAGE = markSvg({ variant: 'round', id: 'lp', ring: 'currentColor' })
  .replace('<svg ', `<svg role="img" aria-label="${BRAND}" `);

// ONE language per page, English by default, with a switch at the top (the
// owner, 2026-09-29). Every page is still written as the English text followed
// by its Hebrew twin in a `.he` block, and `oneLanguage` cuts the page down to
// one of them: `?lang=he` is the Hebrew, anything else the English. Chosen on
// the SERVER, from the query string, so it needs no script and no cookie, and
// Caddy's allowlist matches the path, so no Caddyfile change. The choice rides
// every link between the policy pages, and the footer is drawn here, in the
// page's language, rather than by each page. `/` is the locked dashboard
// (user-dashboard.js), which has languages of its own, so it is linked bare.
const PAGES = [
  ['/', 'allma.world', 'allma.world'],
  ['/privacy', 'Privacy Policy', 'מדיניות פרטיות'],
  ['/terms', 'Terms of Service', 'תנאי שימוש'],
  ['/accessibility', 'Accessibility', 'נגישות'],
];

function langOf(q) { return q === 'he' ? 'he' : 'en'; }
function hrefFor(path, lang) { return lang === 'he' && path !== '/' ? `${path}?lang=he` : path; }

function footFor(path, lang) {
  const links = PAGES.filter(([p]) => p !== path)
    .map(([p, en, he]) => `<a href="${hrefFor(p, lang)}">${lang === 'he' ? he : en}</a>`);
  return `<div class="foot"><p>${[...links, `<a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>`].join(' · ')}</p></div>`;
}

// The switch names the OTHER language in that language, so a reader who
// cannot read this page can still find theirs.
function langSwitch(path, lang) {
  return lang === 'he'
    ? `<nav class="langbar" aria-label="Language"><a class="lang" href="${path}" lang="en" hreflang="en">English</a></nav>`
    : `<nav class="langbar" aria-label="שפה"><a class="lang" href="${path}?lang=he" lang="he" hreflang="he">עברית</a></nav>`;
}

// Keeps one language of a page written as English + `.he` block + footer. In
// Hebrew the block's first heading becomes the page's title, its sections move
// up a level to match the English, and links to our own pages keep the choice.
function oneLanguage(bodyHtml, lang) {
  const he = bodyHtml.indexOf('<div class="he"');
  const foot = bodyHtml.indexOf('<div class="foot">');
  if (he < 0 || foot < he) throw new Error('a public page must be English, then a .he block, then its footer');
  if (lang !== 'he') return bodyHtml.slice(0, he);
  return bodyHtml.slice(he, foot)
    .replace(/<div class="he"( lang="he")?>/, `<div class="he only"><div class="mark">${LOGO_PAGE}</div>`)
    .replace(/<h3>/g, '<h2>').replace(/<\/h3>/g, '</h2>')
    .replace(/<h2>([^<]*?)(?: \(עברית\))?<\/h2>/, '<h1>$1</h1>')
    .replace(/href="(\/(?:privacy|terms|accessibility))"/g, 'href="$1?lang=he"');
}

function shell(title, bodyHtml, { lang = 'en', path = '/' } = {}) {
  const dir = lang === 'he' ? 'rtl' : 'ltr';
  const body = `${langSwitch(path, lang)}${oneLanguage(bodyHtml, lang)}${footFor(path, lang)}`;
  return `<!doctype html>
<html lang="${lang}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#004643">
<link rel="icon" type="image/png" sizes="192x192" href="/icons/icon-192.png">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
${linkCard({ lang, title, path: path + (lang === 'he' ? '?lang=he' : '') })}
<title>${title}</title>
<style>${FONT_CSS}
${SHELL_CSS}</style>
</head>
<body><div class="wrap">${body}</div></body>
</html>`;
}

// ---- home -------------------------------------------------------------------

// Google's reviewer reads this to decide whether the scopes we ask for match
// what the product says it does, so every capability below names the exact
// permission behind it and its limit. Said once in English, then again in
// Hebrew for the people actually using it today — same claims, both times.
// What the front door says Allma is. Since 2026-09-29 `/` is the locked
// dashboard and this text sits under it (user-dashboard.js); the standalone
// home page it was written for is gone, so this is the only copy of what
// Google's reviewer reads. `k` names each class, because the dashboard is one
// CSS namespace and `.he` there is already somebody's.
const HOME_LEDE = 'A personal assistant that lives inside WhatsApp. Write to it in your own language — it remembers, reminds, and coordinates. Nothing to install.';
function homeSections(k = (n) => n) {
  return `
    <h2>What it does</h2>
    <ul>
      <li><b>Tasks & reminders</b> — tell it once, and it reminds you at the right time.</li>
      <li><b>Meeting coordination</b> — between people connected to each other, including finding a time that works for everyone.</li>
      <li><b>Daily summary</b> — a short picture of your day, at a time you choose.</li>
      <li><b>Memory</b> — preferences and facts mentioned in conversation, so you never repeat yourself.</li>
    </ul>

    <h2>Connecting your Google account — your choice</h2>
    <p>${BRAND} works great with no connection at all. If you do connect, every permission is separate, requested only after you explicitly asked for it, and can be disconnected at any time.</p>

    <div class="${k('card')}">
      <h3>Google Calendar</h3>
      <p>See what's on your calendar to answer "what do I have tomorrow", and suggest times that are genuinely free. If you also grant edit access, add an event you asked for.</p>
      <p class="${k('perm')}">Permission: <code>calendar.readonly</code> for viewing only, or <code>calendar.events</code> if you also approved editing. You choose before the link is created.</p>
    </div>

    <div class="${k('card')}">
      <h3>Google Contacts</h3>
      <p>Import names and numbers into your own private address book here, so you don't have to dictate a number already in your phone. The import is completely silent: it notifies nobody and tells no one that you use ${BRAND}.</p>
      <p class="${k('perm')}">Permission: <code>contacts.readonly</code> — read-only.</p>
    </div>

    <h2>Privacy</h2>
    <p>We do not sell information and do not use it for advertising. Data from Google is used solely to answer you — not to train models, and not for any other purpose. <a href="/privacy">Full privacy policy</a>.</p>

    <div class="${k('he')}">
      <div class="${k('mark')}">${LOGO_PAGE}</div>
      <h2>${ASSISTANT}</h2>
      <p class="${k('lede')}">עוזרת אישית שחיה בתוך וואטסאפ. כותבים לה בשפה שלכם — היא זוכרת, מזכירה, ומתאמת. אין מה להתקין.</p>

      <p><a class="${k('cta')}" href="https://wa.me/${WA_NUMBER}">פתיחת שיחה בוואטסאפ</a></p>

      <h3>מה היא עושה</h3>
      <ul>
        <li><b>משימות ותזכורות</b> — אומרים לה משהו פעם אחת, והיא מזכירה בזמן הנכון.</li>
        <li><b>תיאום פגישות</b> — בין אנשים שמחוברים זה לזה, כולל מציאת זמן שמתאים לכולם.</li>
        <li><b>סיכום יומי</b> — תמונה קצרה של היום, בשעה שבוחרים.</li>
        <li><b>זיכרון</b> — העדפות ועובדות שנאמרו בשיחה, כדי שלא צריך לחזור עליהן.</li>
      </ul>

      <h3>חיבור לחשבון הגוגל שלכם — לבחירתכם</h3>
      <p>${ASSISTANT} עובדת מצוין בלי שום חיבור. אם בכל זאת מחברים, כל הרשאה נפרדת, מתבקשת רק אחרי שביקשתם אותה במפורש, וניתנת לניתוק בכל רגע.</p>

      <div class="${k('card')}">
        <h3>יומן Google</h3>
        <p>לראות מה יש ביומן כדי לענות על "מה יש לי מחר", ולהציע זמנים שפנויים באמת. אם תבחרו גם הרשאת עריכה — להוסיף אירוע שביקשתם.</p>
        <p class="${k('perm')}">ההרשאה: <code>calendar.readonly</code> לצפייה בלבד, או <code>calendar.events</code> אם אישרתם גם עריכה. אתם בוחרים לפני שהקישור נוצר.</p>
      </div>

      <div class="${k('card')}">
        <h3>אנשי קשר Google</h3>
        <p>ייבוא שמות ומספרים לפנקס הכתובות הפרטי שלכם כאן, כדי שלא תצטרכו להכתיב מספר שכבר קיים אצלכם בטלפון. הייבוא שקט לחלוטין: הוא לא שולח הודעה לאף אחד ולא מספר לאיש שאתם משתמשים ב${ASSISTANT}.</p>
        <p class="${k('perm')}">ההרשאה: <code>contacts.readonly</code> — קריאה בלבד.</p>
      </div>

      <h3>פרטיות</h3>
      <p>אנחנו לא מוכרים מידע ולא משתמשים בו לפרסום. המידע מגוגל משמש אך ורק כדי לענות לכם — לא לאימון מודלים ולא לשום שימוש אחר. <a href="/privacy">מדיניות הפרטיות המלאה</a>.</p>
    </div>

    <div class="${k('foot')}">
      <p>allma.world · <a href="/privacy">Privacy Policy</a> · <a href="/terms">Terms of Service</a> · <a href="/accessibility">Accessibility</a> · <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>
    </div>
`;
}

// ---- privacy ----------------------------------------------------------------

// English first because that is what a Google reviewer reads, Hebrew in full
// below because that is what the people using this today read. Neither is a
// summary of the other — a policy that says different things in two
// languages is worse than one language.
//
// Rewritten 2026-09-28 (compliance review, findings 1-4 and 7). Every claim
// here was checked against the code and the live box that day, and the
// previous version had drifted in four places: the off-box backup is in
// Frankfurt for 30 days, not the US for 14; voice notes, calls and the model's
// hosts reach processors it did not name; groups were not mentioned at all;
// and "all associated data are deleted" was not what deletion did. The
// Privacy Protection Law s.11 (after Amendment 13) also asks for four things
// it lacked: who the controller is, whether giving the data is obligatory,
// what refusing costs, and the rights of access and correction.
//
// RETENTION: the owner's decision (2026-09-28) is that nothing is deleted on a
// timer — what a person gave is kept until THEY ask to delete it, group
// members who never wrote to her included. Only the backups age out, and a
// deletion request is carried out within deletionDays. A number here with no
// code behind it is this page lying again.
//
// No name on the page (owner, 2026-09-28): the contact is the service's own
// address. s.11 asks for the controller's identity; that choice is the
// owner's, flagged for the lawyer.
const UPDATED = '2026-09-29';
const PRIVACY_UPDATED = '2026-09-29';
// The session cookie's life, from the code that sets it, so the sentence
// about it cannot drift from what the browser is actually told.
const SESSION_DAYS = require('../../domain/dashboard-auth').SESSION_IDLE_DAYS;
const RETENTION = {
  deletionDays: 30, localBackupDays: 14, offboxBackupDays: 30,
};

function privacyPage(lang = 'en') {
  const R = RETENTION;
  return shell(lang === 'he' ? `מדיניות פרטיות — ${ASSISTANT}` : `Privacy Policy — ${BRAND}`, `
    <div class="mark">${LOGO_PAGE}</div>
    <h1>Privacy Policy</h1>
    <p class="updated">Last updated: ${PRIVACY_UPDATED}</p>

    <h2>Who is responsible for your data</h2>
    <p>${BRAND} (allma.world) is a personal AI assistant that works over WhatsApp. It is operated from Israel. For anything about your privacy, email <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a> or just tell the assistant.</p>

    <h2>Do you have to give us anything</h2>
    <p>No. There is no legal obligation to give us any information; it is entirely your choice. Without your phone number and what you write, the assistant cannot work. Without anything else it still works, just less tailored to you.</p>

    <h2>What we store and why</h2>
    <ul>
      <li><b>Account details</b> — your phone number, name, timezone and language, so we know who you are and when we may write to you.</li>
      <li><b>Conversation content</b> — your messages, including voice notes, and the assistant's replies, so the conversation stays coherent.</li>
      <li><b>What you asked it to remember</b> — tasks, reminders, meetings, preferences and facts you shared. Facts can include sensitive personal information, for example about health, if you chose to share it.</li>
      <li><b>Details you filled in on your page</b>, such as a date of birth and how you prefer to be addressed.</li>
      <li><b>Phone calls</b>, if you used them — a transcript of the call, to keep what was agreed. The call audio itself is not recorded.</li>
      <li><b>Google data</b> — only if you connected it, and only under the scopes you approved (below).</li>
    </ul>

    <h2>WhatsApp groups</h2>
    <p>When the assistant is added to a group, it sees the member list (numbers and display names) and the messages that tag it. It keeps the member list to coordinate between everyone. A group member who has not written to the assistant may get one private message from it about a plan in that group; if they do not reply, it does not write again. The member list is kept, as part of the group's own list that everyone in it already sees, until someone asks for their details to be deleted — write to the assistant on WhatsApp and ask, even if you never used it before.</p>

    <h2>Google user data</h2>
    <p>Connecting Google is optional. Each permission is requested separately on Google's own consent screen, and you may grant some and decline others.</p>
    <ul>
      <li><b>Calendar</b> (<code>calendar.readonly</code> or <code>calendar.events</code>) — read events to answer questions about your schedule and propose genuinely free times; create or edit an event only if you granted edit access and explicitly asked for it.</li>
      <li><b>Contacts</b> (<code>contacts.readonly</code>) — import names and numbers into a private address book on your own account. The import notifies nobody and discloses to no third party that you use the service.</li>
      <li><b>Account email address</b> (<code>userinfo.email</code>) — to show you which account is connected, and to invite participants to a calendar event when you coordinate a meeting.</li>
    </ul>

    <h2>Limited Use</h2>
    <p>Our use and transfer of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements. Specifically: Google user data is used solely to provide the user-facing features described above; it is not sold; it is not used for advertising; and it is not used to train generalized models. When it is needed to answer you, it is part of the conversation sent to the language model provider listed below, under the same terms.</p>

    <h2>Who we share with</h2>
    <p>We do not sell data and do not use it for advertising. To operate the service, data is processed by these providers and no others:</p>
    <ul>
      <li><b>Language model</b> — conversation text, including calendar and contact details when they are relevant to the answer, is sent through OpenRouter (US) to the providers that run the model — currently Novita, StreamLake, DeepInfra and Together, or another host OpenRouter picks when those are unavailable; StreamLake's location has not been verified — and, if those fail, to Anthropic (US). They are configured not to store or train on it.</li>
      <li><b>ElevenLabs</b> — transcribing voice notes, and the voice on phone calls.</li>
      <li><b>Deepgram</b> — transcription during phone calls.</li>
      <li><b>Twilio</b> — phone calls.</li>
      <li><b>WhatsApp / Meta</b> — the channel messages arrive and are sent over.</li>
      <li><b>DigitalOcean</b> — the server (US) and the backup (Germany).</li>
      <li><b>Google</b> — only for the services you connected yourself.</li>
    </ul>
    <p>Otherwise, data is disclosed only where required by law.</p>

    <h2>Where it is stored</h2>
    <p>Data is held in a database on a dedicated server in the United States (DigitalOcean). A daily backup is kept on that server and a copy in a private DigitalOcean storage bucket in Frankfurt, Germany. Google access and refresh tokens are encrypted at rest (AES-256-GCM) with the key held outside the database.</p>

    <h2>How long it is kept</h2>
    <ul>
      <li>Everything — your account, tasks, what the assistant remembers, conversation content, voice notes and phone call transcripts: until you ask to delete it. Nothing is deleted on a timer.</li>
      <li>Backups: ${R.localBackupDays} days on the server and ${R.offboxBackupDays} days in the off-site copy, then deleted.</li>
      <li>A record of consents and connections (for example, when you connected Google) is kept after deletion, so we can show we acted on what you approved.</li>
    </ul>

    <h2>Your rights</h2>
    <ul>
      <li><b>See your data</b> — much of it is on your personal page, and you can ask for the rest.</li>
      <li><b>Correct it</b> — ask the assistant, change it on your page, or email us.</li>
      <li><b>Delete everything</b> — tell the assistant, or use the button on your personal page. We delete the account and all associated data within ${R.deletionDays} days, except the backups, which expire on their own within ${R.offboxBackupDays} days, and the consent record above.</li>
      <li><b>Pause</b> — ask the assistant to stop reaching out. This is a reversible pause, not a deletion.</li>
      <li><b>Disconnect Google</b> — ask the assistant to disconnect any service at any time; we delete our stored token and revoke it with Google. You can also revoke access directly from your <a href="https://myaccount.google.com/permissions">Google account permissions</a>.</li>
    </ul>

    <h2>Cookies and your browser</h2>
    <p>Your personal page uses one cookie, only to keep you signed in; it expires after ${SESSION_DAYS} days without a visit. Your browser also remembers a few display choices for the page (day or night, whether you have seen a tip) and keeps an offline screen for when there is no connection. None of it is used for tracking or advertising, and nothing on these pages loads anything from another company.</p>

    <h2>Children</h2>
    <p>The service is not intended for anyone under 16.</p>

    <h2>Changes</h2>
    <p>If this policy changes materially, the date at the top is updated and the assistant tells you in the conversation.</p>

    <div class="he">
      <h2>מדיניות פרטיות (עברית)</h2>
      <p class="updated">עודכן: ${PRIVACY_UPDATED}</p>

      <h3>מי אחראי על המידע</h3>
      <p>${ASSISTANT} (allma.world) היא עוזרת AI אישית שפועלת דרך וואטסאפ. השירות מופעל מישראל. לכל פנייה בנושא פרטיות: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>, או פשוט לכתוב ל${ASSISTANT}.</p>

      <h3>האם חובה למסור מידע</h3>
      <p>לא. אין חובה חוקית למסור לנו מידע, והכל לפי רצונכם. בלי מספר טלפון ותוכן השיחה ${ASSISTANT} לא יכולה לעבוד. בלי כל שאר המידע היא עובדת, רק פחות מותאם אליכם.</p>

      <h3>איזה מידע נשמר ולמה</h3>
      <ul>
        <li><b>פרטי חשבון</b> — מספר הטלפון, שם, אזור זמן ושפה. כדי לדעת מי אתם ומתי מותר לכתוב לכם.</li>
        <li><b>תוכן השיחה</b> — ההודעות שלכם, כולל הודעות קוליות, והתשובות של ${ASSISTANT}. כדי שהשיחה תהיה רציפה.</li>
        <li><b>מה שביקשתם לזכור</b> — משימות, תזכורות, פגישות, העדפות ועובדות שסיפרתם. עובדות יכולות לכלול מידע אישי רגיש, למשל על בריאות, אם בחרתם לספר.</li>
        <li><b>פרטים שמילאתם בדף האישי</b>, כמו תאריך לידה ולשון פנייה.</li>
        <li><b>שיחות טלפון</b>, אם השתמשתם בהן — תמליל השיחה, כדי לשמור מה שסוכם. השיחה עצמה לא מוקלטת.</li>
        <li><b>מידע מגוגל</b> — רק אם חיברתם, ורק לפי ההרשאות שאישרתם (פירוט למטה).</li>
      </ul>

      <h3>קבוצות וואטסאפ</h3>
      <p>כשמוסיפים את ${ASSISTANT} לקבוצה, היא רואה את רשימת החברים (מספרים ושמות תצוגה) ואת ההודעות שמתייגות אותה. היא שומרת את רשימת החברים כדי לתאם בין כולם. חבר קבוצה שעוד לא כתב לה יכול לקבל ממנה הודעה פרטית אחת על תיאום בקבוצה. אם לא עונים, היא לא כותבת שוב. רשימת החברים נשמרת, כחלק מרשימת הקבוצה שכל חבריה רואים ממילא, עד שמישהו מבקש למחוק את הפרטים שלו — פשוט לכתוב ל${ASSISTANT} בוואטסאפ ולבקש, גם בלי שהשתמשתם בה קודם.</p>

      <h3>מידע מחשבון גוגל</h3>
      <p>החיבור לגוגל הוא בחירה, לא תנאי. כל הרשאה מתבקשת בנפרד ובמסך ההסכמה של גוגל עצמה, ואפשר לאשר חלק ולסרב לשאר.</p>
      <ul>
        <li><b>יומן</b> (<code>calendar.readonly</code> או <code>calendar.events</code>) — לקרוא אירועים כדי לענות על שאלות לגבי הלו"ז ולהציע זמנים פנויים, ולהוסיף או לערוך אירוע רק אם אישרתם הרשאת עריכה וביקשתם זאת.</li>
        <li><b>אנשי קשר</b> (<code>contacts.readonly</code>) — לייבא שמות ומספרים לפנקס כתובות פרטי בחשבון שלכם. הייבוא לא שולח הודעה לאיש ולא חושף לאף צד שלישי שאתם משתמשים בשירות.</li>
        <li><b>כתובת המייל של החשבון</b> (<code>userinfo.email</code>) — כדי להציג לכם לאיזה חשבון התחברתם, וכדי לצרף משתתפים להזמנה ליומן כשאתם מתאמים פגישה.</li>
      </ul>

      <h3>שימוש מוגבל (Limited Use)</h3>
      <p>השימוש שלנו במידע שמתקבל מממשקי Google, והעברתו, עומדים ב<a href="https://developers.google.com/terms/api-services-user-data-policy">מדיניות נתוני המשתמש של שירותי Google API</a>, לרבות דרישות ה-Limited Use. באופן קונקרטי: המידע מגוגל משמש אך ורק כדי לספק לכם את התכונות שתיארנו למעלה; הוא אינו נמכר; אינו משמש לפרסום; ואינו משמש לאימון מודלים כלליים. כשהוא נחוץ כדי לענות לכם, הוא חלק מהשיחה שנשלחת לספק המודל שמופיע למטה, באותם תנאים.</p>

      <h3>עם מי המידע עובר</h3>
      <p>אנחנו לא מוכרים מידע ולא משתמשים בו לפרסום. כדי שהשירות יעבוד, מידע עובר לספקים האלה בלבד:</p>
      <ul>
        <li><b>מודל השפה</b> — טקסט השיחה, כולל מידע מהיומן ומאנשי הקשר כשהוא רלוונטי לתשובה, נשלח דרך OpenRouter (ארה״ב) לספקים שמריצים את המודל — כרגע Novita, ‏StreamLake, ‏DeepInfra ו־Together, או ספק אחר ש־OpenRouter בוחר כשהם לא זמינים; המיקום של StreamLake לא אומת — ובמקרה תקלה ל־Anthropic (ארה״ב). הגדרנו שהספקים לא ישמרו את המידע ולא יאמנו עליו.</li>
        <li><b>ElevenLabs</b> — תמלול הודעות קוליות, וקול בשיחות טלפון.</li>
        <li><b>Deepgram</b> — תמלול בשיחות טלפון.</li>
        <li><b>Twilio</b> — שיחות טלפון.</li>
        <li><b>וואטסאפ / Meta</b> — הערוץ שדרכו ההודעות עוברות.</li>
        <li><b>DigitalOcean</b> — השרת (ארה״ב) והגיבוי (גרמניה).</li>
        <li><b>Google</b> — רק השירותים שחיברתם בעצמכם.</li>
      </ul>
      <p>מעבר לזה, מידע נמסר רק אם החוק מחייב.</p>

      <h3>איפה זה נשמר</h3>
      <p>המידע נשמר במסד נתונים על שרת ייעודי בארצות הברית (DigitalOcean). גיבוי יומי נשמר על השרת, ועותק שלו בדלי אחסון פרטי של DigitalOcean בפרנקפורט, גרמניה. אסימוני הגישה לגוגל מוצפנים במנוחה (AES-256-GCM) והמפתח נשמר מחוץ למסד הנתונים.</p>

      <h3>כמה זמן זה נשמר</h3>
      <ul>
        <li>הכל — החשבון, המשימות, מה ש${ASSISTANT} זוכרת, תוכן השיחה, הודעות קוליות ותמלילי שיחות טלפון: עד שתבקשו למחוק. שום דבר לא נמחק אוטומטית לפי זמן.</li>
        <li>גיבויים: ${R.localBackupDays} יום בשרת ו־${R.offboxBackupDays} יום בגיבוי החיצוני, ואז הם נמחקים.</li>
        <li>תיעוד של הסכמות וחיבורים (למשל מתי חיברתם את גוגל) נשמר גם אחרי מחיקה, כדי שנוכל להראות שפעלנו לפי מה שאישרתם.</li>
      </ul>

      <h3>הזכויות שלכם</h3>
      <ul>
        <li><b>לעיין במידע שלכם</b> — הרבה ממנו מופיע בדף האישי, ואת השאר אפשר לבקש.</li>
        <li><b>לתקן מידע לא נכון</b> — לבקש מ${ASSISTANT}, לשנות בדף האישי או לכתוב לנו.</li>
        <li><b>למחוק הכל</b> — לבקש מ${ASSISTANT}, או ללחוץ על הכפתור בדף האישי. אנחנו מוחקים את החשבון ואת כל המידע הקשור אליו תוך ${R.deletionDays} יום, חוץ מהגיבויים, שנמחקים לבד בתוך ${R.offboxBackupDays} יום, ומתיעוד ההסכמות שלמעלה.</li>
        <li><b>להשהות</b> — לבקש מ${ASSISTANT} להפסיק לפנות אליכם. זו השהיה הפיכה, לא מחיקה.</li>
        <li><b>לנתק את גוגל</b> — לבקש מ${ASSISTANT} לנתק כל שירות בכל רגע; אנחנו מוחקים את האסימון אצלנו ומבטלים אותו מול גוגל. אפשר גם לבטל ישירות דרך <a href="https://myaccount.google.com/permissions">ההרשאות בחשבון הגוגל שלכם</a>.</li>
      </ul>

      <h3>עוגיות והדפדפן</h3>
      <p>הדף האישי שלכם משתמש בעוגייה אחת, רק כדי שתישארו מחוברים. היא פגה אחרי ${SESSION_DAYS} יום בלי ביקור. הדפדפן גם זוכר כמה בחירות תצוגה של הדף (יום או לילה, האם כבר ראיתם טיפ) ושומר מסך למצב בלי חיבור. שום דבר מזה לא משמש למעקב או לפרסום, ואף דף כאן לא טוען שום דבר מחברה אחרת.</p>

      <h3>ילדים</h3>
      <p>השירות לא מיועד למי שמתחת לגיל 16.</p>

      <h3>שינויים</h3>
      <p>אם המדיניות תשתנה באופן מהותי, התאריך למעלה יתעדכן ו${ASSISTANT} תודיע לכם בשיחה.</p>
    </div>

    <div class="foot">
      <p><a href="/">allma.world</a> · <a href="/terms">Terms of Service</a> · <a href="/accessibility">Accessibility</a> · <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>
    </div>
  `, { lang, path: '/privacy' });
}

// ---- terms of service ---------------------------------------------------

// Google's Branding page asks for an "Application Terms of Service link" —
// optional for verification itself, but Google shows a warning without one
// and a real product should have terms regardless. Same house rule as the
// privacy policy: English first in full, Hebrew second in full, neither a
// summary of the other.
function termsPage(lang = 'en') {
  return shell(lang === 'he' ? `תנאי שימוש — ${ASSISTANT}` : `Terms of Service — ${BRAND}`, `
    <div class="mark">${LOGO_PAGE}</div>
    <h1>Terms of Service</h1>
    <p class="updated">Last updated: ${UPDATED}</p>

    <h2>Agreement</h2>
    <p>These terms govern your use of ${BRAND} (allma.world), a personal assistant that operates over WhatsApp, operated by an individual developer. By starting a conversation with the assistant, you agree to these terms and to the <a href="/privacy">Privacy Policy</a>, which describes what data is collected and how it is used.</p>

    <h2>The service</h2>
    <p>${BRAND} answers messages, keeps reminders and tasks, coordinates meetings between connected people, and — only if you choose to connect it — reads (and, where you explicitly grant it, edits) Google Calendar and Contacts on your behalf. The service is provided as-is and may change, and features may be added or removed, without prior notice.</p>

    <h2>Acceptable use</h2>
    <p>Use the service only for your own personal, lawful purposes. Do not use it to harass, impersonate, or send unsolicited messages to others; do not attempt to access another person's account or data; do not attempt to disrupt, reverse-engineer, or overload the service.</p>

    <h2>Your account</h2>
    <p>Your account is tied to the WhatsApp number you write from. You are responsible for the security of that number and of any Google account you connect. Connecting Google is entirely optional and can be undone at any time — ask the assistant to disconnect, or revoke access directly from your <a href="https://myaccount.google.com/permissions">Google account permissions</a>.</p>

    <h2>No warranty</h2>
    <p>The service is provided without warranties of any kind, express or implied. A reminder, a calendar read, or a coordinated meeting time may be delayed, wrong, or not delivered — do not rely on it for anything where that failure would cause serious harm (medical, legal, financial, or safety-critical decisions).</p>

    <h2>Limitation of liability</h2>
    <p>To the maximum extent permitted by law, the developer is not liable for any indirect, incidental, or consequential damages arising from use of, or inability to use, the service.</p>

    <h2>Ending the service</h2>
    <p>You may stop using the service at any time. Ask the assistant to pause; to delete your account and all associated data, ask the assistant or use the button on your personal page. The developer may suspend or terminate access for a violation of these terms, or discontinue the service entirely, with reasonable notice where practical.</p>

    <h2>Changes to these terms</h2>
    <p>If these terms change materially, the date at the top is updated and you are told in the conversation.</p>

    <h2>Contact</h2>
    <p><a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>

    <div class="he">
      <h2>תנאי שימוש (עברית)</h2>
      <p class="updated">עודכן: ${UPDATED}</p>

      <h3>הסכמה</h3>
      <p>תנאים אלה חלים על השימוש ב${ASSISTANT} (allma.world), עוזרת אישית שפועלת דרך וואטסאפ ומופעלת על ידי מפעיל יחיד. פתיחת שיחה עם העוזרת מהווה הסכמה לתנאים אלה ול<a href="/privacy">מדיניות הפרטיות</a>, המפרטת אילו נתונים נאספים וכיצד נעשה בהם שימוש.</p>

      <h3>השירות</h3>
      <p>${ASSISTANT} עונה להודעות, שומרת תזכורות ומשימות, מתאמת פגישות בין אנשים מחוברים, ו — רק אם תבחרו לחבר — קוראת (ובמקום שאישרתם עריכה במפורש, גם עורכת) יומן Google ואנשי קשר בשמכם. השירות ניתן כפי שהוא (as-is), ותכונות עשויות להשתנות, להתווסף או להוסר, ללא הודעה מוקדמת.</p>

      <h3>שימוש מותר</h3>
      <p>השתמשו בשירות אך ורק למטרות אישיות וחוקיות. אין להשתמש בו כדי להטריד, להתחזות, או לשלוח הודעות לא רצויות לאחרים; אין לנסות לגשת לחשבון או למידע של אדם אחר; אין לנסות לשבש, להנדס לאחור, או להעמיס על השירות.</p>

      <h3>החשבון שלכם</h3>
      <p>החשבון שלכם מקושר למספר הוואטסאפ שדרכו אתם כותבים. אתם אחראים לאבטחת המספר הזה ושל כל חשבון Google שתחברו. חיבור גוגל הוא לגמרי אופציונלי וניתן לביטול בכל רגע — בקשו מהעוזרת לנתק, או בטלו את הגישה ישירות דרך <a href="https://myaccount.google.com/permissions">ההרשאות בחשבון הגוגל שלכם</a>.</p>

      <h3>ללא אחריות</h3>
      <p>השירות ניתן ללא אחריות מכל סוג, מפורשת או משתמעת. תזכורת, קריאת יומן, או תיאום זמן פגישה עלולים להתעכב, לטעות, או לא להגיע — אין להסתמך על השירות בכל דבר שבו כשל כזה יגרום לנזק חמור (החלטות רפואיות, משפטיות, כספיות, או קריטיות לבטיחות).</p>

      <h3>הגבלת אחריות</h3>
      <p>ככל שהחוק מתיר זאת, המפעיל אינו אחראי לכל נזק עקיף, תוצאתי או מקרי הנובע מהשימוש בשירות או מחוסר היכולת להשתמש בו.</p>

      <h3>סיום השימוש</h3>
      <p>ניתן להפסיק את השימוש בשירות בכל רגע. בקשו מהעוזרת להשהות. למחיקת החשבון וכל המידע הקשור אליו, בקשו מהעוזרת או לחצו על הכפתור בדף האישי. המפעיל רשאי להשעות או לסיים גישה במקרה של הפרת תנאים אלה, או להפסיק את השירות כליל, בהודעה סבירה מראש כאשר הדבר מעשי.</p>

      <h3>שינויים בתנאים</h3>
      <p>אם תנאים אלה ישתנו באופן מהותי, התאריך בראש העמוד יתעדכן ונודיע על כך בשיחה.</p>

      <h3>יצירת קשר</h3>
      <p><a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>
    </div>

    <div class="foot">
      <p><a href="/">allma.world</a> · <a href="/privacy">Privacy Policy</a> · <a href="/accessibility">Accessibility</a> · <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>
    </div>
  `, { lang, path: '/terms' });
}

// ---- accessibility statement ------------------------------------------------

// Israel's Equal Rights for Persons with Disabilities (Service Accessibility)
// Regulations, reg. 35, ask a service provider with a website to publish an
// accessibility statement. Olma is likely exempt (reg. 35ו(ז)) and publishes
// one anyway: finding 10 of the 2026-09-28 compliance review. The Hebrew is
// the owner's wording, verbatim; the English says the same thing. No person is
// named: the owner's decision of 2026-09-29 for every public page is the shared
// address and no name, so the coordinator line was dropped with it.
const A11Y_UPDATED = '2026-09-28';
const A11Y_RESPONSE_DAYS = 7;

// TRUE because docs/design/user-dashboard.html disables zoom in its viewport
// meta today (line 16). When the PR that restores pinch-zoom merges, set this
// to false (or delete it and the two sentences it guards), or the statement
// confesses a limitation that no longer exists.
const PINCH_ZOOM_DISABLED = true;

function accessibilityPage(lang = 'en') {
  const mail = `<a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>`;
  return shell(lang === 'he' ? `הצהרת נגישות — ${ASSISTANT}` : `Accessibility Statement — ${BRAND}`, `
    <div class="mark">${LOGO_PAGE}</div>
    <h1>Accessibility Statement</h1>
    <p class="updated">Last updated: ${A11Y_UPDATED}</p>

    <p>${BRAND} works mainly inside WhatsApp, so your phone's own accessibility tools (screen reader, larger text, dictation) work with it as usual. You can also send it a voice message instead of typing.</p>
    <p>The personal page on allma.world was built to the guidelines of Israeli Standard 5568 and WCAG 2.0 at level AA: it can be navigated with a keyboard, focus is clearly marked, the colours meet the contrast requirements, and animations stop for anyone who has asked for reduced motion.</p>
    ${PINCH_ZOOM_DISABLED ? `<p>We know that the personal page cannot currently be enlarged by pinching. You can enlarge the text through your phone's font settings.</p>` : ''}
    <p>Ran into a problem? Write "accessibility problem" to the assistant on WhatsApp, or email ${mail}, and we will get back to you within ${A11Y_RESPONSE_DAYS} days.</p>

    <div class="he" lang="he">
      <h2>הצהרת נגישות</h2>
      <p>${ASSISTANT} פועלת בעיקר בתוך וואטסאפ, כך שכלי הנגישות של הטלפון שלכם (קורא מסך, הגדלת טקסט, הכתבה) עובדים איתה כרגיל. אפשר גם לשלוח לה הודעה קולית במקום לכתוב.</p>
      <p>הדף האישי באתר allma.world נבנה לפי ההנחיות של תקן ישראלי 5568 ו־WCAG 2.0 ברמה AA: אפשר לנווט בו עם מקלדת, יש סימון פוקוס ברור, הצבעים עומדים בדרישות הניגודיות, ואנימציות נעצרות למי שביקש להפחית תנועה.</p>
      ${PINCH_ZOOM_DISABLED ? `<p>ידוע לנו שכרגע אי אפשר להגדיל את הדף האישי בצביטה. אפשר להגדיל טקסט דרך הגדרות הגופן של הטלפון.</p>` : ''}
      <p>נתקלתם בבעיה? כתבו ל${ASSISTANT} בוואטסאפ "בעיית נגישות", או למייל ${mail}, ונחזור אליכם תוך ${A11Y_RESPONSE_DAYS} ימים.</p>
      <p class="updated">עודכן: ${A11Y_UPDATED}</p>
    </div>

    <div class="foot">
      <p><a href="/">allma.world</a> · <a href="/privacy">Privacy Policy</a> · <a href="/terms">Terms of Service</a> · ${mail}</p>
    </div>
  `, { lang, path: '/accessibility' });
}

module.exports = {
  homeSections, HOME_LEDE, privacyPage, termsPage, accessibilityPage, langOf, BRAND, ASSISTANT, CONTACT_EMAIL, UPDATED,
  PRIVACY_UPDATED, RETENTION, A11Y_UPDATED, PINCH_ZOOM_DISABLED,
};
