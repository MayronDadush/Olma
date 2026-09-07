'use strict';
// The two pages allma.world has to serve to a stranger: a home page that
// explains what this is, and a privacy policy.
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
const BRAND = 'Allma - Personal Assistant';
const ASSISTANT = 'עולמה';
const WA_NUMBER = '972559347282';
const CONTACT_EMAIL = 'mayrondadush@gmail.com';

// Lifted from the signed-out welcome screen in docs/design/user-dashboard.html
// so the front door looks like the product, not like a legal notice someone
// bolted on. Only the tokens these two pages actually use were carried over.
const SHELL_CSS = `
:root{
  --bg:#F4F3F8;--surface:#FFFFFF;--surface-2:#FAF9FE;--sep:#E7E5F0;
  --text:#141322;--text-2:#6C6982;--text-3:#A29FB5;
  --accent:#5B2FD6;--accent-2:#4A22B4;--accent-soft:#EEE8FC;
  --shadow-m:0 1px 2px rgba(20,19,34,.05), 0 10px 28px -16px rgba(20,19,34,.28);
  --ease:cubic-bezier(.22,1,.36,1);
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#0C0B11;--surface:#181720;--surface-2:#1F1D29;--sep:#2A2836;
    --text:#F4F3FA;--text-2:#9D9AB2;--text-3:#6F6C82;
    --accent:#9D7BFF;--accent-2:#B49BFF;--accent-soft:#241C3D;
    --shadow-m:0 1px 2px rgba(0,0,0,.4), 0 10px 28px -16px rgba(0,0,0,.7);
  }
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  background:radial-gradient(125% 60% at 50% -8%, var(--accent-soft) 0%, transparent 62%), var(--bg);
  color:var(--text);
  font-family:'Assistant',system-ui,-apple-system,'Segoe UI',Arial,sans-serif;
  font-size:16px;line-height:1.6;
  min-height:100vh;
}
.wrap{max-width:720px;margin:0 auto;padding:44px 22px 64px}
.mark{width:76px;height:76px;filter:drop-shadow(0 14px 28px rgba(91,47,214,.28))}
.mark svg{width:100%;height:100%;display:block}
h1{
  font-family:'Rubik',system-ui,sans-serif;font-weight:700;
  font-size:40px;line-height:1.05;letter-spacing:-.02em;margin:20px 0 0;
}
h2{font-family:'Rubik',system-ui,sans-serif;font-weight:600;font-size:21px;margin:36px 0 10px;letter-spacing:-.01em}
h3{font-size:16.5px;font-weight:700;margin:22px 0 6px}
.lede{margin-top:11px;font-size:17px;color:var(--text-2);max-width:32em}
p{margin:0 0 12px}
ul{margin:0 0 14px;padding-inline-start:1.25em}
li{margin-bottom:7px}
a{color:var(--accent);text-decoration:none;border-bottom:1px solid transparent}
a:hover{border-bottom-color:currentColor}
.card{
  background:var(--surface);border-radius:16px;box-shadow:var(--shadow-m);
  padding:18px 20px;margin:14px 0;
}
.card h3{margin-top:0}
.card p:last-child{margin-bottom:0}
.perm{font-size:13.5px;color:var(--text-3);margin-top:6px}
.cta{
  display:inline-flex;align-items:center;gap:9px;margin-top:8px;
  background:var(--accent);color:#fff;border-radius:14px;
  padding:13px 22px;font-weight:600;font-size:16px;
  box-shadow:var(--shadow-m);border-bottom:0;
}
.cta:hover{background:var(--accent-2);border-bottom:0}
.foot{margin-top:44px;padding-top:18px;border-top:1px solid var(--sep);font-size:13px;color:var(--text-3)}
.foot a{color:var(--text-2)}
.he{margin-top:52px;padding-top:26px;border-top:1px solid var(--sep);direction:rtl;text-align:right}
.updated{font-size:13.5px;color:var(--text-3);margin-top:4px}
@media (prefers-reduced-motion:no-preference){
  .wrap>*{animation:rise .55s var(--ease) both}
  @keyframes rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
}
`;

