# Olma 2.0

Ground-up rebuild of the Olma service layer. Design doc: the "Olma 2.0 Proposal"
artifact (see CLAUDE.md at repo root for context and server details).

## Layout

| Path | What |
|---|---|
| `migrations/` | Numbered SQL migrations — the only source of truth for schema |
| `src/db/` | Migration runner, pg pool + `withTx` |
| `src/domain/` | Pure business modules; structured results (`{ok, data}` / `{ok, error}`), no user-facing prose, no message I/O |
| `src/adapters/mcp/` | Renders domain results as text for the agent (Phase C) |
| `src/adapters/http/` | Admin + user dashboards over the same domain (Phase F) |
| `src/outbox/` | Respectful-delivery worker (Phase D) |
| `src/jobs/` | checkin ladder, digest, usage, metrics (Phase D+) |
| `src/evals/` | nightly behavioral evals: scenario suite + harness (see jobs/evals.js) |
| `bin/olma-brokerd.js` | Long-lived daemon: pool, flood counters, outbox worker (Phase C) |
| `bin/olma-mcp.js` | Thin stdio shim → brokerd unix socket (Phase C) |
| `tests/` | `node --test`; each file builds a throwaway DB via the real migrations |

## Workflow

Source of truth is this directory in the local git repo. Deploy + test on the
server (Postgres 16 lives there):

```bash
bash olma2/scripts/deploy.sh
```

Every deploy archives the release it replaces to `/opt/olma2-releases/` and
keeps the newest 5. To go back to one:

```bash
bash olma2/scripts/rollback.sh --list
```

`--to <stamp>` then describes the rollback and `--to <stamp> --yes` performs
it. Code only — a migration that ran stays applied.

Rules: never edit an applied migration — add a new one. Domain functions take a
pg client as first arg and never accept a caller-supplied user id as identity;
identity comes only from `users.resolveByToken`.

## Feeling the onboarding on a real account

`scripts/user-testbed.js` takes an existing user back to their very first
message and puts them back afterwards. The reset is the *real*
`deprovisionUser` — a genuine new user has no DB row and no binding, so their
first message lands on the intake catch-all, and only actually being in that
state tests the path we care about.

```bash
node scripts/user-testbed.js snapshot id:3 --label before-v3
node scripts/user-testbed.js rehearse id:3
node scripts/user-testbed.js reset    id:3 --from before-v3 --apply
# …test the cold start on WhatsApp, then:
node scripts/user-testbed.js restore  id:3 --from before-v3 --apply
```

**Run `rehearse` before every reset.** It deletes the user for real against the
live rows, restores from the snapshot, compares every row in the cascade
closure, and rolls the whole transaction back — so the promise "this is
undoable" is checked against today's data instead of assumed. It has already
paid for itself once, catching a `jsonb`-array encoding bug that would have
failed a restore halfway through.

The snapshot captures what Postgres actually cascades, observed by running the
DELETE in a rolled-back transaction rather than modelled by hand — so a table
added by a future migration is covered on the day it lands. It reaches other
people's rows too (the far side of a connection dies with the user), which is
why the snapshot is of the cascade and not of "rows that look like this user's".

Two things it cannot undo, both reported rather than assumed: the person's own
WhatsApp thread, which lives on their phone, and anything the gateway does to
`agents/u-<id>/` — those transcripts survive a reset on their own, and
`--include-agent-dir` tars them if you want the belt as well as the braces.
