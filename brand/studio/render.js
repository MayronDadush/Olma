// Renders a studio scene to a real video (or a still), frame by frame, on this Mac.
// A scene is an HTML page that defines window.__seek(ms) and window.__ms (its length);
// nothing plays on a wall clock, so a slow machine can never drop or smear a frame.
//
//   node brand/studio/render.js <scene.html> <out.mp4|out.png> [--fps 30] [--size 1080x1080] [--at ms] [--crf 16]
//
// --crf is x264 quality: 16 is a master copy, 28 is what goes out over WhatsApp
// (grain is expensive to encode; a 14.6s intro is 2.2MB at 16 and ~0.5MB at 28).
//
// Needs Google Chrome and ffmpeg (both local). A .png output renders the single frame --at.
const { spawn, spawnSync } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const [scene, out] = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
if (!scene || !out) { console.error('usage: render.js <scene.html> <out.mp4|out.png> [--fps 30] [--size WxH] [--at ms]'); process.exit(2); }
const fps = Number(opt('fps', 30)), [W, H] = opt('size', '1080x1080').split('x').map(Number);
const CH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', PORT = 9334;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'allma-render-'));
const chrome = spawn(CH, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(tmp, 'prof')}`,
  '--hide-scrollbars', '--force-color-profile=srgb', 'about:blank'], { stdio: 'ignore' });

(async () => {
  let list; for (let i = 0; i < 40; i++) { try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); if (list.length) break; } catch {} await sleep(250); }
  const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const pend = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;

  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Page.enable');
  // A scene may take options as a query string: scenes/intro.html?lang=en
  const [file, query] = scene.split('?');
  await send('Page.navigate', { url: 'file://' + path.resolve(file) + (query ? '?' + query : '') });
  for (let i = 0; i < 40 && !(await js('typeof window.__seek === "function"')); i++) await sleep(150);
  await js('document.fonts.ready.then(() => true)');
  if (!(await js('document.fonts.check("700 40px \\"IBM Plex Sans Hebrew\\"")'))) console.warn('warning: IBM Plex Sans Hebrew did not load; the frames use a fallback font');
  const total = Number(await js('window.__ms'));
  const shot = async (file) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(file, Buffer.from(r.result.data, 'base64')); };

  if (out.endsWith('.png')) {
    await js(`__seek(${Number(opt('at', total))})`); await sleep(30); await shot(out);
  } else {
    const n = Math.round((total / 1000) * fps);
    for (let f = 0; f <= n; f++) {
      await js(`__seek(${(f * 1000) / fps})`);
      await shot(path.join(tmp, `f${String(f).padStart(5, '0')}.png`));
    }
    const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', path.join(tmp, 'f%05d.png'),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', String(opt('crf', 16)), '-preset', 'slow', '-movflags', '+faststart', out], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('ffmpeg failed');
    console.log(`${n + 1} frames, ${(total / 1000).toFixed(2)}s at ${fps}fps, ${W}x${H}`);
  }
  console.log('wrote', out);
  ws.close();
  // Chrome keeps writing its profile until it has actually exited, so wait for that
  // before removing the folder; a leftover temp folder is not worth failing the render.
  await new Promise((r) => { chrome.once('exit', r); chrome.kill(); });
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
})().catch((e) => { console.error(e); chrome.kill(); process.exit(1); });
