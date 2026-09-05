#!/usr/bin/env node
'use strict';
// Take a user back to their very first message, then put them back exactly as
// they were. Built for "let me feel the onboarding again on my own number"
// (2026-09-04) — the only faithful way to test a cold start is to actually BE
// cold, and the only safe way to do that on a real account is to be able to
// prove you can undo it.
//
//   node scripts/user-testbed.js snapshot <target> [--label before-v3]
//   node scripts/user-testbed.js list     [<target>]
//   node scripts/user-testbed.js verify    <target> --from <label>
//   node scripts/user-testbed.js reset     <target> --from <label> [--apply]
//   node scripts/user-testbed.js restore   <target> --from <label> [--apply]
//   node scripts/user-testbed.js rehearse  <target> [--from <label>]
//
// <target> is +E.164 or `id:<n>` — the id form keeps a real phone number out
// of your scrollback.
//
// WHY IT IS SHAPED LIKE THIS
//
// `reset` is not a fake state — it is the real `deprovisionUser`, the same code
// the dashboard's delete button runs. That is deliberate: a simulated "pretend
// you are new" (blank the columns, wipe the workspace) tests a state that no
// real person is ever in. A genuine new user has no DB row and no binding, so
// their first message lands on the intake catch-all — and THAT is the path we
// want to feel. Anything less tests the wrong thing.
//
// The price of using the real delete is that the delete cascades, so the
// snapshot has to capture the cascade, not just the rows that look like they
// belong to this person. It does not model that cascade by hand: it runs the
// DELETE inside a transaction that is ALWAYS rolled back and diffs the
// before/after row sets. Postgres computes the blast radius; we only record it.
// A table added by a future migration is therefore captured on the day it is
// added, with nobody having to remember this file exists.
//
// WHAT IS DELIBERATELY NOT SNAPSHOTTED
//
//   - `/root/.openclaw/agents/u-<id>/` (~125MB, the conversation transcripts).
//     `deprovisionUser` does not touch it — it removes the workspace and the
//     roster entry only — so it survives a reset on its own and comes back
//     when the agent id does. It is checked for presence at every step and
//     reported, never assumed. `--include-agent-dir` tars it anyway if you
//     want the belt as well as the braces.
//   - The person's WhatsApp app. Their old thread with Olma is on their phone
//     and no server-side reset can clear it. A cold start read underneath a
//     visible old conversation is the one part of this that cannot be faked.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createPool } = require('../src/db/pool');
const { deprovisionUser, previewDeletion } = require('../src/intake/deprovision');
const { removeWorkspaceTree } = require('../src/intake/provision');
const occ = require('../src/intake/openclaw-config');
const { refreshUserCard } = require('../src/intake/user-card');

const ROOT = process.env.OLMA_TESTBED_DIR || '/opt/olma2-testbed';

// ---------------------------------------------------------------- introspect

// Every FK edge in the schema, with its ON DELETE action. `confdeltype` is a
// single char: a=NO ACTION, r=RESTRICT, c=CASCADE, n=SET NULL, d=SET DEFAULT.
async function fkEdges(client) {
  const { rows } = await client.query(`
    SELECT con.conname                AS name,
           src.relname                AS child,
           a.attname                  AS child_col,
           tgt.relname                AS parent,
           b.attname                  AS parent_col,
           con.confdeltype            AS ondel,
           a.attnotnull               AS child_notnull
    FROM pg_constraint con
    JOIN pg_class src ON src.oid = con.conrelid
    JOIN pg_class tgt ON tgt.oid = con.confrelid
    JOIN unnest(con.conkey)  WITH ORDINALITY AS ck(attnum, ord) ON true
    JOIN unnest(con.confkey) WITH ORDINALITY AS pk(attnum, ord) ON pk.ord = ck.ord
    JOIN pg_attribute a ON a.attrelid = con.conrelid  AND a.attnum = ck.attnum
    JOIN pg_attribute b ON b.attrelid = con.confrelid AND b.attnum = pk.attnum
    WHERE con.contype = 'f' AND src.relnamespace = 'public'::regnamespace
    ORDER BY src.relname, con.conname`);
  return rows;
}

async function primaryKeys(client) {
  const { rows } = await client.query(`
    SELECT c.relname AS tbl, a.attname AS col, k.ord AS ord
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
    WHERE con.contype = 'p' AND c.relnamespace = 'public'::regnamespace
    ORDER BY c.relname, k.ord`);
  const pk = {};
  for (const r of rows) (pk[r.tbl] = pk[r.tbl] || []).push(r.col);
  return pk;
}

async function columns(client, tbl) {
  const { rows } = await client.query(
    `SELECT attname AS col, attidentity AS identity, format_type(atttypid, atttypmod) AS type
     FROM pg_attribute
     WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped
     ORDER BY attnum`, [tbl]);
  return rows;
}

// A jsonb column whose value is a JSON ARRAY reads back as a JS array, and
// node-pg serialises a JS array as a Postgres ARRAY literal — `{"a","b"}` —
// which json input rejects. Objects survive by luck (node-pg JSON.stringifies
// them); arrays do not. So say what we mean for every json column rather than
// relying on which JS type happened to come out. Caught by `rehearse` against
// real data before it could cost anybody their account, which is the entire
// reason that command exists.
function encodeForInsert(value, type) {
  if (value === null || value === undefined) return value;
  return (type === 'json' || type === 'jsonb') ? JSON.stringify(value) : value;
}