const LOGO = `<svg viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${BRAND}">
  <defs>
    <linearGradient id="lg" x1="18" y1="10" x2="80" y2="86" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#7C4DFF"/><stop offset="1" stop-color="#4A22B4"/>
    </linearGradient>
    <clipPath id="lc"><circle cx="46" cy="44" r="32"/></clipPath>
  </defs>
  <path d="M46 12a32 32 0 0 1 32 32 32 32 0 0 1-32 32c-3.6 0-7-.6-10.2-1.7l-13.4 6a2.4 2.4 0 0 1-3.3-2.7l2.3-11.2A32 32 0 0 1 46 12Z" fill="url(#lg)"/>
  <g clip-path="url(#lc)" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round">
    <path d="M14 44h64" opacity=".5"/><ellipse cx="46" cy="44" rx="14.5" ry="32" opacity=".55"/>
  </g>
  <circle cx="70" cy="22" r="5.2" fill="#fff" opacity=".9"/>
</svg>`;

// English first, ltr by default: this is now the primary reading direction.
// The Hebrew section on each page opts back into rtl via the `.he` wrapper.
function shell(title, bodyHtml, { lang = 'en', dir = 'ltr' } = {}) {
  return `<!doctype html>
<html lang="${lang}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Assistant:wght@400;600;700&family=Rubik:wght@600;700&display=swap">
<style>${SHELL_CSS}</style>
</head>
<body><div class="wrap">${bodyHtml}</div></body>
</html>`;
}

// ---- home -------------------------------------------------------------------

// Google's reviewer reads this to decide whether the scopes we ask for match
// what the product says it does, so every capability below names the exact
// permission behind it and its limit. Said once in English, then again in
// Hebrew for the people actually using it today — same claims, both times.
function homePage() {
  return shell(`${BRAND} — a WhatsApp AI assistant`, `
    <div class="mark">${LOGO}</div>
    <h1>${BRAND}</h1>
    <p class="lede">A personal assistant that lives inside WhatsApp. Write to it in your own language — it remembers, reminds, and coordinates. Nothing to install.</p>

    <p><a class="cta" href="https://wa.me/${WA_NUMBER}">Start a WhatsApp chat</a></p>

    <h2>What it does</h2>
    <ul>
      <li><b>Tasks & reminders</b> — tell it once, and it reminds you at the right time.</li>
      <li><b>Meeting coordination</b> — between people connected to each other, including finding a time that works for everyone.</li>
      <li><b>Daily summary</b> — a short picture of your day, at a time you choose.</li>
      <li><b>Memory</b> — preferences and facts mentioned in conversation, so you never repeat yourself.</li>
    </ul>

    <h2>Connecting your Google account — your choice</h2>
    <p>${BRAND} works great with no connection at all. If you do connect, every permission is separate, requested only after you explicitly asked for it, and can be disconnected at any time.</p>

    <div class="card">
      <h3>Google Calendar</h3>
      <p>See what's on your calendar to answer "what do I have tomorrow", and suggest times that are genuinely free. If you also grant edit access, add an event you asked for.</p>
      <p class="perm">Permission: <code>calendar.readonly</code> for viewing only, or <code>calendar.events</code> if you also approved editing. You choose before the link is created.</p>
    </div>

    <div class="card">
      <h3>Google Contacts</h3>
      <p>Import names and numbers into your own private address book here, so you don't have to dictate a number already in your phone. The import is completely silent: it notifies nobody and tells no one that you use ${BRAND}.</p>
      <p class="perm">Permission: <code>contacts.readonly</code> — read-only.</p>
    </div>

    <h2>Privacy</h2>
    <p>We do not sell information and do not use it for advertising. Data from Google is used solely to answer you — not to train models, and not for any other purpose. <a href="/privacy">Full privacy policy</a>.</p>

    <div class="he">
      <div class="mark">${LOGO}</div>
      <h2>${ASSISTANT}</h2>
      <p class="lede">עוזרת אישית שחיה בתוך וואטסאפ. כותבים לה בשפה שלכם — היא זוכרת, מזכירה, ומתאמת. אין מה להתקין.</p>

      <p><a class="cta" href="https://wa.me/${WA_NUMBER}">פתיחת שיחה בוואטסאפ</a></p>

      <h3>מה היא עושה</h3>
      <ul>
        <li><b>משימות ותזכורות</b> — אומרים לה משהו פעם אחת, והיא מזכירה בזמן הנכון.</li>
        <li><b>תיאום פגישות</b> — בין אנשים שמחוברים זה לזה, כולל מציאת זמן שמתאים לכולם.</li>
        <li><b>סיכום יומי</b> — תמונה קצרה של היום, בשעה שבוחרים.</li>
        <li><b>זיכרון</b> — העדפות ועובדות שנאמרו בשיחה, כדי שלא צריך לחזור עליהן.</li>
      </ul>

      <h3>חיבור לחשבון הגוגל שלכם — לבחירתכם</h3>
      <p>${ASSISTANT} עובדת מצוין בלי שום חיבור. אם בכל זאת מחברים, כל הרשאה נפרדת, מתבקשת רק אחרי שביקשתם אותה במפורש, וניתנת לניתוק בכל רגע.</p>

      <div class="card">
        <h3>יומן Google</h3>
        <p>לראות מה יש ביומן כדי לענות על "מה יש לי מחר", ולהציע זמנים שפנויים באמת. אם תבחרו גם הרשאת עריכה — להוסיף אירוע שביקשתם.</p>
        <p class="perm">ההרשאה: <code>calendar.readonly</code> לצפייה בלבד, או <code>calendar.events</code> אם אישרתם גם עריכה. אתם בוחרים לפני שהקישור נוצר.</p>
      </div>

      <div class="card">
        <h3>אנשי קשר Google</h3>
        <p>ייבוא שמות ומספרים לפנקס הכתובות הפרטי שלכם כאן, כדי שלא תצטרכו להכתיב מספר שכבר קיים אצלכם בטלפון. הייבוא שקט לחלוטין: הוא לא שולח הודעה לאף אחד ולא מספר לאיש שאתם משתמשים ב${ASSISTANT}.</p>
        <p class="perm">ההרשאה: <code>contacts.readonly</code> — קריאה בלבד.</p>
      </div>

      <h3>פרטיות</h3>
      <p>אנחנו לא מוכרים מידע ולא משתמשים בו לפרסום. המידע מגוגל משמש אך ורק כדי לענות לכם — לא לאימון מודלים ולא לשום שימוש אחר. <a href="/privacy">מדיניות הפרטיות המלאה</a>.</p>
    </div>

    <div class="foot">
      <p>allma.world · <a href="/privacy">Privacy Policy</a> · <a href="/terms">Terms of Service</a> · <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>
    </div>
  `);
}

