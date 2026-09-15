#!/usr/bin/env node
// Prints whole files wrapped in <file> tags, for a cheap worker model to read in
// one call. The read path the shunt hook always allows: see .claude/hooks/shunt.js.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const files = process.argv.slice(2);
if (files.length === 0) {
  process.stderr.write('usage: bulk-cat.js <file> [file...]\n');
  process.exit(2);
}

const MAX_BYTES = Number(process.env.SHUNT_MAX_PAYLOAD_BYTES || 400_000);
let total = 0;

for (const file of files) {
  const abs = path.resolve(file);
  let body;
  try {
    body = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    process.stdout.write(`<file path="${file}" error="${err.code || 'unreadable'}" />\n`);
    continue;
  }
  total += Buffer.byteLength(body, 'utf8');
  if (total > MAX_BYTES) {
    process.stdout.write(
      `<truncated reason="payload over ${MAX_BYTES} bytes" at="${file}" />\n`
    );
    process.exit(0);
  }
  const numbered = body
    .split('\n')
    .map((line, i) => `${i + 1}\t${line}`)
    .join('\n');
  process.stdout.write(`<file path="${file}">\n${numbered}\n</file>\n`);
}
