'use strict';
// The two pages allma.world has to serve to a stranger: a home page that
// explains what this is, and a privacy policy.
//
// They exist because Google's OAuth verification requires both — an app
// asking for calendar, contacts or Gmail scopes must have a working home
// page describing its functionality and a reachable privacy policy on the
// same verified domain, or the "Google hasn't verified this app" screen
// never goes away. Until now allma.world answered 404 to everything except
// four allowlisted routes (see CLAUDE.md, "Two hostnames"), which is exactly
// right for a dashboard nobody should reach and exactly wrong for this.
//
// TWO THINGS THAT MUST STAY TRUE, because a verification reviewer checks
// them and because they are the honest description either way:
//
//   1. Every permission named here matches a scope the code actually
//      requests (domain/google-oauth.js, mail-gmail.js). Claiming less than
//      we ask for fails review; claiming more is a lie to the user.
//   2. The Limited Use paragraph is not decoration — it is the specific
//      disclosure Google requires for sensitive and restricted scopes.
//
// No JS, no forms, no state: these are the only two pages in this codebase a
// completely unauthenticated stranger can read, so they get no moving parts.
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
.en{margin-top:52px;padding-top:26px;border-top:1px solid var(--sep);direction:ltr;text-align:left}
.updated{font-size:13.5px;color:var(--text-3);margin-top:4px}
@media (prefers-reduced-motion:no-preference){
  .wrap>*{animation:rise .55s var(--ease) both}
  @keyframes rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
}
`;

const LOGO = `<svg viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${ASSISTANT}">
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