// ---- privacy ----------------------------------------------------------------

// English first because that is what a Google reviewer reads, Hebrew in full
// below because that is what the people using this today read. Neither is a
// summary of the other — a policy that says different things in two
// languages is worse than one language.
const UPDATED = '2026-09-06';

function privacyPage() {
  return shell(`Privacy Policy — ${BRAND}`, `
    <div class="mark">${LOGO}</div>
    <h1>Privacy Policy</h1>
    <p class="updated">Last updated: ${UPDATED}</p>

    <h2>Who we are</h2>
    <p>${BRAND} (allma.world) is a personal assistant that works over WhatsApp, operated by an individual developer. Contact: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>

    <h2>What we store</h2>
    <ul>
      <li><b>Account details</b> — the phone number you write from, a first name if you gave one, timezone and language preference.</li>
      <li><b>Conversation content</b> — your messages and the assistant's replies, so the conversation stays coherent.</li>
      <li><b>What you asked it to remember</b> — tasks, reminders, meetings, preferences and facts.</li>
      <li><b>Google data</b> — only if you connected it, and only under the scopes you approved.</li>
    </ul>

    <h2>Google user data</h2>
    <p>Connecting Google is optional. Each permission is requested separately on Google's own consent screen, and you may grant some and decline others.</p>
    <ul>
      <li><b>Calendar</b> (<code>calendar.readonly</code> or <code>calendar.events</code>) — read events to answer questions about your schedule and propose genuinely free times; create or edit an event only if you granted edit access and explicitly asked for it.</li>
      <li><b>Contacts</b> (<code>contacts.readonly</code>) — import names and numbers into a private address book on your own account. The import notifies nobody and discloses to no third party that you use the service.</li>
      <li><b>Account email address</b> (<code>userinfo.email</code>) — to show you which account is connected, and to invite participants to a calendar event when you coordinate a meeting.</li>
    </ul>

    <h2>Limited Use</h2>
    <p>Our use and transfer of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements. Specifically: Google user data is used solely to provide the user-facing features described above; it is not sold; it is not used for advertising; and it is not used to train generalized models.</p>

    <h2>Who we share with</h2>
    <p>We do not sell data and do not share it with advertisers. To operate the service, data is processed by:</p>
    <ul>
      <li><b>Model provider</b> — conversation text is sent to a language model via OpenRouter (currently DeepSeek, with Anthropic as fallback) to compose a reply.</li>
      <li><b>WhatsApp / Meta</b> — the channel messages arrive and are sent over.</li>
      <li><b>Twilio</b> — only if you used a voice call.</li>
      <li><b>Google</b> — only for the services you connected yourself.</li>
    </ul>
    <p>Otherwise, data is disclosed only where required by law.</p>

    <h2>Where it is stored</h2>
    <p>Data is held in a database on a dedicated server in the United States (DigitalOcean). Google access and refresh tokens are encrypted at rest (AES-256-GCM) with the key held outside the database. A daily backup is retained for 14 days and then deleted.</p>

    <h2>Deletion and control</h2>
    <ul>
      <li><b>Disconnect Google</b> — ask the assistant to disconnect any service at any time. We delete our stored token and revoke it with Google.</li>
      <li>You can also revoke access directly from your <a href="https://myaccount.google.com/permissions">Google account permissions</a>.</li>
      <li><b>Pause</b> — ask the assistant to stop reaching out. This is a reversible pause, not a deletion.</li>
      <li><b>Delete everything</b> — email <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a> and the account and all associated data are deleted.</li>
    </ul>

    <h2>Children</h2>
    <p>The service is not intended for anyone under 16.</p>

    <h2>Changes</h2>
    <p>If this policy changes materially, the date at the top is updated and we tell you in the conversation.</p>

    <div class="he">
      <h2>מדיניות פרטיות (עברית)</h2>
      <p class="updated">עודכן: ${UPDATED}</p>

      <h3>מי אנחנו</h3>
      <p>${ASSISTANT} (allma.world) היא עוזרת אישית שפועלת דרך וואטסאפ. השירות מופעל על ידי מפעיל יחיד; לפניות: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>

      <h3>איזה מידע נשמר</h3>
      <ul>
        <li><b>פרטי החשבון</b> — מספר הטלפון שדרכו אתם כותבים, שם פרטי אם מסרתם, אזור זמן והעדפות שפה.</li>
        <li><b>תוכן השיחה</b> — ההודעות שאתם כותבים ל${ASSISTANT} והתשובות שלה, כדי שהשיחה תמשיך להיות רציפה.</li>
        <li><b>מה שביקשתם שתזכור</b> — משימות, תזכורות, פגישות, העדפות ועובדות.</li>
        <li><b>מידע מגוגל</b> — רק אם חיברתם, ורק לפי ההרשאות שאישרתם (פירוט למטה).</li>
      </ul>

      <h3>מידע מחשבון גוגל</h3>
      <p>החיבור לגוגל הוא בחירה, לא תנאי. כל הרשאה מתבקשת בנפרד ובמסך ההסכמה של גוגל עצמה, ואפשר לאשר חלק ולסרב לשאר.</p>
      <ul>
        <li><b>יומן</b> (<code>calendar.readonly</code> או <code>calendar.events</code>) — לקרוא אירועים כדי לענות על שאלות לגבי הלו"ז ולהציע זמנים פנויים, ולהוסיף או לערוך אירוע רק אם אישרתם הרשאת עריכה וביקשתם זאת.</li>
        <li><b>אנשי קשר</b> (<code>contacts.readonly</code>) — לייבא שמות ומספרים לפנקס כתובות פרטי בחשבון שלכם. הייבוא לא שולח הודעה לאיש ולא חושף לאף צד שלישי שאתם משתמשים בשירות.</li>
        <li><b>כתובת המייל של החשבון</b> (<code>userinfo.email</code>) — כדי להציג לכם לאיזה חשבון התחברתם, וכדי לצרף משתתפים להזמנה ליומן כשאתם מתאמים פגישה.</li>
      </ul>

      <h3>שימוש מוגבל (Limited Use)</h3>
      <p>השימוש שלנו במידע שמתקבל מממשקי Google, והעברתו, עומדים ב<a href="https://developers.google.com/terms/api-services-user-data-policy">מדיניות נתוני המשתמש של שירותי Google API</a>, לרבות דרישות ה-Limited Use. באופן קונקרטי: המידע מגוגל משמש אך ורק כדי לספק לכם את התכונות שתיארנו למעלה; הוא אינו נמכר; אינו משמש לפרסום; ואינו משמש לאימון מודלים כלליים.</p>

      <h3>עם מי המידע נחלק</h3>
      <p>איננו מוכרים מידע ואיננו מעבירים אותו למפרסמים. כדי שהשירות יעבוד, מידע עובר לספקים הבאים ולהם בלבד:</p>
      <ul>
        <li><b>ספק המודל</b> — טקסט השיחה נשלח למודל שפה דרך OpenRouter (כיום DeepSeek, עם Anthropic כגיבוי) כדי לחבר תשובה.</li>
        <li><b>וואטסאפ / Meta</b> — הערוץ שדרכו ההודעות מגיעות ונשלחות.</li>
        <li><b>Twilio</b> — רק אם השתמשתם בשיחה קולית.</li>
        <li><b>Google</b> — רק עבור השירותים שחיברתם בעצמכם.</li>
      </ul>
      <p>מעבר לכך, מידע נמסר רק אם חובה על פי דין.</p>

      <h3>איפה זה נשמר</h3>
      <p>המידע יושב במסד נתונים על שרת ייעודי בארצות הברית (DigitalOcean). אסימוני הגישה לגוגל מוצפנים במנוחה (AES-256-GCM) והמפתח נשמר מחוץ למסד הנתונים. מתבצע גיבוי יומי שנשמר 14 יום ואז נמחק.</p>

      <h3>מחיקה ושליטה</h3>
      <ul>
        <li><b>ניתוק גוגל</b> — אפשר לבקש מ${ASSISTANT} לנתק כל שירות בכל רגע. אנחנו מוחקים את האסימון אצלנו ומבטלים אותו מול גוגל.</li>
        <li>אפשר גם לבטל את הגישה ישירות דרך <a href="https://myaccount.google.com/permissions">ההרשאות בחשבון הגוגל שלכם</a>.</li>
        <li><b>השהיה</b> — אפשר לבקש מ${ASSISTANT} להפסיק ליזום פנייה. זו השהיה הפיכה, לא מחיקה.</li>
        <li><b>מחיקת הכל</b> — פנייה ל<a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a> תמחק את החשבון ואת כל המידע הקשור אליו.</li>
      </ul>

      <h3>ילדים</h3>
      <p>השירות אינו מיועד לגילאים מתחת ל-16.</p>

      <h3>שינויים</h3>
      <p>אם המדיניות תשתנה באופן מהותי, התאריך בראש העמוד יתעדכן ונודיע בשיחה.</p>
    </div>

    <div class="foot">
      <p><a href="/">allma.world</a> · <a href="/terms">Terms of Service</a> · <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>
    </div>
  `);
}