// Tables a DELETE FROM users would reach by cascade, transitively.
function cascadeClosure(edges, from = 'users') {
  const closure = new Set([from]);
  for (let grew = true; grew;) {
    grew = false;
    for (const e of edges) {
      if (e.ondel === 'c' && closure.has(e.parent) && !closure.has(e.child)) {
        closure.add(e.child); grew = true;
      }
    }
  }
  return closure;
}

// Edges that NULL a column instead of removing the row. These rows survive the
// delete, so a PK diff cannot see them — they need their own before/after.
function setNullEdges(edges, closure) {
  return edges.filter((e) => e.ondel === 'n' && closure.has(e.parent));
}

const keyOf = (row, cols) => JSON.stringify(cols.map((c) => row[c]));

// ------------------------------------------------------------------ snapshot

// Run the real DELETE, record what Postgres actually removed, then throw the
// whole transaction away. Nothing here is a model of the cascade; it IS the
// cascade, observed. The ROLLBACK is in a finally and there is no COMMIT
// anywhere in this function — that is the safety property, so keep it that way.
async function observeDeletion(pool, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const edges = await fkEdges(client);
    const pk = await primaryKeys(client);
    const closure = cascadeClosure(edges);
    const nullEdges = setNullEdges(edges, closure);

    const before = {};
    for (const tbl of closure) {
      before[tbl] = (await client.query(`SELECT * FROM ${tbl}`)).rows;
    }
    // Rows outside the closure that merely POINT at the user: they stay, but
    // the pointer is nulled. Capture only the ones that actually point here.
    const nullBefore = {};
    for (const e of nullEdges) {
      if (closure.has(e.child)) continue; // already covered by the full copy
      const seen = nullBefore[e.child] || (nullBefore[e.child] = { cols: [], rows: null });
      seen.cols.push(e.child_col);
      if (!seen.rows) seen.rows = (await client.query(`SELECT * FROM ${e.child}`)).rows;
    }

    await client.query('DELETE FROM users WHERE id = $1', [userId]);

    const removed = {};
    for (const tbl of closure) {
      const cols = pk[tbl];
      if (!cols) throw new Error(`${tbl} has no primary key — cannot diff it`);
      const after = new Set(
        (await client.query(`SELECT ${cols.join(',')} FROM ${tbl}`)).rows.map((r) => keyOf(r, cols)));
      const gone = before[tbl].filter((r) => !after.has(keyOf(r, cols)));
      if (gone.length) removed[tbl] = gone;
    }

    // Same idea for the survivors: keep the row only if one of its pointers
    // into this user actually changed.
    const nulled = {};
    for (const [tbl, { cols, rows }] of Object.entries(nullBefore)) {
      const pkCols = pk[tbl];
      const after = new Map(
        (await client.query(`SELECT ${[...new Set([...pkCols, ...cols])].join(',')} FROM ${tbl}`)).rows
          .map((r) => [keyOf(r, pkCols), r]));
      const changed = [];
      for (const r of rows) {
        const now = after.get(keyOf(r, pkCols));
        if (!now) continue; // row vanished for some other reason; not ours to restore
        const diff = cols.filter((c) => r[c] !== null && now[c] === null);
        if (diff.length) changed.push({ pk: Object.fromEntries(pkCols.map((c) => [c, r[c]])),
                                        set: Object.fromEntries(diff.map((c) => [c, r[c]])) });
      }
      if (changed.length) nulled[tbl] = changed;
    }

    // A column inside the closure can be SET NULL too (users.invited_by_
    // connection_id). Those rows are in `removed` already if they went, and if
    // they stayed their new NULL is restored by the same mechanism.
    for (const e of nullEdges) {
      if (!closure.has(e.child)) continue;
      const pkCols = pk[e.child];
      const after = new Map(
        (await client.query(`SELECT ${[...new Set([...pkCols, e.child_col])].join(',')} FROM ${e.child}`)).rows
          .map((r) => [keyOf(r, pkCols), r]));
      const changed = (nulled[e.child] || []);
      for (const r of before[e.child]) {
        const now = after.get(keyOf(r, pkCols));
        if (!now || r[e.child_col] === null || now[e.child_col] !== null) continue;
        changed.push({ pk: Object.fromEntries(pkCols.map((c) => [c, r[c]])),
                       set: { [e.child_col]: r[e.child_col] } });
      }
      if (changed.length) nulled[e.child] = changed;
    }

    return { removed, nulled, edges, pk, closure: [...closure].sort() };
  } finally {
    // Unconditional. This function must never leave a committed delete behind.
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

// ------------------------------------------------------------ config + files

function configSlice(agentId, phone, configPath) {
  const cfg = occ.loadConfig(configPath);
  const list = cfg.agents && (cfg.agents.entries || cfg.agents.list);
  const agent = Array.isArray(list) ? list.find((a) => a.id === agentId)
    : (list && list[agentId] ? { id: agentId, ...list[agentId] } : null);
  const bindings = (cfg.bindings || []).filter(
    (b) => b.agentId === agentId || (b.match && b.match.peer && b.match.peer.id === phone));
  const allow = cfg.channels?.whatsapp?.accounts?.default?.allowFrom;
  return { agent, bindings, allowFrom: Array.isArray(allow) && allow.includes(phone) };
}

function tarDir(dir, dest) {
  if (!dir || !fs.existsSync(dir)) return null;
  execFileSync('tar', ['czf', dest, '-C', path.dirname(dir), path.basename(dir)]);
  return { path: dest, bytes: fs.statSync(dest).size };
}

function untarInto(tarPath, dir) {
  removeWorkspaceTree(dir);            // clears chattr +i first; a bare rm would EPERM
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  execFileSync('tar', ['xzf', tarPath, '-C', path.dirname(dir)]);
  // The immutable bit does not survive a tar round-trip; put it back or the
  // agent can destroy its own root of trust (incidents.md, 2026-08-27).
  if (process.env.OLMA_IMMUTABLE_IDENTITY !== 'off') {
    try { execFileSync('chattr', ['+i', path.join(dir, '.olma-identity')]); } catch { /* no chattr */ }
  }
}

function dirStat(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  let files = 0, bytes = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { files++; try { bytes += fs.statSync(p).size; } catch { /* raced */ } }
    }
  };
  walk(dir);
  return { path: dir, files, bytes };
}

