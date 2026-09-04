# Builds avatar-styles.html — a side-by-side comparison page for the avatar set.
# It lifts the character module and its CSS straight out of user-dashboard.html
# so the page can never drift from the real thing; the "legacy" variants are
# patched on top HERE and deliberately never enter the app file.
import io

src = io.open("user-dashboard.html", encoding="utf-8").read()

i = src.index("var PAL = {")
j = src.index("function seedIndex")
j = src.index("\n", src.index("}", src.index("return", j)))
JS = src[i:j + 1]

ci = src.index(".ava{--lid:0}")
cj = src.index("avaConf{animation:none}", ci)
cj = src.index("}", src.index("avaLids{transform", cj)) + 1
CSS = src[ci:cj]

LEGACY = r"""
/* ── the earlier passes, kept only here ─────────────────────────────
   Each is a patch over the live module rather than a second drawing,
   so a change to the real set still shows up in every column. */
var MASKS = {
  cat:      function(c){ return ell(50,66,13,9,c.fur2); },
  dog:      function(c){ return ell(50,70,11,7.5,c.fur2)+ell(50,39,9,6,c.fur2); },
  bear:     function(c){ return ell(50,66,13.5,9.5,c.fur2); },
  koala:    function(c){ return ell(50,66,14,10,c.fur2); },
  rabbit:   function(c){ return ell(50,67,12,8.5,c.fur2); },
  mouse:    function(c){ return ell(50,67,12,8,c.fur2); },
  tiger:    function(c){ return S("M33 42 L37 47",c.acc,2.4)+S("M42 38 L44 44",c.acc,2.4)+S("M67 42 L63 47",c.acc,2.4)+S("M58 38 L56 44",c.acc,2.4)+S("M24 60 L31 60",c.acc,2.4)+S("M76 60 L69 60",c.acc,2.4)+ell(50,66,12,8,c.fur2); },
  lion:     function(c){ return ell(50,66,13,9,c.fur2); },
  monkey:   function(c){ return ell(50,60,20,19,c.fur2)+P("M32 44 Q50 34 68 44 Q50 40 32 44 Z",c.fur); },
  frog:     function(c){ return ell(50,73,14,6.5,PAL.cream); },
  hedgehog: function(c){ return ell(50,64,20,18,c.fur)+ell(50,70,11,7,c.fur2); },
  deer:     function(c){ return ell(50,70,13,9,c.fur2)+circ(35,61,2.6,c.fur2)+circ(65,61,2.6,c.fur2); }
};
var LIVE_MARKS = {}, LIVE_LID = {};
ANIMALS.forEach(function(a){ LIVE_MARKS[a.id] = a.marks; LIVE_LID[a.id] = a.lid; });

var liveSmile = smile, liveGender = genderMark, liveRig = rig;

function legacySmile(cx,cy,w,c){
  return S("M"+(cx-w)+" "+cy+" Q"+cx+" "+(cy+w*0.78).toFixed(1)+" "+(cx+w)+" "+cy, c, 2);
}
function legacyGender(g,c){
  if(g === "f"){
    var f = "", k;
    for(k = 0; k < 5; k++){
      var a = k / 5 * Math.PI * 2;
      f += circ((26 + Math.cos(a) * 4.4).toFixed(1), (34 + Math.sin(a) * 4.4).toFixed(1), 3.4, PAL.rose);
    }
    return f + circ(26,34,2.2,PAL.cream);
  }
  return S("M72 30 L74 40",PAL.moss,2.2) + ell(69.5,32.5,3.6,2.2,PAL.moss) + ell(76.5,35,3.6,2.2,PAL.moss);
}
/* the catchlight the complaint was about: a third smaller, and it vanishes */
function legacyRig(lidFill, sclera){
  return (sclera ? ell(40,53,5.4,6.2,PAL.white) + ell(60,53,5.4,6.2,PAL.white) : "") +
    '<g class="avaPupils">' +
      ell(40,53,4.1,4.9,INK) + ell(60,53,4.1,4.9,INK) +
      circ(41.4,51.4,1.15,PAL.white) + circ(61.4,51.4,1.15,PAL.white) +
    '</g>' +
    '<g class="avaLids"><rect x="30" y="43" width="40" height="16" fill="'+lidFill+'"/></g>';
}
function useVersion(v){
  var legacy = (v === "v1");
  smile = legacy ? legacySmile : liveSmile;
  genderMark = legacy ? legacyGender : liveGender;
  rig = legacy ? legacyRig : liveRig;
  ANIMALS.forEach(function(a){
    a.marks = legacy && MASKS[a.id] ? MASKS[a.id] : LIVE_MARKS[a.id];
    a.lid = legacy && a.id === "frog" ? a.fur : LIVE_LID[a.id];
  });
}
var VERSIONS = [
  { id:"v1", t:"מדבקות לוע + אביזרים", d:"הסט לפני התיקון האחרון: כתם לוע רחב שקורא כמסכה, פרח ועלה כסימני מגדר, נקודה לבנה קטנה בעין, חיוך עמוק — ועם הצל הארוך.", opt:{style:"flat", shadow:true} },
  { id:"v2", t:"אחרי התיקון, עם צל", d:"בלי מדבקות לוע, גבות ישרות מול ריסים, נקודה לבנה גדולה פי שלושה, חיוך רדוד. הצל הארוך עדיין שם.", opt:{style:"flat", shadow:true} },
  { id:"v3", t:"בלי צל", d:"אותו סט שטוח, בלי הצל הארוך.", opt:{style:"flat"} },
  { id:"v4", t:"בהשראת האיור", d:"קו מתאר כהה דק סביב הצללית, לובן־עין עם אישון קטן, ועפעף שנח קצת מושפל. פינות מעוגלות והרעמה של האריה לא אחידה. זו הגרסה שרצה עכשיו בדאשבורד.", opt:{style:"line"} },
  { id:"v5", t:"רך ומבריק", d:"בהשראת סט האיורים השני: עין כהה עם נצנוץ לבן גדול, עיגול רקע בשני גוונים של אותו צבע, הצללה רכה על צד אחד של הפנים, כתפיים מתחת לראש — והאוזניים והקרניים חורגות מהעיגול במקום להיחתך בו.", opt:{style:"soft"} }
];
"""

