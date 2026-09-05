'use strict';
// controls — one section of the admin page (see ../index.js).
// Moved verbatim out of adapters/http/dashboard.js on 2026-09-05; the router
// there is what is left of that file.
const flagsDomain = require('../../../../domain/flags');
const boostDomain = require('../../../../domain/boost');
const boostJob = require('../../../../jobs/boost');
const { esc } = require('../../html');

// Every setting gets a human label, an explanation, and the right input type.
// A bare JSON box is a trap: it invites typos into live behaviour.
const FLAG_SPECS = [
  { key: 'registration_open', label: 'הרשמת משתמשים חדשים', type: 'bool',
    help: 'כשסגור — מי שפונה מקבל הודעה שההרשמה מושהית ונכנס לרשימת המתנה. מי שהוזמן ע״י חבר קיים ממשיך להיקלט כרגיל.' },
  { key: 'credit_alerts_muted', label: 'השתקת התראות קרדיט/יתרה', type: 'bool',
    help: 'כשפתוח (מושתק) — התראת "נגמר הקרדיט" והתראת היתרה היורדת לא נשלחות לאדמין בוואטסאפ. תקלות config_guard קריטיות והתראת בדיקות ההתנהגות הלילית לא מושפעות.' },
  { key: 'quota_daily_free', label: 'מכסת הודעות ליום — משתמש חינם', type: 'int',
    help: 'מעבר לזה אולמה שולחת סיכום אחרון ומפסיקה להגיב עד למחרת.' },
  { key: 'quota_hourly_paid', label: 'מכסת הודעות לשעה — מנוי', type: 'int',
    help: 'למנויים המכסה מתחדשת כל שעה במקום כל יום.' },
  { key: 'proactive_daily_budget', label: 'הודעות יזומות ליום', type: 'int',
    help: 'כמה פעמים ביום אולמה תפנה מיוזמתה. מעבר לזה — דברים לא דחופים מתאגדים לסיכום הבא במקום להישלח בנפרד.' },
  { key: 'intake_hourly_cap', label: 'תקרת נרשמים חדשים בשעה', type: 'int',
    help: 'הגנה מפני הצפה: אם יותר מזה אנשים לא מוכרים פונים תוך שעה, ההרשמה נסגרת אוטומטית ונפתחת תקלה כאן.' },
  { key: 'cost_per_mtok_usd', label: 'תעריף למיליון טוקנים ($)', type: 'num',
    help: 'משמש רק לחישוב ההערכה במסך העלות.' },
  { key: 'audit_retention_days', label: 'שמירת יומן פעילות (ימים)', type: 'int',
    help: 'אירועים שגרתיים נמחקים אחרי התקופה הזו. אירועי הרשאות ופרטיות נשמרים תמיד.' },
  { key: 'live_subscriptions_per_user', label: 'מקסימום מנויי עדכונים חיים למשתמש', type: 'int',
    help: 'כמה מנויי "עדכן אותי על..." פעילים מותר למשתמש אחד (מודלים חדשים, מזג אוויר וכו\u05f3).' },
  { key: 'claude_subscription_overrides', label: 'מנוי Claude — חודשים בתעריף אחר', type: 'json',
    // Keys are billing months, values are dollars. Anything else is a typo and
    // must not reach a page that prices money with it.
    validate: (v) => v && typeof v === 'object' && !Array.isArray(v)
      && Object.entries(v).every(([k, amt]) =>
        /^\d{4}-(0[1-9]|1[0-2])$/.test(k) && Number.isFinite(Number(amt)) && Number(amt) >= 0),
    help: 'JSON של חודשים שחויבו אחרת מ-$20, למשל {"2026-08": 100} לחודש Max. אין שום API שחושף חיוב מנוי, אז זה המקום היחיד שבו הדף יכול לדעת. חודש שלא מופיע כאן מחושב ב-$20.' },
  { key: 'email_access_phones', label: 'חיבור תיבת מייל — מי מורשה', type: 'text',
    help: 'ריק = סגור לכולם חוץ מאדמין; "all" = פתוח לכולם; או מספרי טלפון ב-E.164 מופרדים בפסיק. חוסם רק חיבור חדש — מי שכבר חיבר ממשיך לעבוד. להשאיר סגור עד שהרשאת ה-Gmail מאושרת בקונסולה של גוגל.' },
  { key: 'media_gen_phones', label: 'יצירת תמונות ווידאו — מספרים מורשים', type: 'text',
    help: 'מספרי טלפון (E.164, מופרדים בפסיק) שמותר להם לייצר תמונות ווידאו. אדמין מורשה תמיד, בלי קשר לרשימה.' },
  { key: 'media_image_model', label: 'מודל יצירת תמונות', type: 'text',
    help: 'מזהה מודל ב-OpenRouter. ריק = ברירת המחדל (meta/muse-image, ~$0.01 לתמונה).' },
  { key: 'media_video_model', label: 'מודל יצירת וידאו', type: 'text',
    help: 'מזהה מודל ב-OpenRouter. ריק = ברירת המחדל (bytedance/seedance-2.0-mini, ~$0.05 ל-4 שניות 480p).' },
  { key: 'digest_card_min_items', label: 'מתי הסיכום היומי נשלח כתמונה', type: 'int',
    help: 'מכמה פריטים פתוחים הסיכום של הבוקר נשלח כתמונה מצוירת במקום כטקסט. מתחת למספר הזה — משפט קצר, שתמונה במקומו רק מפריעה. 0 = בלי תמונות בכלל.' },
  { key: 'reminder_escalation_max', label: 'כמה פעמים תזכורת חוזרת', type: 'int',
    help: 'תזכורת שלא נענתה חוזרת עד למספר הזה של פעמים (כולל הראשונה). 1 = כמו פעם, פעם אחת בלבד. חוזרת רק אחרי שהקודמת באמת נמסרה, ורק לתזכורות חד-פעמיות — לתזכורת חוזרת יש כבר קצב משלה.' },
  { key: 'reminder_escalation_gap_hours', label: 'שעות בין תזכורת לחזרה עליה', type: 'num',
    help: 'הפער מרגע המסירה של תזכורת ועד החזרה עליה. החזרה האחרונה תמיד ביום למחרת, באותה שעה שנבחרה במקור.' },
  { key: 'implicit_turn_start', label: 'השלמת פתיחת טרן בצד השרת', type: 'text',
    help: 'כשהסוכן מדלג על turn_start (קורה בבקשת הפסקת שירות), השרת סופר את ההודעה ומעדכן שהמשתמש ער בעצמו. ריק = כבוי; "all" = כל המשתמשים; או רשימת מספרים ב-E.164 מופרדים בפסיק, להרצה מדורגת.' },
  { key: 'public_base_url', label: 'כתובת ציבורית לקישורים', type: 'text',
    help: 'הבסיס לקישורים שנשלחים למשתמשים (למשל דף סימון הזמינות). בלי / בסוף.' },
  { key: 'search_link_base', label: 'מנוע החיפוש לקישורים', type: 'text',
    help: 'הבסיס לקישור החיפוש שאולמה שולחת כשהיא לא יכולה לחפש בעצמה. ריק = גוגל. חייב להתחיל ב-https ולהסתיים בפרמטר השאילתה, למשל https://duckduckgo.com/?q= — ערך לא תקין נופל חזרה לגוגל ולא שובר קישור.' },
];

