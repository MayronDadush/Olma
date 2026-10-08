'use strict';
// Reads the saved links the save itself could not ("שמורים",
// docs/design/saved-links-handoff.md), and keeps their pictures.
//
// A save never waits on a slow page: past its budget the link is saved unread
// with `next_try_at = now`, and this job reads it on its next tick. A link
// that cannot be read is tried again after 1h, 6h and 24h, then left alone —
// still saved, with its title missing, which the page draws as "בלי פירוט".
//
// The network is reached OUTSIDE any transaction, one link at a time, and
// each result is written in its own short one: a page that takes five
// seconds must not hold a connection the live users share.
//
// Nothing is said to anybody. A link read late changes what the page and the
// tool show, never a message (the brief: nothing about saved links goes out
// unasked).
const { withTx } = require('../db/pool');
const extract = require('../domain/link-extract');
const savedLinks = require('../domain/saved-links');

const READS_PER_TICK = 10;
const THUMBS_PER_TICK = 10;

async function run(pool, { fetchImpl, lookup, now } = {}) {
  const out = { read: 0, failed: 0, thumbs: 0, thumbsMissing: 0 };
  const due = await savedLinks.dueForEnrich(pool, { now, limit: READS_PER_TICK });
  for (const row of due) {
    const lang = String(row.locale || '').startsWith('en') ? 'en' : 'he';
    const read = await extract.extract(row.url, { fetchImpl, lookup, lang });
    const res = await withTx(pool, (c) => savedLinks.applyRead(c, row, read, { now }));
    if (res.read) out.read += 1; else out.failed += 1;
  }
  const thumbs = await savedLinks.dueForThumb(pool, { limit: THUMBS_PER_TICK });
  for (const row of thumbs) {
    const image = await extract.fetchImage(row.image_url, { fetchImpl, lookup });
    const kept = await withTx(pool, (c) => savedLinks.storeThumb(c, row.id, image));
    if (kept) out.thumbs += 1; else out.thumbsMissing += 1;
  }
  return out;
}

module.exports = { run, READS_PER_TICK, THUMBS_PER_TICK };
