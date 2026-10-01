'use strict';
// The one multipart/form-data reader this zero-dependency dashboard needs: the
// ad library's upload form (sections/brand.js). A file arrives as one part with
// a filename; everything else is a plain field. Bounded before it is read —
// a body over `limit` is refused, never buffered.

function readRaw(req, limit) {
  return new Promise((resolve) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      return resolve({ tooBig: true });
    }
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (d) => {
      if (over) return;
      size += d.length;
      if (size > limit) { over = true; chunks.length = 0; return; }
      chunks.push(d);
    });
    req.on('end', () => resolve(over ? { tooBig: true } : { body: Buffer.concat(chunks) }));
    req.on('error', () => resolve({ tooBig: true }));
  });
}

function boundaryOf(contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''));
  return m ? (m[1] || m[2]).trim() : null;
}

// → { fields: {name: string}, files: {name: {filename, data}} }, or null when
// the body is not multipart at all.
function parse(body, contentType) {
  const boundary = boundaryOf(contentType);
  if (!boundary || !Buffer.isBuffer(body)) return null;
  const delim = Buffer.from(`--${boundary}`);
  const fields = {};
  const files = {};
  let at = body.indexOf(delim);
  while (at !== -1) {
    const start = at + delim.length;
    // "--" right after a delimiter closes the body.
    if (body.slice(start, start + 2).toString() === '--') break;
    const next = body.indexOf(delim, start);
    if (next === -1) break;
    // Each part is CRLF, headers, CRLF CRLF, content, CRLF before the next delimiter.
    const part = body.slice(start + 2, next - 2);
    const split = part.indexOf('\r\n\r\n');
    if (split !== -1) {
      const head = part.slice(0, split).toString('utf8');
      const data = part.slice(split + 4);
      const name = /name="([^"]*)"/i.exec(head);
      const filename = /filename="([^"]*)"/i.exec(head);
      if (name) {
        if (filename) files[name[1]] = { filename: filename[1], data };
        else fields[name[1]] = data.toString('utf8');
      }
    }
    at = next;
  }
  return { fields, files };
}

module.exports = { readRaw, parse, boundaryOf };