// --------------------------------------------------------------- restore

// Insert order: parents before children. Where the FK graph has a cycle
// (users.invited_by_connection_id -> connections -> users), one edge on it has
// to be broken: the row goes in with that column NULL and a second pass fills
// it in. The edge chosen must be a NULLABLE one, and which edge closes the
// loop first during a walk is an accident of iteration order — so this finds
// the cycle explicitly (Kahn leaves exactly the cyclic nodes behind) and picks
// a nullable edge from it. A cycle with no nullable edge on it is a hard error,
// not something to paper over: there is no legal insert order for it.
function insertPlan(tables, edges, pk) {
  const set = new Set(tables);
  const relevant = edges.filter((e) => set.has(e.child) && set.has(e.parent));
  const deferred = [];
  const isDeferred = (e) => deferred.some((d) => d.child === e.child && d.col === e.child_col);

  // A self-referencing nullable column has the same problem inside one table,
  // and no cross-table ordering can fix it. Defer it up front.
  for (const e of relevant) {
    if (e.child === e.parent && !e.child_notnull && !isDeferred(e)) {
      deferred.push({ child: e.child, col: e.child_col });
    }
  }

  for (;;) {
    const active = relevant.filter((e) => e.child !== e.parent && !isDeferred(e));
    const indeg = new Map(tables.map((t) => [t, 0]));
    const children = new Map(tables.map((t) => [t, []]));
    for (const e of active) {
      indeg.set(e.child, indeg.get(e.child) + 1);
      children.get(e.parent).push(e.child);
    }
    const queue = tables.filter((t) => indeg.get(t) === 0);
    const order = [];
    for (let i = 0; i < queue.length; i++) {
      const t = queue[i];
      order.push(t);
      for (const c of children.get(t)) {
        indeg.set(c, indeg.get(c) - 1);
        if (indeg.get(c) === 0) queue.push(c);
      }
    }
    if (order.length === tables.length) return { order, deferred, pk };

    // Whatever Kahn could not place is exactly the set of tables caught in a
    // cycle. Break it on a nullable edge between two of them.
    const stuck = new Set(tables.filter((t) => !order.includes(t)));
    const breakable = active.find((e) => stuck.has(e.child) && stuck.has(e.parent) && !e.child_notnull);
    if (!breakable) {
      const involved = active.filter((e) => stuck.has(e.child) && stuck.has(e.parent))
        .map((e) => `${e.child}.${e.child_col} -> ${e.parent}`);
      throw new Error(`FK cycle with no nullable edge to break: ${involved.join(', ')}`);
    }
    deferred.push({ child: breakable.child, col: breakable.child_col });
  }
}

async function insertRows(client, tbl, rows, deferredCols, pkCols) {
  if (!rows.length) return 0;
  const meta = await columns(client, tbl);
  const typeOf = Object.fromEntries(meta.map((c) => [c.col, c.type]));
  const hasIdentity = meta.some((c) => c.identity === 'a' || c.identity === 'd');
  const conflict = pkCols.length ? `(${pkCols.join(',')})` : '';
  let n = 0;
  for (const row of rows) {
    // Name only the columns the SNAPSHOT actually carries. The live table is
    // read fresh here, so it also holds every column added by a migration that
    // ran AFTER the snapshot was taken — and those are absent from `row`.
    // Naming one anyway sends an explicit NULL, which overrides the DEFAULT the
    // migration handed every other existing row, and fails outright when the
    // column is NOT NULL. Omitting it lets Postgres apply that same default,
    // which is exactly what the migration did to the rows this snapshot is
    // being restored beside.
    //
    // Found 2026-09-05 restoring a 2026-09-04 snapshot: migration 031 added
    // `users.locale_observed_count INT NOT NULL DEFAULT 0`, and the restore died
    // on its not-null constraint. `rehearse` caught it against live rows and
    // rolled back, which is the whole reason that command exists.
    //
    // A column added NOT NULL with NO default still fails, and should: that row
    // genuinely cannot be reconstructed, and a silent zero would be invented data.
    const cols = meta
      .map((c) => c.col)
      .filter((c) => deferredCols.includes(c) || Object.prototype.hasOwnProperty.call(row, c));
    const values = cols.map((c) => (deferredCols.includes(c) ? null : encodeForInsert(row[c], typeOf[c])));
    const ph = cols.map((_, i) => `$${i + 1}`).join(',');
    const sql = `INSERT INTO ${tbl} (${cols.join(',')}) ${hasIdentity ? 'OVERRIDING SYSTEM VALUE ' : ''}`
      + `VALUES (${ph})${conflict ? ` ON CONFLICT ${conflict} DO NOTHING` : ''}`;
    const r = await client.query(sql, values);
    n += r.rowCount;
  }
  return n;
}

