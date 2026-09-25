'use strict';
// The groups and the sections, in render order — the shape of the admin page.
// Moved verbatim out of adapters/http/dashboard.js on 2026-09-05; the router
// there is what is left of that file.
const { renderHeartbeats } = require('./health');
const { renderEvals } = require('./evals');
const { renderCost } = require('./cost');
const { renderMetrics } = require('./metrics');
const { renderIssues } = require('./issues');
const { renderFlags } = require('./controls');
const { renderUsers } = require('./users');
const { renderPlanned } = require('./planned');
const { renderContactsSection } = require('../contacts');
const { renderWaitlist, renderAudit } = require('./logs');
const { renderOutcomes } = require('./outcomes');
const { renderBrain } = require('./brain');
const { renderGroups } = require('./groups');
const { renderTemplates } = require('./templates');
const { renderOnboardingReviews } = require('./onboarding');
const { renderOwnerLog } = require('./owner-log');


// Since 2026-09-15 each group is its own menu page at /g/<id>, and `/` is the
// home page (admin/home.js). `nav` is the short menu label; `title` heads the
// page. A POST still sends back=/#<section>, and safeBack turns that into the
// page the section lives on.
const GROUPS = [
  { id: 'now', nav: 'מצב המערכת', title: 'עכשיו: מצב המערכת ותקלות' },
  { id: 'sending', nav: 'הודעות', title: 'הודעות: מה בתור ומה יצא' },
  { id: 'people', nav: 'אנשים', title: 'אנשים: משתמשים, המתנות וזיכרון' },
  { id: 'measure', nav: 'מדידה', title: 'מדידה: תוצאות, שימוש ובדיקות' },
  { id: 'money', nav: 'עלויות', title: 'עלויות ותשתית' },
  { id: 'controls', nav: 'הגדרות', title: 'הגדרות ויומן פעילות' },
];

const groupPath = (groupId) => `/g/${groupId}`;

// '#issues' → '/g/now#issues'; anything that is not a known section is left alone.
function sectionHref(fragment) {
  const s = SECTIONS.find((x) => `#${x.id}` === fragment);
  return s ? `${groupPath(s.group)}${fragment}` : fragment;
}

