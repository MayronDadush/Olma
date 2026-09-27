const {Resvg}=require('/Users/kwak/Desktop/Mayron/Olma/olma2/node_modules/@resvg/resvg-js');
const {M,svg,VIEW}=require('./marks2.js');
const keys=Object.keys(M).filter(k=>!k.startsWith("_")); const W=180, cols=6, rows=Math.ceil(keys.length/cols);
let out='';
keys.forEach((k,i)=>{const x=(i%cols)*W, y=Math.floor(i/cols)*220;const wide=VIEW[k]; const s=svg(k);
  out+=s.replace('<svg ',`<svg x="${x+20}" y="${y+10}" width="${wide?140:140}" height="${wide?70:140}" `);
  out+=s.replace('<svg ',`<svg x="${x+70}" y="${y+160}" width="${wide?56:32}" height="${wide?28:32}" `);});
const full=`<svg xmlns="http://www.w3.org/2000/svg" width="${cols*W}" height="${rows*220}"><rect width="100%" height="100%" fill="#F7F1E6"/>${out}</svg>`;
require('fs').writeFileSync('round2.png',new Resvg(full).render().asPng()); console.log(keys.join(' '));