// An identity column keeps its own counter; restoring row id=3 by hand leaves
// the sequence behind it, and the next real signup collides. Push every
// sequence past whatever is now in the table.
async function resyncSequences(client, tables) {
  const fixed = [];
  for (const tbl of tables) {
    for (const c of await columns(client, tbl)) {
      const { rows } = await client.query(`SELECT pg_get_serial_sequence($1,$2) AS seq`, [tbl, c.col]);
      const seq = rows[0] && rows[0].seq;
      if (!seq) continue;
      const { rows: mx } = await client.query(`SELECT max(${c.col})::bigint AS m FROM ${tbl}`);
      const m = mx[0].m;
      if (m === null) continue;
      await client.query(`SELECT setval($1, $2, true)`, [seq, String(m)]);
      fixed.push(`${tbl}.${c.col} -> ${m}`);
    }
  }
  return fixed;
}

// -------------------------------------------------------------------- store

const slug = (phone) => phone.replace(/[^\d]/g, '');
const stampNow = () => new Date().toISOString().replace(/[:.]/g, '-').replace('Z', 'Z');

function snapDirFor(phone, name) { return path.join(ROOT, slug(phone), name); }

function listSnapshots(phone) {
  const base = phone ? [path.join(ROOT, slug(phone))] :
    (fs.existsSync(ROOT) ? fs.readdirSync(ROOT).map((d) => path.join(ROOT, d)) : []);
  const out = [];
  for (const dir of base) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      const metaPath = path.join(dir, name, 'meta.json');
      if (!fs.existsSync(metaPath)) continue;
      out.push({ dir: path.join(dir, name), name, meta: JSON.parse(fs.readFileSync(metaPath, 'utf8')) });
    }
  }
  return out;
}

function resolveSnapshot(phone, ref) {
  const all = listSnapshots(phone);
  if (!ref) return all[all.length - 1] || null;
  return all.find((s) => s.name === ref || s.meta.label === ref) || null;
}

async function phoneForId(pool, id) {
  const { rows } = await pool.query('SELECT phone FROM users WHERE id = $1', [id]);
  return rows[0] ? rows[0].phone : null;
}

// ------------------------------------------------------------------ rehearse

// A backup nobody has restored is a promise, not a backup — and this project
// has been bitten before by a safety net nobody pulled on ("a detector that can
// no longer fail is not a detector"). `rehearse` pulls on it, against the real
// production rows, inside a transaction that is ALWAYS rolled back: delete the
// user for real, restore from the snapshot, compare every row in the cascade
// closure, throw the transaction away. Nothing is committed and nothing on disk
// is touched, so it can be run before every test session and re-proves the
// claim against today's schema and today's data.
//
// It covers the DB half. The two halves a transaction cannot reach — the
// workspace tar and the gateway config slice — are checked separately below,
// non-destructively. Saying which half was proved matters more than a single
// green word: a rehearsal that quietly checked less than you think is the
// failure mode this whole file exists to avoid.
async function stateOfClosure(client) {
  const edges = await fkEdges(client);
  const out = {};
  for (const tbl of [...cascadeClosure(edges)].sort()) {
    const { rows } = await client.query(`SELECT * FROM ${tbl}`);
    out[tbl] = rows.map((r) => JSON.stringify(r, Object.keys(r).sort())).sort();
  }
  return out;
}

function diffState(before, after) {
  const problems = [];
  for (const tbl of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const b = before[tbl] || [], a = after[tbl] || [];
    if (b.length !== a.length) { problems.push(`${tbl}: ${b.length} rows before, ${a.length} after`); continue; }
    const changed = b.filter((r, i) => a[i] !== r);
    if (changed.length) problems.push(`${tbl}: ${changed.length} row(s) came back different`);
  }
  return problems;
}

// The DB half of cmdRestore, against an open client. cmdRestore calls this too,
// so the rehearsal exercises the same code the emergency would — a rehearsal
// of a re-implementation proves nothing about the real thing.
async function restoreRowsInto(client, data) {
  const plan = insertPlan(Object.keys(data.removed), data.edges, data.pk);
  const inserted = {};
  for (const tbl of plan.order) {
    const defer = plan.deferred.filter((d) => d.child === tbl).map((d) => d.col);
    inserted[tbl] = await insertRows(client, tbl, data.removed[tbl] || [], defer, data.pk[tbl] || []);
  }
  let deferredSet = 0;
  for (const { child, col } of plan.deferred) {
    const pkCols = data.pk[child];
    for (const row of data.removed[child] || []) {
      if (row[col] === null || row[col] === undefined) continue;
      const where = pkCols.map((c, i) => `${c} = $${i + 2}`).join(' AND ');
      const r = await client.query(
        `UPDATE ${child} SET ${col} = $1 WHERE ${where} AND ${col} IS DISTINCT FROM $1`,
        [row[col], ...pkCols.map((c) => row[c])]);
      deferredSet += r.rowCount;
    }
  }
  let repointed = 0;
  for (const [tbl, entries] of Object.entries(data.nulled || {})) {
    for (const { pk: pkVals, set } of entries) {
      const cols = Object.keys(set);
      const sets = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
      const names = Object.keys(pkVals);
      const where = names.map((c, i) => `${c} = $${cols.length + i + 1}`).join(' AND ');
      const r = await client.query(`UPDATE ${tbl} SET ${sets} WHERE ${where}`,
        [...cols.map((c) => set[c]), ...names.map((c) => pkVals[c])]);
      repointed += r.rowCount;
    }
  }
  const sequences = await resyncSequences(client, plan.order);
  return { inserted, deferredSet, repointed, sequences, plan };
}