// Every section names its group; a section with an unknown group would
// silently fall off the page, so the suite checks the two lists agree.
const SECTIONS = [
  { id: 'health', group: 'now', title: 'מצב המערכת', hint: 'שער התקשורת (הדרך היחידה שהודעות נכנסות ויוצאות מוואטסאפ) וכל התהליכים הפנימיים. אדום = משהו תקוע וצריך טיפול. "לא נבדק" בשער = לא הצלחנו לקרוא את ההגדרות, לא בהכרח תקלה.', render: renderHeartbeats },
  { id: 'users', group: 'people', title: 'משתמשים', hint: 'כל מי שרשום. אפשר לקבוע לכל אחד מכסת הודעות יומית משלו.', render: renderUsers },
  { id: 'onboarding', group: 'now', title: 'איך נראתה ההצטרפות', hint: 'המערכת קוראת את השיחה של משתמש חדש בחזרה מול מה שבאמת נרשם, ומדווחת פערים — פעמיים: שלוש שעות אחרי ההודעה הראשונה שלו, ושוב אחרי היום הראשון. הקריאה היומית מדווחת רק מה שהראשונה לא ראתה. "תקלה מול המשתמש" = נאמר לו משהו לא נכון או שהוא לא קיבל תשובה. משתמש ותיק נבדק כל יום ב-promise_watch, לא כאן.', render: renderOnboardingReviews },
  { id: 'issues', group: 'now', title: 'תקלות ובקשות', hint: 'דברים שעולמה או המשתמשים דיווחו עליהם ומחכים לטיפול.', render: renderIssues },
  { id: 'evals', group: 'measure', title: 'בדיקות התנהגות', hint: 'כל לילה עולמה עוברת תרחישים שנבנו מתקלות אמת — שיחה מדומה מול משתמש בדיקה, בדיקת כלים ומסד בקוד, ובדיקת ניסוח על ידי מודל שופט. אדום = כלל נשבר; צהוב = השופט הסתייג מהניסוח.', render: renderEvals },
  { id: 'cost', group: 'money', title: 'עלות', hint: 'כל שירות חיצוני שהפרויקט משלם עליו — מופרד ליתרות מראש (שנגמרות) ולחיוב שוטף (שנצבר) — וכמה עולה השימוש במודל לפי יום ולפי משתמש, כולל עמודה נפרדת ליצירת תמונות ווידאו. הערכה, לא חשבונית.', render: renderCost },
  { id: 'outcomes', group: 'measure', title: 'האם זה עובד', hint: 'המדדים שנבחרו כדי לענות על השאלה הזו: ענו לנו? נסגרו משימות? נאלצו לתקן אותנו? נוצר הרגל? כל מספר עם המכנה שלו.', render: renderOutcomes },
  { id: 'metrics', group: 'measure', title: 'שימוש במוצר', hint: 'מה באמת קורה במוצר: כמה אנשים פעילים, כמה נוצר, מה הצליח.', render: renderMetrics },
  { id: 'planned', group: 'sending', title: 'מה מתוכנן להישלח', hint: 'כל מה שעולמה מתכננת לשלוח, ומתי — בשעון המקומי של כל משתמש, מקובץ לפי מי שיקרא. שורה עם ✓ יוצאת כלשונה וזה בדיוק הטקסט שיגיע; השאר נכתב ברגע השליחה, ולכן מופיע הנושא בלבד.', render: renderPlanned },
  { id: 'owner-log', group: 'sending', title: 'מה כתבתי בעצמי', hint: 'כל הודעה יזומה שנכתבה ידנית מדף משתמש, מה עולמה ניסחה ממנה בפועל, והאם ענו. כל שורה היא רגע שעולמה הייתה יכולה לזהות לבד: רושמים ליד מה היא מלמדת ומשייכים לפיצ\'ר אפשרי. שום דבר כאן לא נבנה לבד ועולמה לא קוראת את זה — עוברים על זה ביחד כשמחליטים.', render: renderOwnerLog },
  { id: 'groups', group: 'people', title: 'קבוצות', hint: 'קבוצות וואטסאפ שעולמה יושבת בהן. נעולה = מישהו שם עוד לא כתב לה בפרטי, והיא עונה לאף אחד עד שכולם כתבו. הכל נקבע מהשיחה עצמה — אין כאן כפתור לפתוח קבוצה ביד.', render: renderGroups },
  { id: 'brain', group: 'people', title: 'מה עולמה יודעת ועל מה היא מחכה', hint: 'שני צדדים של אותו דבר: מה המערכת למדה על האנשים, ומה תקוע אצלה כי אדם עדיין לא ענה.', render: renderBrain },
  { id: 'flags', group: 'controls', title: 'הגדרות מערכת', hint: 'שינוי כאן חל מיד, בלי עדכון גרסה. כל הגדרה מוסברת בשורה שלה.', render: renderFlags },
  { id: 'templates', group: 'controls', title: 'ניסוחים', hint: 'כל הודעה שעולמה שולחת כמו שהיא, בלי מודל — תזכורות, פנייה ראשונה לאדם חדש, וכל מה שהיא אומרת בקבוצה. ברירת המחדל מוצגת ליד כל תיבה; תיבה ריקה = ברירת המחדל. ניסוח שחסר בו משתנה חובה לא נשמר, ונאמר למה.', render: renderTemplates },
  { id: 'contacts', group: 'people', title: 'ספר הכתובות', hint: 'כל אנשי הקשר שהמשתמשים ייבאו או שמרו, מקובצים לפי מספר טלפון — כל השמות שניתנו לאותו מספר, ומי מהם כבר משתמש אצלנו.', render: renderContactsSection },
  { id: 'waitlist', group: 'people', title: 'רשימת המתנה', hint: 'אנשים שפנו כשההרשמה הייתה סגורה. יקבלו הודעה כשתיפתח.', render: renderWaitlist },
  { id: 'audit', group: 'controls', title: 'יומן פעילות', hint: 'הפעולות האחרונות במערכת, לפי סדר.', render: renderAudit },
];

module.exports = { GROUPS, SECTIONS, groupPath, sectionHref };