UI = r"""
var GRID = document.getElementById("grid"), NOTE = document.getElementById("note"),
    SEG = document.getElementById("seg"), N = ANIMALS.length;
var state = { v:"v4", g:"m", night:false, bday:false, small:false };

VERSIONS.forEach(function(v){
  var b = document.createElement("button");
  b.className = "sg"; b.dataset.v = v.id; b.textContent = v.t;
  b.addEventListener("click", function(){ state.v = v.id; draw(); });
  SEG.appendChild(b);
});
document.querySelectorAll("[data-tog]").forEach(function(b){
  b.addEventListener("click", function(){
    var k = b.dataset.tog;
    if(k === "g") state.g = state.g === "m" ? "f" : "m"; else state[k] = !state[k];
    draw();
  });
});

function draw(){
  var v = VERSIONS.filter(function(x){ return x.id === state.v; })[0];
  useVersion(v.id);
  NOTE.textContent = v.d;
  document.querySelectorAll(".sg").forEach(function(b){ b.classList.toggle("on", b.dataset.v === state.v); });
  document.querySelectorAll("[data-tog]").forEach(function(b){
    var k = b.dataset.tog;
    b.classList.toggle("on", k === "g" ? state.g === "f" : !!state[k]);
    if(k === "g") b.textContent = state.g === "f" ? "נקבה" : "זכר";
  });
  GRID.classList.toggle("small", state.small);
  var html = "";
  for(var k = 0; k < N; k++){
    html += '<div class="cell"><div class="ring">' +
      avatarSVG(k, { g:state.g, night:state.night, bday:state.bday,
                     style:v.opt.style, shadow:!!v.opt.shadow }) +
      '</div><span>' + ANIMALS[k].id + '</span></div>';
  }
  GRID.innerHTML = html;
}
draw();

var praf = 0, pxy = null;
function track(){
  if(!pxy) return;
  document.querySelectorAll(".avaPupils").forEach(function(g){
    var r = g.ownerSVGElement.getBoundingClientRect();
    if(!r.width) return;
    var dx = (pxy.x - (r.left + r.width / 2)) / (r.width / 2),
        dy = (pxy.y - (r.top + r.height / 2)) / (r.height / 2),
        m = Math.hypot(dx, dy) || 1, c = Math.min(1, m) / m;
    g.style.transform = "translate(" + (dx * c * 2.4).toFixed(2) + "px," + (dy * c * 1.9).toFixed(2) + "px)";
  });
}
window.addEventListener("pointermove", function(e){
  pxy = { x:e.clientX, y:e.clientY };
  if(praf) return;
  praf = requestAnimationFrame(function(){ praf = 0; track(); });
}, { passive:true });
"""