// A snapshot carries the identity token of its day, and a restore puts that
// token back as LIVE. If the token was rotated between snapshot and restore —
// which is what a rotation is for: the old one had leaked — the restore
// quietly re-arms the leaked credential. Found 2026-09-05: user 3 was restored
// from a 2026-09-04 snapshot taken before that day's rotation, and within the
// hour config_guard re-filed the 2026-09-02 leak as issue 72, "still works".
//
// So a restore ends by minting a fresh token, always. Deciding "was it rotated
// since?" would be one more thing to get wrong, and a restore is already the
// moment the open session's context is stale — one failed call that recovers
// from .olma-identity is the same cost rotateIdentityToken documents. The
// order (file, DB, AGENTS.md) and the verification are its own.
async function remintAfterRestore(client, userId, { log, snapshot, run } = {}) {
  const { rotateIdentityToken } = require('../src/domain/identity-repair');
  return rotateIdentityToken(client, {
    userId, apply: true, log, run,
    reason: `restored from snapshot ${snapshot || '?'} — a snapshot's token may have been rotated away since`,
  });
}

async function cmdRehearse(pool, phone, ref) {
  const snap = cmdVerify(phone, ref);
  if (!snap) { console.error('\nnothing to rehearse — take a snapshot first'); process.exitCode = 1; return; }
  const data = JSON.parse(fs.readFileSync(path.join(snap.dir, 'db.json'), 'utf8'));

  // deprovisionUser writes the gateway config and can remove a workspace.
  // Point it at a throwaway copy and tell it to leave the workspace alone
  // BEFORE anything runs — a rehearsal that damages the real thing is worse
  // than no rehearsal at all.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olma-rehearse-'));
  const cfgPath = path.join(tmp, 'openclaw.json');
  fs.copyFileSync(process.env.OLMA_OPENCLAW_CONFIG || occ.DEFAULT_PATH || '/root/.openclaw/openclaw.json', cfgPath);

  const client = await pool.connect();
  let problems = [];
  let rowsChecked = 0;
  try {
    await client.query('BEGIN');
    const before = await stateOfClosure(client);
    rowsChecked = Object.values(before).reduce((a, r) => a + r.length, 0);

    const del = await deprovisionUser(client, phone, { configPath: cfgPath, removeWorkspace: false });
    if (!del.ok) throw new Error(`deprovision failed: ${del.error.message}`);
    const { rows: gone } = await client.query('SELECT count(*)::int c FROM users WHERE phone = $1', [phone]);
    if (gone[0].c !== 0) throw new Error('the user was not actually deleted — this rehearsal proves nothing');

    const res = await restoreRowsInto(client, data);
    problems = diffState(before, await stateOfClosure(client));

    console.log(`\ndatabase: deleted user ${data.userId} for real and restored `
      + `${Object.values(res.inserted).reduce((a, b) => a + b, 0)} rows `
      + `(${res.deferredSet} deferred columns, ${res.repointed} pointers, `
      + `${res.sequences.length} sequences).`);
  } finally {
    // Unconditional, and there is no COMMIT in this function. Keep it that way.
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // The two halves no transaction can reach.
  const fileNotes = [];
  const wsTar = path.join(snap.dir, 'workspace.tar.gz');
  if (fs.existsSync(wsTar)) {
    const listed = execFileSync('tar', ['tzf', wsTar], { encoding: 'utf8' }).trim().split('\n');
    const missing = ['AGENTS.md', '.olma-identity'].filter(
      (f) => !listed.some((l) => l.endsWith('/' + f)));
    if (missing.length) problems.push(`workspace tar is missing ${missing.join(', ')}`);
    fileNotes.push(`workspace tar: ${listed.length} entries, readable, `
      + `${missing.length ? 'INCOMPLETE' : 'has AGENTS.md + .olma-identity'}`);
  } else problems.push('no workspace tar in the snapshot');

  const slice = JSON.parse(fs.readFileSync(path.join(snap.dir, 'openclaw.json'), 'utf8'));
  if (!slice.agent) problems.push('config slice has no agent entry — restore could not rebuild routing');
  else fileNotes.push(`config slice: agent ${snap.meta.agentId} -> ${slice.agent.workspace || '(no workspace)'}, `
    + `${slice.bindings.length} binding(s), allowFrom=${slice.allowFrom}`);

  const agentDir = path.join(process.env.OLMA_OPENCLAW_HOME || '/root/.openclaw', 'agents', snap.meta.agentId);
  const live = dirStat(agentDir);
  if (!live && !snap.meta.agentDirSnapshot) problems.push(`transcripts for ${snap.meta.agentId} are gone and were not tarred`);
  else fileNotes.push(`transcripts: ${live ? `${live.files} files on disk (a reset does not touch them)` : 'from tar'}`);

  for (const n of fileNotes) console.log(`${n}`);

  if (problems.length) {
    console.log('\nREHEARSAL FAILED — a reset would NOT be fully undoable right now:');
    for (const p of problems) console.log(`  ! ${p}`);
    process.exitCode = 1;
  } else {
    console.log(`\nREHEARSAL PASSED — ${rowsChecked} rows across ${data.closure.length} tables were deleted `
      + 'and came back identical, then the whole transaction was rolled back.');
    console.log('Proved: the database half end to end, and that the workspace tar and config slice '
      + 'contain what a restore needs. Not proved by this command: the untar and the gateway '
      + 'config write themselves (covered by the test suite).');
  }
}

// -------------------------------------------------------------- commands

async function cmdSnapshot(pool, phone, { label, includeAgentDir }) {
  const client = await pool.connect();
  let user;
  try {
    const pv = await previewDeletion(client, phone);
    if (!pv.ok) { console.error(`no user with phone ${phone}`); process.exitCode = 1; return; }
    user = pv.data.user;
  } finally { client.release(); }

  const obs = await observeDeletion(pool, user.id);
  const name = `${stampNow()}${label ? `--${label.replace(/[^\w.-]/g, '-')}` : ''}`;
  const dir = snapDirFor(phone, name);
  fs.mkdirSync(dir, { recursive: true });

  const counts = Object.fromEntries(
    Object.entries(obs.removed).map(([t, r]) => [t, r.length]));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({
    userId: user.id, phone, removed: obs.removed, nulled: obs.nulled,
    edges: obs.edges, pk: obs.pk, closure: obs.closure,
  }, null, 1), { mode: 0o600 });

  const wsTar = user.workspace_path
    ? tarDir(user.workspace_path, path.join(dir, 'workspace.tar.gz')) : null;
  const agentDir = path.join(process.env.OLMA_OPENCLAW_HOME || '/root/.openclaw', 'agents', user.agent_id);
  const agentTar = includeAgentDir ? tarDir(agentDir, path.join(dir, 'agent-dir.tar.gz')) : null;

  const cfg = configSlice(user.agent_id, phone, process.env.OLMA_OPENCLAW_CONFIG);
  fs.writeFileSync(path.join(dir, 'openclaw.json'), JSON.stringify(cfg, null, 1), { mode: 0o600 });

  const meta = {
    label: label || null, phone, userId: user.id, agentId: user.agent_id,
    workspacePath: user.workspace_path, takenAt: new Date().toISOString(),
    release: (() => { try { return JSON.parse(fs.readFileSync('/opt/olma2/RELEASE', 'utf8')); } catch { return null; } })(),
    rowCounts: counts, rowsTotal: total,
    nulledCounts: Object.fromEntries(Object.entries(obs.nulled).map(([t, r]) => [t, r.length])),
    workspace: wsTar, agentDirSnapshot: agentTar, agentDirOnDisk: dirStat(agentDir),
    config: { agentPresent: !!cfg.agent, bindings: cfg.bindings.length, allowFrom: cfg.allowFrom },
  };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 1), { mode: 0o600 });

  console.log(`snapshot ${name}`);
  console.log(`  user ${user.id} (${user.first_name || '?'}) agent=${user.agent_id}`);
  console.log(`  ${total} rows across ${Object.keys(counts).length} tables:`);
  for (const [t, c] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`      ${String(c).padStart(5)}  ${t}`);
  if (meta.rowsTotal && Object.keys(meta.nulledCounts).length) {
    console.log(`  pointers that would be nulled: ${JSON.stringify(meta.nulledCounts)}`);
  }
  console.log(`  workspace: ${wsTar ? `${Math.round(wsTar.bytes / 1024)}KB` : 'MISSING'}`);
  console.log(`  agent dir (not deleted by reset): ${meta.agentDirOnDisk
    ? `${meta.agentDirOnDisk.files} files, ${Math.round(meta.agentDirOnDisk.bytes / 1048576)}MB${agentTar ? ' (also tarred)' : ''}`
    : 'MISSING'}`);
  console.log(`  config: agent=${!!cfg.agent} bindings=${cfg.bindings.length} allowFrom=${cfg.allowFrom}`);
  console.log(`  -> ${dir}`);
  return dir;
}

