const {svg,VIEW}=require('./marks2.js');
let uid=0;
// every inline copy needs its own clip ids
const S=(k,c={})=>{const u='u'+(++uid);return svg(k,c).replace(/id="(k[^"]*)"/g,`id="$1${u}"`).replace(/url\(#(k[^)]*)\)/g,`url(#$1${u})`).replace(' xmlns="http://www.w3.org/2000/svg"','')};
const NIGHT={R:'#EDEAFB',L:'#B9AEFF',P:'#1C1A38'};
const C={
  B2:{t:'ב2 · נוכח',says:'שני עולמות שווים, וצבוע רק המשותף.',like:'בסיס טוב. בגודל קטן הכי ברור מבין הטבעות.',v:'base'},
  B4:{t:'ב4 · את והעולם',says:'אדם אחד והעולם שלו. לא סימטרי, ולכן זכיר.',like:'פחות מספר "ביחד" ויותר "אני".',v:'base'},
  B5:{t:'ב5 · נסגרים יחד',says:'שתי טבעות פתוחות, והצורה הסגורה היחידה היא המשותפת.',like:'קרוב לאותיות משולבות, בעיקר CC של שאנל.',v:'base'},
  a_bowl:{t:'a · הקערה והגבעול',g:'A',says:'ה־a של allma. העדשה היא המקום שבו הקערה פוגשת את הגבעול.',like:'יש הרבה לוגואים של a קטנה. העדשה היא מה שהופך אותה לשלנו.',v:'dev'},
  A_cap:{t:'A · העדשה כקו האמצע',g:'A',says:'ה־A של Allma. שתי רגליים הן שני אנשים שנשענים זה לזה ונפגשים למעלה, והקו שמחבר ביניהם הוא העדשה: החלק המשותף.',like:'לוגואים של A נפוצים, אבל קו אמצע בצורת עדשה לא ראיתי. נקרא ברור גם ב־20px.',v:'rec'},
  ayin_leaf:{t:'ע · הזרוע הקצרה היא העדשה',g:'ע',says:'ה־ע של עולמה. הקו הארוך הוא היום שלך, והזרוע הקצרה, בצבע, היא מה שנוחת עליו ונסגר.',like:'בקטן אפשר לקרוא אותו גם כ־y או כעלה, ויש סיכון שייראה כמו מותג אקולוגי. דובר עברית יקרא ע.',v:'dev'},
  meet_point:{t:'נקודת המפגש',g:'תיאום',says:'שני עולמות, בלי מילוי, ונקודה אחת במקום שבו הם נוגעים: הרגע שסוכם.',like:'טבעות נישואין, סימן אינסוף. כסימן נראה קצת כמו תכשיט.',v:'ui'},
  meet_chain:{t:'חוליות',g:'תיאום',says:'שני עולמות שזורים זה בזה, והמשותף צבוע.',like:'שתי טבעות שלובות הן סמל של נישואים. קשה לברוח מזה.',v:'no'},
  task_loop:{t:'הלולאה שנסגרת',g:'משימות',says:'טבעת פתוחה, והעדשה היא החתיכה שסוגרת אותה. "סוגרת מעגלים" במילה אחת.',like:'בקטן זה נראה כמו סמל טעינה או כפתור הדלקה.',v:'ui'},
  task_hand:{t:'השעה שאמרת',g:'משימות',says:'שעון, והמחוג הוא עדשה: השעה שביקשת שתזכיר לך.',like:'כל אפליקציית שעון, טיימר או תזכורות.',v:'no'},
  word_ll:{t:'allma · שני ה־l הם שני אנשים',g:'המילה',says:'בתוך המילה עצמה יש זוג: שתי אותיות זהות, זו ליד זו. כאן הן לולאות שחופפות, והחפיפה צבועה. המותג כתוב בתוך השם.',like:'בגודל קטן מאוד אפשר לקרוא "a0ma". כסימן לבד הוא לא עובד, כשם כתוב הוא עובד.',v:'dev'},
};
const V={rec:['ההמלצה שלי','rec'],dev:['שווה לפתח','dev'],ui:['כאייקון במוצר, לא כלוגו','ui'],no:['פחות','no'],base:['מה שאהבת','base']};
const card=(k)=>{const c=C[k],wide=!!VIEW[k];
  const lock=wide?'':`<div class="lk">${S(k).replace('<svg','<svg style="height:34px;width:auto"')}<span class="wm">${c.g==='ע'?'עולמה':c.g==='A'?'<span dir="ltr">Allma</span>':'עולמה'}</span></div>`;
  return `<article class="card${c.v==='rec'?' is-rec':''}">
  <div class="stage${wide?' wide':''}">${S(k)}</div>
  <div class="tests">
    ${wide?`<div class="t"><div class="tiny">${S(k).replace('<svg','<svg style="height:18px;width:auto"')}</div><span>18px</span></div>`:
    `<div class="t"><div class="pf">${S(k)}</div><span>פרופיל 44</span></div><div class="t"><div class="tiny">${S(k).replace('<svg','<svg style="height:20px;width:auto"')}</div><span>20px</span></div>`}
    <div class="t"><div class="dk${wide?' wide':''}">${S(k,NIGHT)}</div><span>לילה</span></div>
    ${lock}
  </div>
  <div class="txt"><div class="hd"><h3>${c.t}</h3><span class="v ${V[c.v][1]}">${V[c.v][0]}</span></div>
  <p><b>מה הוא אומר:</b> ${c.says}</p><p><b>מה הוא מזכיר:</b> ${c.like}</p></div></article>`;};