// ---- terms of service ---------------------------------------------------

// Google's Branding page asks for an "Application Terms of Service link" —
// optional for verification itself, but Google shows a warning without one
// and a real product should have terms regardless. Same house rule as the
// privacy policy: English first in full, Hebrew second in full, neither a
// summary of the other.
function termsPage() {
  return shell(`Terms of Service — ${BRAND}`, `
    <div class="mark">${LOGO}</div>
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
    <p>You may stop using the service at any time. Ask the assistant to pause, or email <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a> to delete your account and all associated data. The developer may suspend or terminate access for a violation of these terms, or discontinue the service entirely, with reasonable notice where practical.</p>

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
      <p>ניתן להפסיק את השימוש בשירות בכל רגע. בקשו מהעוזרת להשהות, או שלחו מייל ל<a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a> למחיקת החשבון וכל המידע הקשור אליו. המפעיל רשאי להשעות או לסיים גישה במקרה של הפרת תנאים אלה, או להפסיק את השירות כליל, בהודעה סבירה מראש כאשר הדבר מעשי.</p>

      <h3>שינויים בתנאים</h3>
      <p>אם תנאים אלה ישתנו באופן מהותי, התאריך בראש העמוד יתעדכן ונודיע על כך בשיחה.</p>

      <h3>יצירת קשר</h3>
      <p><a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>
    </div>

    <div class="foot">
      <p><a href="/">allma.world</a> · <a href="/privacy">Privacy Policy</a> · <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>
    </div>
  `);
}

module.exports = { homePage, privacyPage, termsPage, BRAND, ASSISTANT, CONTACT_EMAIL, UPDATED };