function cmdList(phone) {
  const all = listSnapshots(phone);
  if (!all.length) { console.log('no snapshots'); return; }
  for (const s of all) {
    console.log(`${s.name}`);
    console.log(`  phone=${s.meta.phone} user=${s.meta.userId} agent=${s.meta.agentId} `
      + `rows=${s.meta.rowsTotal} taken=${s.meta.takenAt}`);
  }
}

// A snapshot you have not checked is a promise, not a backup.
function cmdVerify(phone, ref) {
  const snap = resolveSnapshot(phone, ref);
  if (!snap) { console.error('no such snapshot'); process.exitCode = 1; return null; }
  const problems = [];
  const db = path.join(snap.dir, 'db.json');
  if (!fs.existsSync(db)) problems.push('db.json missing');
  else {
    const parsed = JSON.parse(fs.readFileSync(db, 'utf8'));
    if (!parsed.removed || !parsed.removed.users || parsed.removed.users.length !== 1) {
      problems.push('db.json does not contain exactly one users row');
    }
    const n = Object.values(parsed.removed).reduce((a, r) => a + r.length, 0);
    if (n !== snap.meta.rowsTotal) problems.push(`row count drift: meta says ${snap.meta.rowsTotal}, db.json has ${n}`);
  }
  if (!fs.existsSync(path.join(snap.dir, 'openclaw.json'))) problems.push('openclaw.json slice missing');
  if (snap.meta.workspace && !fs.existsSync(path.join(snap.dir, 'workspace.tar.gz'))) {
    problems.push('workspace.tar.gz missing');
  }
  if (!snap.meta.config.agentPresent) problems.push('snapshot captured no agent entry — restore could not rebuild routing');
  const live = dirStat(path.join(process.env.OLMA_OPENCLAW_HOME || '/root/.openclaw', 'agents', snap.meta.agentId));
  if (!live && !snap.meta.agentDirSnapshot) {
    problems.push(`agent dir for ${snap.meta.agentId} is gone from disk and was not tarred — transcripts are unrecoverable`);
  }
  console.log(`${snap.name}: ${problems.length ? 'PROBLEMS' : 'ok'}`);
  console.log(`  rows=${snap.meta.rowsTotal} workspace=${snap.meta.workspace ? 'yes' : 'no'} `
    + `agentDirOnDisk=${live ? `${live.files} files` : 'MISSING'}`);
  for (const p of problems) console.log(`  ! ${p}`);
  if (problems.length) process.exitCode = 1;
  return problems.length ? null : snap;
}