PAGE = """<title>מעבדת האווטארים</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Assistant:wght@400;600;700&family=Rubik:wght@600;700&display=swap">
<style>
:root{
  --bg:#F2EDE4; --panel:#FBF8F2; --sep:rgba(59,59,59,.10);
  --text:#2C2A27; --text-2:#6B6660; --text-3:#9A948C; --accent:#1C7B7E; --accent-soft:rgba(28,123,126,.12);
}
:root:not([data-theme="light"]){}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    --bg:#131211; --panel:#1D1B19; --sep:rgba(255,255,255,.09);
    --text:#F2EFE9; --text-2:#A8A29A; --text-3:#79736B; --accent:#5CC0B6; --accent-soft:rgba(92,192,182,.16);
  }
}
:root[data-theme="dark"]{
  --bg:#131211; --panel:#1D1B19; --sep:rgba(255,255,255,.09);
  --text:#F2EFE9; --text-2:#A8A29A; --text-3:#79736B; --accent:#5CC0B6; --accent-soft:rgba(92,192,182,.16);
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);direction:rtl;
  font-family:Assistant,"Segoe UI",system-ui,sans-serif;font-size:15px;line-height:1.55;
  padding:26px 20px 64px;-webkit-font-smoothing:antialiased}
.wrap{max-width:760px;margin:0 auto}
h1{font-family:Rubik,Assistant,sans-serif;font-weight:700;font-size:27px;letter-spacing:-.01em;margin:0 0 4px;text-wrap:balance}
.sub{color:var(--text-2);margin:0 0 22px;max-width:56ch}
.bar{position:sticky;top:0;z-index:5;background:var(--bg);padding:10px 0 12px;margin-bottom:4px}
.seg{display:flex;gap:6px;background:var(--panel);border:1px solid var(--sep);border-radius:15px;padding:5px;overflow-x:auto}
.sg{flex:1 0 auto;white-space:nowrap;font:inherit;font-size:13.5px;font-weight:600;color:var(--text-2);
  background:none;border:0;border-radius:11px;padding:9px 13px;cursor:pointer;
  transition:background .22s cubic-bezier(.32,.72,0,1),color .22s cubic-bezier(.32,.72,0,1)}
.sg:hover{color:var(--text)}
.sg.on{background:var(--accent);color:#fff}
.sg:focus-visible,.tg:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.togs{display:flex;gap:7px;flex-wrap:wrap;margin-top:9px}
.tg{font:inherit;font-size:12.5px;font-weight:700;color:var(--text-2);background:var(--panel);
  border:1px solid var(--sep);border-radius:999px;padding:6px 13px;cursor:pointer;
  transition:background .2s,color .2s,border-color .2s}
.tg.on{background:var(--accent-soft);color:var(--accent);border-color:transparent}
.note{color:var(--text-2);font-size:13.5px;margin:14px 2px 20px;min-height:3em;max-width:60ch}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:20px 14px}
.grid.small{grid-template-columns:repeat(auto-fill,minmax(52px,1fr));gap:16px 10px}
.cell{display:flex;flex-direction:column;align-items:center;gap:7px;min-width:0}
.cell span{font-size:10.5px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--text-3);direction:ltr}
.grid.small .cell span{display:none}
.ring{width:100%;aspect-ratio:1;border-radius:50%;overflow:hidden}
.ring svg{display:block;width:100%;height:100%}
%CSS%
</style>
<div class="wrap">
  <h1>מעבדת האווטארים</h1>
  <p class="sub">אותן חמש־עשרה דמויות, חמש גרסאות. אפשר להחליף ביניהן ולראות בדיוק מה השתנה בכל שלב.</p>
  <div class="bar">
    <div class="seg" id="seg"></div>
    <div class="togs">
      <button class="tg" data-tog="g">זכר</button>
      <button class="tg" data-tog="night">לילה</button>
      <button class="tg" data-tog="bday">יום הולדת</button>
      <button class="tg" data-tog="small">גודל אמיתי</button>
    </div>
  </div>
  <p class="note" id="note"></p>
  <div class="grid" id="grid"></div>
</div>
<script>
%JS%
%LEGACY%
%UI%
</script>
"""

out = (PAGE.replace("%CSS%", CSS)
           .replace("%JS%", JS)
           .replace("%LEGACY%", LEGACY)
           .replace("%UI%", UI))
io.open("avatar-styles.html", "w", encoding="utf-8").write(out)
print("wrote avatar-styles.html", len(out))