const group=(title,sub,keys)=>`<section class="grp"><div class="gh"><h2>${title}</h2><p>${sub}</p></div><div class="cards${keys.length===1?' one':''}">${keys.map(card).join('')}</div></section>`;
const row=(k,n,m,t)=>`<div class="wr"><div class="wa">${k?S(k):''}</div><div class="wt"><div><b>${n}</b><time>${t}</time></div><span>${m}</span></div></div>`;
const phone=(k,label)=>`<figure class="ph"><div class="scr">${row(k,'עולמה','סגור ☕ חמישי 10:00 עם דנה','12:20')}${row(null,'אמא','❤️','11:02')}${row(null,'ארוחה 🍝','נועה: חמישי מעולה','10:14')}</div><figcaption>${label}</figcaption></figure>`;
const html=`<title>הסימן של עולמה, סבב 2</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Assistant:wght@400;600;700&family=Rubik:wght@500;600;700&display=swap">
<style>
:root{--bg:#EFE9DE;--page:#F7F1E6;--surface:#FFFCF7;--text:#221C3A;--text-2:#5F5873;--text-3:#8F88A3;--sep:#E2D9CC;--accent:#5B4BD6;--accent-soft:#ECE8F8;--ok:#2F6F9F;--ok-soft:#E3EDF7;--no:#A0405A;--no-soft:#F6E4E8;--r:14px}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--bg:#15132B;--page:#1C1A38;--surface:#24214A;--text:#EDEAFB;--text-2:#B3ADCC;--text-3:#827CA0;--sep:#353163;--accent:#B9AEFF;--accent-soft:#302B5E;--ok:#9CC3E6;--ok-soft:#22324A;--no:#F2A3B6;--no-soft:#3A2233}}
:root[data-theme="dark"]{color-scheme:dark;--bg:#15132B;--page:#1C1A38;--surface:#24214A;--text:#EDEAFB;--text-2:#B3ADCC;--text-3:#827CA0;--sep:#353163;--accent:#B9AEFF;--accent-soft:#302B5E;--ok:#9CC3E6;--ok-soft:#22324A;--no:#F2A3B6;--no-soft:#3A2233}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--text);font-family:Assistant,Heebo,system-ui,sans-serif;font-size:16px;line-height:1.6;padding-inline:16px;padding-block:36px 90px}
.wrap{max-width:1080px;margin-inline:auto;display:flex;flex-direction:column;gap:44px}
h1,h2,h3{font-family:Rubik,Assistant,sans-serif;margin:0;line-height:1.15;text-wrap:balance}
h1{font-size:clamp(32px,5.4vw,52px);font-weight:700;letter-spacing:-.02em}
h2{font-size:clamp(22px,3vw,28px);font-weight:700}
h3{font-size:17px;font-weight:600}
p{margin:0;max-width:64ch}
.lede{color:var(--text-2);font-size:18px}
.eyebrow{font-size:13px;font-weight:700;letter-spacing:.06em;color:var(--accent)}
.wm{font-family:Rubik,sans-serif;font-weight:700;font-size:26px;letter-spacing:-.01em;line-height:1}
.grp{display:flex;flex-direction:column;gap:16px}
.gh{display:flex;flex-direction:column;gap:4px}.gh p{color:var(--text-2)}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(310px,1fr));gap:14px}
.card{background:var(--surface);border:1px solid var(--sep);border-radius:var(--r);overflow:hidden;display:flex;flex-direction:column}
.card.is-rec{border:2px solid var(--accent)}
.stage{background:var(--page);display:grid;place-items:center;padding:22px;height:210px}
.stage svg{height:160px;width:auto;max-width:100%}
.stage.wide svg{height:auto;width:88%}
.tests{display:flex;align-items:flex-end;gap:14px;flex-wrap:wrap;padding:14px 16px;border-bottom:1px solid var(--sep)}
.t{display:flex;flex-direction:column;align-items:center;gap:4px}
.t span{font-size:11.5px;color:var(--text-3)}
.pf{width:44px;height:44px;border-radius:50%;background:#F7F1E6;display:grid;place-items:center;box-shadow:0 0 0 1px #0000000f}
.pf svg{width:74%;height:auto}
.tiny{height:44px;display:grid;place-items:center}
.dk{width:44px;height:44px;border-radius:10px;background:#1C1A38;display:grid;place-items:center}
.dk svg{width:70%;height:auto}.dk.wide{width:96px}.dk.wide svg{width:84%}
.lk{display:flex;align-items:center;gap:10px;margin-inline-start:auto;padding-bottom:10px}
.txt{padding:14px 16px 18px;display:flex;flex-direction:column;gap:8px}
.txt p{font-size:14.5px;color:var(--text-2)}.txt b{color:var(--text);font-weight:600}
.hd{display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap}
.v{font-size:12px;font-weight:700;padding:2px 9px;border-radius:99px;white-space:nowrap}
.v.rec{background:var(--accent);color:var(--surface)}.v.dev{background:var(--accent-soft);color:var(--accent)}
.v.ui{background:var(--ok-soft);color:var(--ok)}.v.no{background:var(--no-soft);color:var(--no)}.v.base{background:var(--page);color:var(--text-2);border:1px solid var(--sep)}
.phones{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
@media (max-width:820px){.phones{grid-template-columns:repeat(2,minmax(0,1fr))}}
.ph{margin:0;display:flex;flex-direction:column;gap:6px}
.scr{background:#fff;border-radius:16px;padding:6px 0;box-shadow:0 0 0 1px var(--sep);color:#111B21;font-family:-apple-system,'Segoe UI',Assistant,sans-serif}
.wr{display:flex;gap:10px;align-items:center;padding:7px 12px}
.wa{width:44px;height:44px;border-radius:50%;background:#C7CED2;flex:none;display:grid;place-items:center}
.wr:first-child .wa{background:#F7F1E6}.wa svg{width:74%;height:auto}
.wt{flex:1;min-width:0;border-bottom:1px solid #EEF0F1;padding-bottom:7px}.wr:last-child .wt{border-bottom:0}
.wt div{display:flex;justify-content:space-between}.wt b{font-size:14px;font-weight:600}.wt time{font-size:11px;color:#667781}
.wt span{display:block;font-size:12.5px;color:#667781;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
figcaption{font-size:13px;color:var(--text-2);text-align:center}
.family{background:var(--page);border-radius:18px;padding:clamp(20px,4vw,40px);display:flex;flex-direction:column;gap:22px}
.fam{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;align-items:stretch}
@media (max-width:820px){.fam{grid-template-columns:repeat(2,minmax(0,1fr))}}
.fi{background:var(--surface);border:1px solid var(--sep);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:10px;align-items:center;text-align:center}
.fi .m{height:110px;display:grid;place-items:center;width:100%}.fi .m svg{max-height:100px;width:auto;max-width:100%}
.fi p{font-size:14px;color:var(--text-2)}
.ask{background:var(--accent-soft);border-radius:var(--r);padding:22px;display:flex;flex-direction:column;gap:10px}
.ask ol{margin:0;padding-inline-start:22px;display:flex;flex-direction:column;gap:6px}
</style>
<div class="wrap" dir="rtl" lang="he">
<header style="display:flex;flex-direction:column;gap:14px">
  <div class="eyebrow">עולמה · Allma · הסימן, סבב 2</div>
  <h1>אותה עדשה, בתוך האותיות שלנו</h1>
  <p class="lede">כל הכיוונים כאן בנויים מאותו חוק: קווים בצבע הדיו, וצבע רק במה שמשותף. ניסיתי אותו בתוך A, בתוך ע, בתיאום, במשימות ובתוך המילה allma. כל סימן מוצג בגדול, בגודל של תמונת פרופיל, בגודל הקטן ביותר, על רקע לילה וליד השם.</p>
  <p class="lede" style="font-size:15.5px">שני כיוונים שרינדרתי לא נכנסו לדף: ע שבנוי משתי טבעות, שלא נקרא כ־ע, ו־A מטבעות, שנראה כמו דמות עם אוזניות.</p>
</header>
${group('מה שאהבת','שלוש הגרסאות מהסבב הקודם, מצוירות מחדש באותו קנה מידה כדי שיהיה אפשר להשוות.',['B2','B4','B5'])}
${group('A · מתוך Allma','ה־A הוא האות הראשונה בשני הצדדים של השם: All, Allma.',['A_cap','a_bowl'])}
${group('ע · מתוך עולמה','האות הראשונה בעברית, והכי מזוהה איתנו בשיחה.',['ayin_leaf'])}
${group('תיאום','מה שקורה כששני עולמות נפגשים.',['meet_point','meet_chain'])}
${group('משימות','מעגל פתוח שנסגר.',['task_loop','task_hand'])}
${group('המילה','במקום סימן לצד השם, השם עצמו כסימן.',['word_ll'])}
<section class="grp"><div class="gh"><h2>ברשימת הצ'אטים, בגודל אמיתי</h2><p>המבחן שהכי חשוב: 44 פיקסלים, בין אמא לקבוצה של הארוחה.</p></div>
<div class="phones">${phone('A_cap','A · העדשה כקו האמצע')}${phone('ayin_leaf','ע · הזרוע היא העדשה')}${phone('a_bowl','a · הקערה והגבעול')}${phone('B2','ב2 · נוכח')}</div></section>
<section class="family"><div class="gh"><div class="eyebrow">ההמלצה שלי</div><h2>משפחה אחת, לא סימן אחד</h2>
<p>אין צורך לבחור בין האות לבין הטבעות. האות היא הלוגו, והטבעות הן השפה הגרפית שסביבו. כולם בנויים מאותו חוק, אז הם נראים כמו משפחה.</p></div>
<div class="fam">
<div class="fi"><div class="m">${S('A_cap')}</div><h3>הלוגו</h3><p>A עם עדשה. בתמונת הפרופיל, באפליקציה, בכל מקום קטן. עובד בעברית ובאנגלית.</p></div>
<div class="fi"><div class="m">${S('word_ll')}</div><h3>השם באנגלית</h3><p>allma עם שני l חופפים. לאתר, לסוף סרטון ולמרצ'נדייז.</p></div>
<div class="fi"><div class="m">${S('ayin_leaf')}</div><h3>התאום העברי</h3><p>ע עם עדשה, אם נרצה סימן עברי לקמפיינים בעברית. אופציונלי.</p></div>
<div class="fi"><div class="m">${S('B2')}${S('task_loop').replace('<svg','<svg style="margin-inline-start:8px"')}</div><h3>השפה הגרפית</h3><p>ב2 וב4 לסצנות של תיאום, והלולאה שנסגרת כאייקון "בוצע" בכרטיס הלו"ז ובדאשבורד.</p></div>
</div></section>
<div class="ask"><h3>מה אני צריך ממך</h3><ol>
<li>ה־A עם העדשה: הוא מרגיש כמו הלוגו? אם לא, איזה מהאחרים הכי קרוב?</li>
<li>לוגו אחד לשתי השפות (A), או גם ע לעברית?</li>
<li>allma עם שני ה־l: כיוון נכון לשם הכתוב, או להישאר עם Rubik רגיל ליד הסימן?</li>
</ol></div>
</div>`;
require('fs').writeFileSync('olma-mark-round2.html',html);console.log(html.length);