async function cmdReset(pool, phone, ref, apply) {
  const snap = cmdVerify(phone, ref);
  if (!snap) { console.error('\nrefusing to reset without a verified snapshot'); process.exitCode = 1; return; }
  if (snap.meta.phone !== phone) { console.error('snapshot is for a different phone'); process.exitCode = 1; return; }

  const client = await pool.connect();
  try {
    const pv = await previewDeletion(client, phone);
    if (!pv.ok) { console.log(`\n${phone} already has no user — nothing to reset.`); return; }
    console.log(`\nwill delete user ${pv.data.user.id} (${pv.data.user.first_name || '?'}), `
      + `agent ${pv.data.user.agent_id}, and its workspace.`);
    console.log(`cascades: ${JSON.stringify(pv.data.counts)}`);
    console.log(`transcripts under agents/${pv.data.user.agent_id}/ are NOT deleted and come back with the agent id.`);
    if (!apply) { console.log('\ndry run — pass --apply to reset'); return; }

    await client.query('BEGIN');
    const res = await deprovisionUser(client, phone);
    if (!res.ok) { await client.query('ROLLBACK'); console.error(res.error); process.exitCode = 1; return; }
    await client.query('COMMIT');
    console.log(`\nreset. config: ${JSON.stringify(res.data.config)} workspace removed: ${res.data.workspaceRemoved}`);
    console.log(`${phone} now has no binding — their next message lands on the intake catch-all, `
      + 'exactly like somebody who has never written before.');
  } finally { client.release(); }
}

async function cmdRestore(pool, phone, ref, apply) {
  const snap = cmdVerify(phone, ref);
  if (!snap) { console.error('\nrefusing to restore from an unverified snapshot'); process.exitCode = 1; return; }
  const data = JSON.parse(fs.readFileSync(path.join(snap.dir, 'db.json'), 'utf8'));

  const client = await pool.connect();
  try {
    const cur = await previewDeletion(client, phone);
    const stale = cur.ok && cur.data.user.id !== data.userId ? cur.data.user : null;
    if (cur.ok && !stale) console.log(`user ${data.userId} still exists — restore will fill in whatever is missing.`);
    if (stale) {
      console.log(`a test user (id ${stale.id}, agent ${stale.agent_id}) currently holds ${phone}; `
        + 'it will be deleted first.');
    }
    const tables = Object.keys(data.removed);
    const plan = insertPlan(tables, data.edges, data.pk);
    console.log(`\nwill restore ${Object.values(data.removed).reduce((a, r) => a + r.length, 0)} rows `
      + `into ${tables.length} tables, workspace, agent + binding.`);
    if (plan.deferred.length) {
      console.log(`  cycle-breaking columns filled in second pass: `
        + plan.deferred.map((d) => `${d.child}.${d.col}`).join(', '));
    }
    if (!apply) { console.log('\ndry run — pass --apply to restore'); return; }

    if (stale) {
      await client.query('BEGIN');
      const del = await deprovisionUser(client, phone);
      if (!del.ok) { await client.query('ROLLBACK'); console.error(del.error); process.exitCode = 1; return; }
      await client.query('COMMIT');
      console.log(`removed test user ${stale.id}.`);
    }

    await client.query('BEGIN');
    let res;
    try {
      res = await restoreRowsInto(client, data);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    }

    console.log(`\nDB: ${JSON.stringify(res.inserted)}`);
    console.log(`  deferred columns set: ${res.deferredSet}, pointers restored: ${res.repointed}`);
    console.log(`  sequences resynced: ${res.sequences.length}`);

    // Files and routing. A rollback cannot reach either of these, which is why
    // they happen after the DB is known good rather than beside it.
    const wsTar = path.join(snap.dir, 'workspace.tar.gz');
    if (fs.existsSync(wsTar) && snap.meta.workspacePath) {
      untarInto(wsTar, snap.meta.workspacePath);
      console.log(`workspace restored to ${snap.meta.workspacePath}`);
    } else console.log('workspace: nothing to restore');

    const agentTar = path.join(snap.dir, 'agent-dir.tar.gz');
    const agentDir = path.join(process.env.OLMA_OPENCLAW_HOME || '/root/.openclaw', 'agents', snap.meta.agentId);
    if (!fs.existsSync(agentDir) && fs.existsSync(agentTar)) {
      execFileSync('tar', ['xzf', agentTar, '-C', path.dirname(agentDir)]);
      console.log(`agent dir restored from tar`);
    } else {
      console.log(`agent dir: ${fs.existsSync(agentDir) ? 'still on disk (transcripts intact)' : 'MISSING and not tarred'}`);
    }

    // Agent and binding in ONE write, or the gateway drops a bindings-only
    // change on the floor and the phone keeps routing to intake.
    const slice = JSON.parse(fs.readFileSync(path.join(snap.dir, 'openclaw.json'), 'utf8'));
    const cfgPath = process.env.OLMA_OPENCLAW_CONFIG;
    const cfg = occ.loadConfig(cfgPath);
    let addedAgent = false;
    if (slice.agent && !occ.hasAgent(cfg, snap.meta.agentId)) {
      addedAgent = occ.addAgent(cfg, {
        id: snap.meta.agentId,
        workspace: slice.agent.workspace || snap.meta.workspacePath,
        agentDir: slice.agent.agentDir || path.join(agentDir, 'agent'),
      });
    }
    const addedBinding = occ.addBinding(cfg, { agentId: snap.meta.agentId, phone });
    if (slice.allowFrom) occ.addAllowFrom(cfg, phone);
    occ.saveConfig(cfg, cfgPath);
    console.log(`config: agent added=${addedAgent} binding added=${addedBinding}`);
    if (addedBinding && !addedAgent) {
      console.log('  ! bindings-only write — the gateway ignores those. Restart it:');
      console.log('    XDG_RUNTIME_DIR=/run/user/0 systemctl --user restart openclaw-gateway');
    }

    // Never restore a credential. The files are back, so the rotation has its
    // three places; a snapshot's token could be one that leaked and was
    // rotated away since (2026-09-05, issue 72).
    await client.query('BEGIN');
    let minted;
    try {
      minted = await remintAfterRestore(client, data.userId, { log: console.log, snapshot: snap.name });
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    }
    if (minted.ok) console.log(`identity token re-minted (${minted.data.oldFingerprint} → ${minted.data.newFingerprint}); their open session recovers on its first failed call.`);
    else {
      console.error(`! identity token NOT re-minted: ${minted.error.message}`);
      console.error('  the snapshot\'s token is live. If it was ever rotated, run scripts/rotate-identity-token.js now.');
      process.exitCode = 1;
    }

    await refreshUserCard(pool, data.userId);
    console.log('USER.md refreshed.');

    // Prove it rather than claim it: re-observe the delete and compare.
    const after = await observeDeletion(pool, data.userId);
    const want = Object.fromEntries(Object.entries(data.removed).map(([t, r]) => [t, r.length]));
    const got = Object.fromEntries(Object.entries(after.removed).map(([t, r]) => [t, r.length]));
    const drift = [...new Set([...Object.keys(want), ...Object.keys(got)])]
      .filter((t) => (want[t] || 0) !== (got[t] || 0))
      .map((t) => `${t}: had ${want[t] || 0}, now ${got[t] || 0}`);
    console.log(drift.length
      ? `\nVERIFY: differences vs the snapshot (rows added during the test show up here too):\n  ${drift.join('\n  ')}`
      : '\nVERIFY: the user\'s footprint matches the snapshot exactly.');
  } finally { client.release(); }
}

