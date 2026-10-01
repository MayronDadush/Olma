'use strict';
// brand — the ad library (domain/brand-ads.js): every clip, played here, and
// the owner's own rules for when Olma sends one. Admin host only; nothing
// under /brand is ever served on a public hostname (dashboard.js says why
// twice).
const brandAds = require('../../../../domain/brand-ads');
const { esc } = require('../../html');
const { fmt } = require('../html');

const LANG_LABEL = { he: 'עברית', en: 'English' };
const FORMAT_LABEL = {
  gif: 'GIF — מתנגן בלולאה, בלי קול (כמו סרטון ההיכרות)',
  mp4: 'MP4 — סרטון רגיל עם כפתור הפעלה',
};
const TIMING_LABEL = {
  morning: 'בשעת סיכום הבוקר שלהם (09:00 למי שאין לו), כהודעה נפרדת',
  window: 'מיד כשהחלון שלהם פתוח',
};
const REFUSAL_LABEL = {
  too_big: 'הקובץ גדול מ-16MB, התקרה של וואטסאפ לסרטון.',
  not_mp4: 'זה לא קובץ MP4. גם ל-"GIF" מעלים את ה-MP4 — וואטסאפ מציג אותו בלולאה.',
  empty: 'לא נבחר קובץ.',
  bad_lang: 'שפה לא מוכרת.',
  not_found: 'הפרסומת לא קיימת.',
  bad_id: 'מזהה לא תקין: אותיות באנגלית קטנות, ספרות ומקף בלבד, עד 40 תווים.',
  no_title: 'חסרה כותרת.',
  exists: 'כבר יש פרסומת עם המזהה הזה.',
  bad_format: 'פורמט לא מוכר.',
};

const hidden = (csrf) => `<input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="back" value="/#ads">`;

function renderSettings(s, csrf, preview) {
  const num = (name, val, label, help) => `<tr><td><div>${label}</div><div class="dim small">${help}</div></td>
    <td class="nowrap"><input name="${name}" value="${val}" size="4" inputmode="numeric"></td></tr>`;
  const status = s.enabled
    ? '<p><span class="pill ok">פועל</span> עולמה שולחת פרסומות מהסבב לפי הכללים כאן.</p>'
    : '<p><span class="pill">כבוי</span> שום פרסומת לא נשלחת לאף אחד, גם אם יש פרסומות בסבב.</p>';
  const next = preview.people
    ? `בבדיקה הבאה (כל כמה דקות) ${s.enabled ? 'ייכנסו' : 'היו נכנסים'} לתור <b>${fmt(preview.people)}</b> אנשים: `
      + Object.entries(preview.byAd).map(([id, n]) => `${esc(id)} ${fmt(n)}`).join(' · ')
    : 'בבדיקה הבאה אף אחד לא עומד בכללים. או שאין פרסומות בסבב, או שכולם קיבלו לאחרונה.';
  return `${status}<p class="dim small">${next}. שעות שקטות, יום שקט ומי שבהשהיה נשמרים בכל מקרה. מי שהפסיק לענות לא מקבל.</p>
    <form method="post" action="/brand/ads/settings">${hidden(csrf)}
      <table class="settings"><tr><th>כלל</th><th>ערך</th></tr>
        <tr><td><div>שליחת פרסומות</div><div class="dim small">המתג הראשי. סגור = שום דבר לא יוצא.</div></td>
          <td class="nowrap"><select name="enabled"><option value="true" ${s.enabled ? 'selected' : ''}>פתוח</option><option value="false" ${s.enabled ? '' : 'selected'}>סגור</option></select></td></tr>
        ${num('everyDays', s.everyDays, 'כל כמה ימים לכל היותר', 'לא יותר מפרסומת אחת לאדם בפרק הזמן הזה. אותה פרסומת לא נשלחת לאותו אדם פעמיים, אף פעם.')}
        ${num('activeWithinDays', s.activeWithinDays, 'רק מי שכתב בימים האחרונים', 'רק מי שכתב לעולמה (או השתמש בדף שלו) בתוך מספר הימים הזה.')}
        ${num('introGapDays', s.introGapDays, 'מרווח אחרי סרטון ההיכרות (ימים)', 'מי שקיבל את סרטון ההיכרות לא מקבל פרסומת בימים שאחריו.')}
        <tr><td><div>מתי ביום</div><div class="dim small">בכל מקרה רק בתוך שעות היום שלהם.</div></td>
          <td class="nowrap"><select name="timing">${brandAds.TIMINGS.map((t) =>
            `<option value="${t}" ${s.timing === t ? 'selected' : ''}>${TIMING_LABEL[t]}</option>`).join('')}</select></td></tr>
      </table>
      <div style="margin-top:8px"><button>שמור כללים</button></div>
    </form>`;
}