const EDITABLE_FLAGS = FLAG_SPECS.map((f) => f.key);

// The demo switch. Not a ROW in the flags table — it is the only setting that
// costs real money per minute and turns itself off, so it needs a countdown
// and a flag row has nowhere to put one — but no longer its own section
// either: it leads the settings section as its first block (renderFlags).
async function renderBoost(client, csrf) {
  const state = await flagsDomain.getFlag(client, boostJob.STATE_FLAG);
  const model = await flagsDomain.getFlag(client, boostJob.MODEL_FLAG);
  const now = new Date();
  const on = boostDomain.isEngaged(state) && !boostDomain.expired(state, now);
  const left = boostDomain.minutesLeft(state, now);

  const button = on
    ? `<form method="post" action="/boost" class="inline">
         <input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="back" value="/#flags">
         <input type="hidden" name="action" value="off">
         <button>כבה עכשיו</button>
       </form>`
    : `<form method="post" action="/boost" class="inline">
         <input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="back" value="/#flags">
         <input type="hidden" name="action" value="on">
         <button>הדלק מצב בוסט</button>
       </form>`;

  const status = on
    ? `<div><b>פעיל</b> — נשארו <b>${left}</b> דקות. המודל: <span dir="ltr">${esc(String(state.model || model || ''))}</span>.
         <div class="dim small">כשהזמן ייגמר המערכת תחזור לבד ל-<span dir="ltr">${esc(String((state.restore && state.restore.model) || ''))}</span>. אין צורך לזכור לכבות.</div></div>`
    : `<div>כבוי. כל המשתמשים על מודל ברירת המחדל.
         <div class="dim small">הדלקה מעבירה את <b>כל</b> המשתמשים ל-<span dir="ltr">${esc(String(model || ''))}</span> למשך שעתיים, ואז חוזרת לבד. השינוי חל תוך דקה ובלי הפעלה מחדש — שיחה באמצע לא נקטעת.</div></div>`;

  return `<div class="boost ${on ? 'on' : 'off'}">${status}<div style="margin-top:8px">${button}</div></div>`;
}

async function renderFlags(client, csrf) {
  return `<h4>מצב בוסט</h4><p class="hint">${"מתג להדגמות: מעביר את כל המשתמשים למודל המהיר והחזק ביותר, ומכבה את עצמו אחרי שעתיים. עולה יותר לדקה — לכן הוא לא נשאר דלוק בטעות."}</p>${await renderBoost(client, csrf)}`
    + `<h4>הגדרות</h4>${await renderFlagsTable(client, csrf)}`;
}

async function renderFlagsTable(client, csrf) {
  const rows = [];
  for (const spec of FLAG_SPECS) {
    const val = await flagsDomain.getFlag(client, spec.key);
    const field = spec.type === 'bool'
      ? `<select name="value">
           <option value="true" ${val === true ? 'selected' : ''}>פתוח</option>
           <option value="false" ${val === false ? 'selected' : ''}>סגור</option>
         </select>`
      : spec.type === 'json'
      ? `<input name="value" value="${esc(JSON.stringify(val ?? {}))}" size="34">`
      : spec.type === 'text'
        ? `<input name="value" value="${esc(val == null ? '' : String(val))}" size="28" dir="ltr">`
        : `<input name="value" value="${esc(String(val))}" size="7" inputmode="decimal">`;
    rows.push(`<tr>
      <td><div>${spec.label}</div><div class="dim small">${spec.help}</div></td>
      <td class="nowrap"><form method="post" action="/flags" class="inline">
        <input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="back" value="/#flags"><input type="hidden" name="key" value="${esc(spec.key)}">
        ${field}<button>שמור</button>
      </form></td></tr>`);
  }
  return `<table class="settings"><tr><th>הגדרה</th><th>ערך</th></tr>${rows.join('')}</table>`;
}

module.exports = { FLAG_SPECS, EDITABLE_FLAGS, renderBoost, renderFlags, renderFlagsTable };
