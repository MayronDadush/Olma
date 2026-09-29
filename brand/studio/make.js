#!/usr/bin/env node
'use strict';
// Every format of one content file, in one command:
//   node brand/studio/make.js <content> [--video] [--only post|story|carousel]
// writes brand/studio/out/<content>/post.png, story.png, carousel-1..N.png,
// and with --video also post.mp4 and story.mp4 (crf 28, what goes out over
// WhatsApp and Instagram). Each file is one render.js run, one after another:
// they share Chrome's debugging port.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith('--'));
if (!name || !/^[a-z0-9-]+$/.test(name)) { console.error('usage: make.js <content> [--video] [--only post|story|carousel]'); process.exit(2); }
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const video = args.includes('--video');

const dir = __dirname;
global.window = {};
require(path.join(dir, 'content', name + '.js'));
const C = global.window.CONTENT;
const out = path.join(dir, 'out', name);
fs.mkdirSync(out, { recursive: true });

const SIZE = { post: '1080x1080', story: '1080x1920', carousel: '1080x1350' };
const jobs = [];
for (const fmt of ['post', 'story']) {
  if (!C[fmt] || (only && only !== fmt)) continue;
  jobs.push([`fmt=${fmt}`, SIZE[fmt], `${fmt}.png`]);
  if (video) jobs.push([`fmt=${fmt}`, SIZE[fmt], `${fmt}.mp4`]);
}
if (C.carousel && (!only || only === 'carousel')) {
  C.carousel.forEach((_, i) => jobs.push([`fmt=carousel&slide=${i + 1}`, SIZE.carousel, `carousel-${i + 1}.png`]));
}

for (const [q, size, file] of jobs) {
  const r = spawnSync('node', [path.join(dir, 'render.js'), `${path.join(dir, 'scenes', 'template.html')}?c=${name}&${q}`,
    path.join(out, file), '--size', size, ...(file.endsWith('.mp4') ? ['--crf', '28'] : [])], { stdio: 'inherit' });
  if (r.status !== 0) { console.error('failed:', file); process.exit(1); }
}
console.log(`${jobs.length} file(s) in ${path.relative(process.cwd(), out)}`);
