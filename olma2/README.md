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
