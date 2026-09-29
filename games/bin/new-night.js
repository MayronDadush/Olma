#!/usr/bin/env node
'use strict';
// Open a night from the box, for stage 1 (before Olma can do it):
//   node bin/new-night.js "פוקר של חמישי" 50 1000 [מיכל,יוסי,דני]
// Prints the link. Asks gamesd on 127.0.0.1, so it goes through the same
// code the page and, later, Olma's tool use.
const PORT = parseInt(process.env.GAMES_PORT || '8794', 10);
const [name, price, chips, names] = process.argv.slice(2);

if (!name || !price || !chips) {
  console.error('usage: new-night.js "<name>" <price ₪> <chips per buy-in> [name,name,...]');
  process.exit(2);
}

(async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/nights`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, price: Number(price), chips: Number(chips), players: names ? names.split(',') : [] }),
  });
  const body = await res.json();
  if (!res.ok) { console.error('refused:', body.error || res.status); process.exit(1); }
  console.log(body.url);
})().catch(e => { console.error(e.message); process.exit(1); });
