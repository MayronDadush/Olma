'use strict';
// List Cartesia voices matching a name fragment (default: yarden).
const fs = require('node:fs');
for (const line of fs.readFileSync('/opt/olma2-voice-bridge/.env', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const frag = (process.argv[2] || 'yarden').toLowerCase();
const H = { 'X-API-Key': process.env.CARTESIA_API_KEY, 'Cartesia-Version': '2025-04-16' };
(async () => {
  // The bare /voices/ list shows only ~10 starred defaults; paginate the full
  // library and also try the search route, whichever this API version has.
  let after = '', total = 0, pages = 0;
  while (pages++ < 40) {
    const u = `https://api.cartesia.ai/voices/?limit=100&is_starred=false${after ? '&starting_after=' + after : ''}`;
    const res = await fetch(u, { headers: H });
    if (!res.ok) { console.log('page', pages, '->', res.status); break; }
    const list = await res.json();
    const voices = Array.isArray(list) ? list : (list.data || []);
    if (!voices.length) break;
    total += voices.length;
    for (const v of voices) {
      if ((v.name || '').toLowerCase().includes(frag) || (v.language || '') === 'he') {
        console.log(v.id, '|', v.name, '|', v.language || '?', '|', (v.description || '').slice(0, 70));
      }
    }
    if (list.has_more === false || voices.length < 100) break;
    after = voices[voices.length - 1].id;
  }
  console.log('scanned', total, 'voices');
})().catch((e) => { console.error(e.message); process.exit(1); });