function renderAd(ad, stat, csrf) {
  const players = brandAds.LANGS.map((lang) => {
    const f = ad.files[lang];
    const player = f
      ? `<video src="/brand/ads/file/${esc(ad.id)}/${lang}?v=${encodeURIComponent(f.file)}" controls ${ad.format === 'gif' ? 'loop muted autoplay' : ''} playsinline preload="metadata" style="width:240px;max-width:100%;border-radius:8px;display:block"></video>
         <div class="dim small">${(f.bytes / 1024 / 1024).toFixed(1)}MB · הועלה ${esc(new Date(f.uploaded_at).toISOString().slice(0, 10))}</div>`
      : `<div class="dim small" style="width:240px">אין גרסה ב${LANG_LABEL[lang]}.${ad.in_rotation ? ' <b>מי שמדבר ' + LANG_LABEL[lang] + ' לא יקבל אותה.</b>' : ''}</div>`;
    return `<div style="display:inline-block;vertical-align:top;margin:0 0 8px 12px">
      <div class="small"><b>${LANG_LABEL[lang]}</b></div>${player}
      <form method="post" action="/brand/ads/upload" enctype="multipart/form-data" style="margin-top:4px">${hidden(csrf)}
        <input type="hidden" name="ad" value="${esc(ad.id)}"><input type="hidden" name="lang" value="${lang}">
        <input type="file" name="file" accept="video/mp4" required> <button>${f ? 'החלף' : 'העלה'}</button>
      </form></div>`;
  }).join('');
  const s = stat || { delivered: 0, waiting: 0, dropped: 0, failing: 0, replied: 0, tooEarly: 0 };
  const statLine = `נשלחה ל-${fmt(s.delivered)} · ממתינה ${fmt(s.waiting)} · לא נשלחה (השהיה/שקט) ${fmt(s.dropped)}`
    + (s.failing ? ` · <span class="bad">נכשלת ${fmt(s.failing)}</span>` : '')
    + ` · כתבו לעולמה ביממה שאחרי: ${fmt(s.replied)}${s.tooEarly ? ` (עוד ${fmt(s.tooEarly)} מוקדם לדעת)` : ''}`;
  return `<div class="card" style="margin-bottom:14px">
    <h4 style="margin:0 0 4px">${esc(ad.title)} <span class="dim small mono">${esc(ad.id)}</span>
      ${ad.in_rotation ? '<span class="pill ok">בסבב</span>' : '<span class="pill">לא בסבב</span>'}</h4>
    <p class="dim small">${statLine}</p>
    <div>${players}</div>
    <form method="post" action="/brand/ads/update">${hidden(csrf)}<input type="hidden" name="id" value="${esc(ad.id)}">
      <table class="settings">
        <tr><td>כותרת</td><td><input name="title" value="${esc(ad.title)}" size="30"></td></tr>
        <tr><td><div>על מה הסרטון</div><div class="dim small">משפט אחד. עולמה מקבלת אותו בתור הבא, כדי שאם ישאלו "מה זה?" היא תדע.</div></td>
          <td><input name="about" value="${esc(ad.about)}" size="40"></td></tr>
        <tr><td>בסבב</td><td><label><input type="checkbox" name="in_rotation" ${ad.in_rotation ? 'checked' : ''}> עולמה שולחת אותה מדי פעם</label></td></tr>
        <tr><td>איך היא נשלחת</td><td><select name="format">${brandAds.FORMATS.map((f) =>
          `<option value="${f}" ${ad.format === f ? 'selected' : ''}>${FORMAT_LABEL[f]}</option>`).join('')}</select></td></tr>
        <tr><td>לא למי שקיבל את סרטון ההיכרות</td><td><label><input type="checkbox" name="skip_if_intro" ${ad.skip_if_intro ? 'checked' : ''}> (לגרסה החדשה של אותו סיפור)</label></td></tr>
      </table>
      <div style="margin-top:6px"><button>שמור</button></div>
    </form>
  </div>`;
}

async function renderAds(client, csrf) {
  const settings = await brandAds.getSettings(client);
  const [ads, stats, preview] = [await brandAds.listAds(client), await brandAds.stats(client), await brandAds.preview(client)];
  const { rows: refused } = await client.query(
    `SELECT detail FROM audit_log WHERE event = 'admin.brand_ad_refused'
        AND created_at > now() - interval '10 minutes' ORDER BY created_at DESC LIMIT 1`);
  const refusal = refused[0]
    ? `<div class="alert alert-bad">הפעולה האחרונה לא נשמרה: ${REFUSAL_LABEL[refused[0].detail && refused[0].detail.reason] || esc(String(refused[0].detail && refused[0].detail.reason))}</div>`
    : '';
  return `${refusal}<h4>כללי השליחה</h4>${renderSettings(settings, csrf, preview)}
    <h4>הפרסומות (${fmt(ads.length)})</h4>
    ${ads.map((a) => renderAd(a, stats[a.id], csrf)).join('') || '<p class="dim">עוד אין פרסומות. מוסיפים אחת למטה ומעלים לה קובץ MP4 בעברית ובאנגלית.</p>'}
    <h4>פרסומת חדשה</h4>
    <form method="post" action="/brand/ads/create">${hidden(csrf)}
      <input name="id" placeholder="מזהה, למשל reminder" dir="ltr" size="14" required>
      <input name="title" placeholder="כותרת, למשל שוב שכחת?" size="24" required>
      <input name="about" placeholder="על מה הסרטון, במשפט" size="30">
      <button>הוסף</button>
    </form>
    <p class="dim small">הסרטונים מרונדרים על המק (brand/studio) ומועלים לכאן. על השרת לא מרנדרים: רינדור אחד צורך כ-1.5GB, ולשרת יש 2GB. הקבצים נשמרים בשרת ב-<span dir="ltr">${esc(brandAds.storeDir())}</span>, מחוץ לקוד, כך שעדכון גרסה לא נוגע בהם. הם לא נכללים בגיבוי הלילי של מסד הנתונים, אז המקור נשאר על המק.</p>`;
}

module.exports = { renderAds, REFUSAL_LABEL };