function shell(title, bodyHtml, { lang = 'he', dir = 'rtl' } = {}) {
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
// permission behind it and its limit.
function homePage() {
  return shell(`${ASSISTANT} — עוזרת אישית בוואטסאפ`, `
    <div class="mark">${LOGO}</div>
    <h1>${ASSISTANT}</h1>
    <p class="lede">עוזרת אישית שחיה בתוך וואטסאפ. כותבים לה בשפה שלכם — היא זוכרת, מזכירה, ומתאמת. אין מה להתקין.</p>

    <p><a class="cta" href="https://wa.me/${WA_NUMBER}">פתיחת שיחה בוואטסאפ</a></p>

    <h2>מה היא עושה</h2>
    <ul>
      <li><b>משימות ותזכורות</b> — אומרים לה משהו פעם אחת, והיא מזכירה בזמן הנכון.</li>
      <li><b>תיאום פגישות</b> — בין אנשים שמחוברים זה לזה, כולל מציאת זמן שמתאים לכולם.</li>
      <li><b>סיכום יומי</b> — תמונה קצרה של היום, בשעה שבוחרים.</li>
      <li><b>זיכרון</b> — העדפות ועובדות שנאמרו בשיחה, כדי שלא צריך לחזור עליהן.</li>
    </ul>

    <h2>חיבור לחשבון הגוגל שלכם — לבחירתכם</h2>
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

    <div class="card">
      <h3>Gmail</h3>
      <p>לחפש בתיבה שלכם כשאתם מבקשים — "מה כתבו לי מבית הספר?" — ולפתוח הודעה אחת כדי לענות. ${ASSISTANT} <b>לא</b> עוברת על המיילים מיוזמתה, ולא יכולה לשלוח, להשיב, למחוק או לתייק כלום.</p>
      <p class="perm">ההרשאה: <code>gmail.readonly</code> — קריאה בלבד. אין הרשאת שליחה, ואין כלי שמסוגל לשלוח.</p>
    </div>

    <h2>פרטיות</h2>
    <p>אנחנו לא מוכרים מידע ולא משתמשים בו לפרסום. המידע מגוגל משמש אך ורק כדי לענות לכם — לא לאימון מודלים ולא לשום שימוש אחר. <a href="/privacy">מדיניות הפרטיות המלאה</a>.</p>

    <div class="foot">
      <p>allma.world · <a href="/privacy">מדיניות פרטיות</a> · <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>
    </div>
  `);
}

// ---- privacy ----------------------------------------------------------------

// Hebrew first because that is what the people using this read, English in
// full below because that is what a Google reviewer reads. Neither is a
// summary of the other — a policy that says different things in two
// languages is worse than one language.
const UPDATED = '2026-09-04';

function privacyPage() {
  return shell(`מדיניות פרטיות — ${ASSISTANT}`, `
    <div class="mark">${LOGO}</div>
    <h1>מדיניות פרטיות</h1>
    <p class="updated">עודכן: ${UPDATED}</p>

    <h2>מי אנחנו</h2>
    <p>${ASSISTANT} (allma.world) היא עוזרת אישית שפועלת דרך וואטסאפ. השירות מופעל על ידי מפעיל יחיד; לפניות: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>

    <h2>איזה מידע נשמר</h2>
    <ul>
      <li><b>פרטי החשבון</b> — מספר הטלפון שדרכו אתם כותבים, שם פרטי אם מסרתם, אזור זמן והעדפות שפה.</li>
      <li><b>תוכן השיחה</b> — ההודעות שאתם כותבים ל${ASSISTANT} והתשובות שלה, כדי שהשיחה תמשיך להיות רציפה.</li>
      <li><b>מה שביקשתם שתזכור</b> — משימות, תזכורות, פגישות, העדפות ועובדות.</li>
      <li><b>מידע מגוגל</b> — רק אם חיברתם, ורק לפי ההרשאות שאישרתם (פירוט למטה).</li>
    </ul>

    <h2>מידע מחשבון גוגל</h2>
    <p>החיבור לגוגל הוא בחירה, לא תנאי. כל הרשאה מתבקשת בנפרד ובמסך ההסכמה של גוגל עצמה, ואפשר לאשר חלק ולסרב לשאר.</p>
    <ul>
      <li><b>יומן</b> (<code>calendar.readonly</code> או <code>calendar.events</code>) — לקרוא אירועים כדי לענות על שאלות לגבי הלו"ז ולהציע זמנים פנויים, ולהוסיף או לערוך אירוע רק אם אישרתם הרשאת עריכה וביקשתם זאת.</li>
      <li><b>אנשי קשר</b> (<code>contacts.readonly</code>) — לייבא שמות ומספרים לפנקס כתובות פרטי בחשבון שלכם. הייבוא לא שולח הודעה לאיש ולא חושף לאף צד שלישי שאתם משתמשים בשירות.</li>
      <li><b>Gmail</b> (<code>gmail.readonly</code>) — לחפש בתיבה ולפתוח הודעה בודדת, <b>רק כשאתם מבקשים במפורש</b>. אין סריקה יזומה, אין תהליך רקע שקורא מיילים, ואין יכולת טכנית לשלוח, להשיב, למחוק או לתייק.</li>
      <li><b>כתובת המייל של החשבון</b> (<code>userinfo.email</code>) — כדי להציג לכם לאיזה חשבון התחברתם, וכדי לצרף משתתפים להזמנה ליומן כשאתם מתאמים פגישה.</li>
    </ul>

    <h2>שימוש מוגבל (Limited Use)</h2>
    <p>השימוש שלנו במידע שמתקבל מממשקי Google, והעברתו, עומדים ב<a href="https://developers.google.com/terms/api-services-user-data-policy">מדיניות נתוני המשתמש של שירותי Google API</a>, לרבות דרישות ה-Limited Use. באופן קונקרטי: המידע מגוגל משמש אך ורק כדי לספק לכם את התכונות שתיארנו למעלה; הוא אינו נמכר; אינו משמש לפרסום; ואינו משמש לאימון מודלים כלליים.</p>

    <h2>עם מי המידע נחלק</h2>
    <p>איננו מוכרים מידע ואיננו מעבירים אותו למפרסמים. כדי שהשירות יעבוד, מידע עובר לספקים הבאים ולהם בלבד:</p>
    <ul>
      <li><b>ספק המודל</b> — טקסט השיחה נשלח למודל שפה דרך OpenRouter (כיום DeepSeek, עם Anthropic כגיבוי) כדי לחבר תשובה.</li>
      <li><b>וואטסאפ / Meta</b> — הערוץ שדרכו ההודעות מגיעות ונשלחות.</li>
      <li><b>Twilio</b> — רק אם השתמשתם בשיחה קולית.</li>
      <li><b>Google</b> — רק עבור השירותים שחיברתם בעצמכם.</li>
    </ul>
    <p>מעבר לכך, מידע נמסר רק אם חובה על פי דין.</p>

    <h2>איפה זה נשמר</h2>
    <p>המידע יושב במסד נתונים על שרת ייעודי באירופה (DigitalOcean). אסימוני הגישה לגוגל מוצפנים במנוחה (AES-256-GCM) והמפתח נשמר מחוץ למסד הנתונים. מתבצע גיבוי יומי שנשמר 14 יום ואז נמחק.</p>

    <h2>מחיקה ושליטה</h2>
    <ul>
      <li><b>ניתוק גוגל</b> — אפשר לבקש מ${ASSISTANT} לנתק כל שירות בכל רגע. אנחנו מוחקים את האסימון אצלנו ומבטלים אותו מול גוגל.</li>
      <li>אפשר גם לבטל את הגישה ישירות דרך <a href="https://myaccount.google.com/permissions">ההרשאות בחשבון הגוגל שלכם</a>.</li>
      <li><b>השהיה</b> — אפשר לבקש מ${ASSISTANT} להפסיק ליזום פנייה. זו השהיה הפיכה, לא מחיקה.</li>
      <li><b>מחיקת הכל</b> — פנייה ל<a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a> תמחק את החשבון ואת כל המידע הקשור אליו.</li>
    </ul>

    <h2>ילדים</h2>
    <p>השירות אינו מיועד לגילאים מתחת ל-16.</p>

    <h2>שינויים</h2>
    <p>אם המדיניות תשתנה באופן מהותי, התאריך בראש העמוד יתעדכן ונודיע בשיחה.</p>

    <div class="en">
      <h2>Privacy Policy (English)</h2>
      <p class="updated">Last updated: ${UPDATED}</p>

      <h3>Who we are</h3>
      <p>${ASSISTANT} / Allma (allma.world) is a personal assistant that works over WhatsApp, operated by an individual developer. Contact: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>

      <h3>What we store</h3>
      <ul>
        <li><b>Account details</b> — the phone number you write from, a first name if you gave one, timezone and language preference.</li>
        <li><b>Conversation content</b> — your messages and the assistant's replies, so the conversation stays coherent.</li>
        <li><b>What you asked it to remember</b> — tasks, reminders, meetings, preferences and facts.</li>
        <li><b>Google data</b> — only if you connected it, and only under the scopes you approved.</li>
      </ul>

      <h3>Google user data</h3>
      <p>Connecting Google is optional. Each permission is requested separately on Google's own consent screen, and you may grant some and decline others.</p>
      <ul>
        <li><b>Calendar</b> (<code>calendar.readonly</code> or <code>calendar.events</code>) — read events to answer questions about your schedule and propose genuinely free times; create or edit an event only if you granted edit access and explicitly asked for it.</li>
        <li><b>Contacts</b> (<code>contacts.readonly</code>) — import names and numbers into a private address book on your own account. The import notifies nobody and discloses to no third party that you use the service.</li>
        <li><b>Gmail</b> (<code>gmail.readonly</code>) — search your mailbox and open a single message, <b>only when you explicitly ask</b>. There is no proactive scanning, no background job that reads mail, and no technical ability to send, reply, delete or file anything.</li>
        <li><b>Account email address</b> (<code>userinfo.email</code>) — to show you which account is connected, and to invite participants to a calendar event when you coordinate a meeting.</li>
      </ul>

      <h3>Limited Use</h3>
      <p>Our use and transfer of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements. Specifically: Google user data is used solely to provide the user-facing features described above; it is not sold; it is not used for advertising; and it is not used to train generalized models.</p>

      <h3>Who we share with</h3>
      <p>We do not sell data and do not share it with advertisers. To operate the service, data is processed by:</p>
      <ul>
        <li><b>Model provider</b> — conversation text is sent to a language model via OpenRouter (currently DeepSeek, with Anthropic as fallback) to compose a reply.</li>
        <li><b>WhatsApp / Meta</b> — the channel messages arrive and are sent over.</li>
        <li><b>Twilio</b> — only if you used a voice call.</li>
        <li><b>Google</b> — only for the services you connected yourself.</li>
      </ul>
      <p>Otherwise, data is disclosed only where required by law.</p>

      <h3>Where it is stored</h3>
      <p>Data is held in a database on a dedicated server in Europe (DigitalOcean). Google access and refresh tokens are encrypted at rest (AES-256-GCM) with the key held outside the database. A daily backup is retained for 14 days and then deleted.</p>

      <h3>Deletion and control</h3>
      <ul>
        <li><b>Disconnect Google</b> — ask the assistant to disconnect any service at any time. We delete our stored token and revoke it with Google.</li>
        <li>You can also revoke access directly from your <a href="https://myaccount.google.com/permissions">Google account permissions</a>.</li>
        <li><b>Pause</b> — ask the assistant to stop reaching out. This is a reversible pause, not a deletion.</li>
        <li><b>Delete everything</b> — email <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a> and the account and all associated data are deleted.</li>
      </ul>

      <h3>Children</h3>
      <p>The service is not intended for anyone under 16.</p>

      <h3>Changes</h3>
      <p>If this policy changes materially, the date at the top is updated and we tell you in the conversation.</p>
    </div>

    <div class="foot">
      <p><a href="/">allma.world</a> · <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>
    </div>
  `);
}

module.exports = { homePage, privacyPage, ASSISTANT, CONTACT_EMAIL, UPDATED };
