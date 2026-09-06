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
const { renderOnboardingReviews } = require('./onboarding');


// The page is six collapsible groups, in this order, and only the first is
// open when it loads: the board opens as a status page, and everything else
// is a fold away. Titles deliberately do not repeat a section's own h3.
// CSS-only (<details>/<summary>): no JS on this page, so the fold is not
// remembered across a reload — accepted; a POST redirects back to the section
// it came from (safeBack), and modern browsers open the enclosing group for a
// #fragment link.
const GROUPS = [
  { id: 'now', title: 'עכשיו: מצב המערכת ותקלות', open: true },
  { id: 'sending', title: 'הודעות: מה בתור ומה יצא' },
  { id: 'people', title: 'אנשים: משתמשים, המתנות וזיכרון' },
  { id: 'measure', title: 'מדידה: תוצאות, שימוש ובדיקות' },
  { id: 'money', title: 'עלויות ותשתית' },
  { id: 'controls', title: 'הגדרות ויומן פעילות' },
];

// Every section names its group; a section with an unknown group would
// silently fall off the page, so the suite checks the two lists agree.
const SECTIONS = [
  { id: 'health', group: 'now', title: 'מצב המערכת', hint: 'שער התקשורת (הדרך היחידה שהודעות נכנסות ויוצאות מוואטסאפ) וכל התהליכים הפנימיים. אדום = משהו תקוע וצריך טיפול. "לא נבדק" בשער = לא הצלחנו לקרוא את ההגדרות, לא בהכרח תקלה.', render: renderHeartbeats },
  { id: 'users', group: 'people', title: 'משתמשים', hint: 'כל מי שרשום. אפשר לקבוע לכל אחד מכסת הודעות יומית משלו.', render: renderUsers },
  { id: 'onboarding', group: 'now', title: 'איך נראתה ההצטרפות', hint: 'שלוש שעות אחרי ההודעה הראשונה של משתמש חדש, המערכת קוראת את השיחה שלו בחזרה מול מה שבאמת נרשם — ומדווחת פערים. "תקלה מול המשתמש" = נאמר לו משהו לא נכון או שהוא לא קיבל תשובה. פעם אחת לכל אדם.', render: renderOnboardingReviews },
  { id: 'issues', group: 'now', title: 'תקלות ובקשות', hint: 'דברים שעולמה או המשתמשים דיווחו עליהם ומחכים לטיפול.', render: renderIssues },
  { id: 'evals', group: 'measure', title: 'בדיקות התנהגות', hint: 'כל לילה עולמה עוברת תרחישים שנבנו מתקלות אמת — שיחה מדומה מול משתמש בדיקה, בדיקת כלים ומסד בקוד, ובדיקת ניסוח על ידי מודל שופט. אדום = כלל נשבר; צהוב = השופט הסתייג מהניסוח.', render: renderEvals },
  { id: 'cost', group: 'money', title: 'עלות', hint: 'כל שירות חיצוני שהפרויקט משלם עליו — מופרד ליתרות מראש (שנגמרות) ולחיוב שוטף (שנצבר) — וכמה עולה השימוש במודל לפי יום ולפי משתמש, כולל עמודה נפרדת ליצירת תמונות ווידאו. הערכה, לא חשבונית.', render: renderCost },
  { id: 'outcomes', group: 'measure', title: 'האם זה עובד', hint: 'המדדים שנבחרו כדי לענות על השאלה הזו: ענו לנו? נסגרו משימות? נאלצו לתקן אותנו? נוצר הרגל? כל מספר עם המכנה שלו.', render: renderOutcomes },
  { id: 'metrics', group: 'measure', title: 'שימוש במוצר', hint: 'מה באמת קורה במוצר: כמה אנשים פעילים, כמה נוצר, מה הצליח.', render: renderMetrics },
  { id: 'planned', group: 'sending', title: 'מה מתוכנן להישלח', hint: 'כל מה שעולמה מתכננת לשלוח, ומתי — בשעון המקומי של כל משתמש. התוכן עצמו נכתב ברגע השליחה, לא מראש, ולכן כאן מופיע הנושא ולא הנוסח.', render: renderPlanned },
  { id: 'brain', group: 'people', title: 'מה עולמה יודעת ועל מה היא מחכה', hint: 'שני צדדים של אותו דבר: מה המערכת למדה על האנשים, ומה תקוע אצלה כי אדם עדיין לא ענה.', render: renderBrain },
  { id: 'flags', group: 'controls', title: 'הגדרות מערכת', hint: 'שינוי כאן חל מיד, בלי עדכון גרסה. כל הגדרה מוסברת בשורה שלה.', render: renderFlags },
  { id: 'contacts', group: 'people', title: 'ספר הכתובות', hint: 'כל אנשי הקשר שהמשתמשים ייבאו או שמרו, מקובצים לפי מספר טלפון — כל השמות שניתנו לאותו מספר, ומי מהם כבר משתמש אצלנו.', render: renderContactsSection },
  { id: 'waitlist', group: 'people', title: 'רשימת המתנה', hint: 'אנשים שפנו כשההרשמה הייתה סגורה. יקבלו הודעה כשתיפתח.', render: renderWaitlist },
  { id: 'audit', group: 'controls', title: 'יומן פעילות', hint: 'הפעולות האחרונות במערכת, לפי סדר.', render: renderAudit },
];

module.exports = { GROUPS, SECTIONS };
