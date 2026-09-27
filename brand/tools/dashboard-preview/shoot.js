// Local-only: drives headless Chrome over CDP to screenshot the re-skinned /me page.
// node shoot.js <signin-url> <outdir>
const { spawn } = require('child_process'), fs = require('fs'), path = require('path');
const [signin, out, only] = process.argv.slice(2);
const CH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(out, { recursive: true });
const chrome = spawn(CH, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(out, '.prof')}`, '--hide-scrollbars', '--force-color-profile=srgb', 'about:blank'], { stdio: 'ignore' });

(async () => {
  let list; for (let i = 0; i < 40; i++) { try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); if (list.length) break; } catch {} await sleep(250); }
  const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const pend = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
  await send('Page.enable');
  await send('Page.navigate', { url: signin }); await sleep(2500);
  await js(`(document.querySelector('form button[type=submit]')||{click(){}}).click()`); await sleep(3500);
  if (!/\/me$/.test(await js('location.href'))) { await send('Page.navigate', { url: new URL('/me', signin).href }); await sleep(3000); }
  console.log('at', await js('location.href'));
  const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(r.result.data, 'base64')); };
  const pals = only ? only.split(',') : await js('Object.keys(window.__PAL||{})');
  for (const p of pals) {
    for (const tab of ['tools', 'tasks', 'friends']) {
      await js(`(document.querySelector('.tab[data-go=${tab}]')||{click(){}}).click()`); await sleep(900);
      await js(`window.scrollTo(0,0); __bt('${p}')`); await sleep(1300);
      await shot(`${p}-${tab}`);
    }
  }
  console.log('done', pals.join(','));
  ws.close(); chrome.kill();
})().catch((e) => { console.error(e); chrome.kill(); process.exit(1); });