// ------------------------------------------------------------------- main

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = new Set(rest.filter((a) => a.startsWith('--')));
  const valueOf = (name) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const positional = rest.filter((a, i) => !a.startsWith('--')
    && !(i > 0 && ['--label', '--from'].includes(rest[i - 1])));
  // A target is either +E.164 or `id:<n>`. The id form exists so an operator
  // can drive this without their own phone number scrolling through a terminal
  // and into a transcript; everything downstream still works in phones.
  const target = positional[0];

  const pool0 = () => createPool();

  if (cmd === 'list' || cmd === 'verify') {
    let phone = target;
    if (/^id:\d+$/.test(target || '')) {
      const pool = pool0();
      try { phone = await phoneForId(pool, Number(target.slice(3))); } finally { await pool.end(); }
      if (!phone) { console.error(`no user with ${target}`); process.exitCode = 1; return; }
    }
    if (cmd === 'list') cmdList(phone);
    else cmdVerify(phone, valueOf('--from') || positional[1]);
    return;
  }

  if (!['snapshot', 'reset', 'restore', 'rehearse'].includes(cmd)) {
    // The usage block at the top of this file is the only copy of it; printing
    // it from there is how the two cannot drift apart.
    const header = fs.readFileSync(__filename, 'utf8').split('\n');
    const from = header.findIndex((l) => l.startsWith('//   node scripts/user-testbed.js'));
    const to = header.findIndex((l, i) => i > from && !l.startsWith('//'));
    console.log(header.slice(from, to).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exitCode = 1;
    return;
  }
  const pool = createPool();
  // `rehearse` hands the live pool back early (it works against a copy), and
  // pg throws if end() lands twice — so closing is idempotent here.
  let ended = false;
  const endPool = async () => { if (!ended) { ended = true; await pool.end(); } };
  let phone = target;
  try {
    if (/^id:\d+$/.test(target || '')) {
      phone = await phoneForId(pool, Number(target.slice(3)));
      if (!phone) { console.error(`no user with ${target}`); process.exitCode = 1; return; }
    }
    if (!/^\+\d{7,15}$/.test(phone || '')) {
      console.error('target must be +E.164 (e.g. +972500000000) or id:<n>');
      process.exitCode = 1;
      return;
    }
    if (cmd === 'snapshot') {
      await cmdSnapshot(pool, phone, { label: valueOf('--label'), includeAgentDir: flags.has('--include-agent-dir') });
    } else if (cmd === 'reset') {
      await cmdReset(pool, phone, valueOf('--from'), flags.has('--apply'));
    } else if (cmd === 'restore') {
      await cmdRestore(pool, phone, valueOf('--from'), flags.has('--apply'));
    } else {
      await cmdRehearse(pool, phone, valueOf('--from'));
    }
  } finally { await endPool(); }
}

if (require.main === module) {
  main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
}

module.exports = {
  cascadeClosure, setNullEdges, insertPlan, observeDeletion, configSlice,
  diffState, restoreRowsInto, remintAfterRestore,
};
