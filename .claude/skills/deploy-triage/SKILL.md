---
name: deploy-triage
description: "Answer the question 'I merged, did it actually ship?' for this repo. Runs the deploy checks in the order the rules require and names which failure shape it is, with the recovery command for that shape. Use after any merge to main, when a CI run looks red or cancelled, when the box seems behind, or before assuming a deploy finished."
---

<!-- Frontmatter is deliberately just name + description. Those two are the
     only keys proved to work on this machine (~/.claude/skills/graphify uses
     exactly them and is live). The docs also list argument-hint, allowed-tools
     and others, but an unknown key that makes a skill silently fail to load is
     the same failure shape this repo keeps paying for, and the only thing they
     would buy here is one fewer permission prompt. -->

# Did it ship?

Merging is deploying in this repo, and a deploy fails in shapes that look alike
from the outside and take **opposite actions**. Work them out in a fixed order
rather than stopping at the first green thing.

## Run this first

```bash
node .claude/scripts/deploy-triage.js            # HEAD
node .claude/scripts/deploy-triage.js <sha>      # a specific commit
node .claude/scripts/deploy-triage.js <PR#>      # a merged PR, by number
```

It is read-only, and every verdict it can reach is in the table below —
`--self-test` fails if this file stops naming one of them. It asks, in this
order and without stopping early:

1. is the commit on main at all?
2. does it touch anything CI watches — i.e. can it deploy at all?
3. did a workflow run get created for it?
4. what did that run do, and if red, was it a wedge?
5. what sha does `/opt/olma2/RELEASE` say the box is serving?
6. did the services restart after that, and is `/ready` 200?

Add `--no-box` to skip the SSH, `--json` for machine output. It exits non-zero
on any verdict that needs a person.

## Acting on the verdict

The script prints the recovery command and deliberately does **not** run it —
three of these take opposite actions and one of them redeploys production. Read
the verdict, then act:

| Verdict | What it means | What to do |
|---|---|---|
| `SHIPPED AND RUNNING` | the box serves a sha containing yours, units restarted after the marker, `/ready` 200 | nothing |
| `NOT A DEPLOYING CHANGE` | touches nothing under `olma2/**` | nothing — but note no suite ran either, and no checks looks exactly like green |
| `NOT ON MAIN` | a concurrent session merged at a head predating your commit | re-merge; there is no CI failure here |
| `THE MERGE THAT NEVER RAN` | zero check suites: main holds code the box has never seen | `gh workflow run olma2-tests.yml --ref main` — never a laptop `deploy.sh` |
| `A WEDGE, NOT A FAILURE` | `run-suite.sh` printed its banner | re-run once; a second wedge is a NEW hang to diagnose, not to bank |
| `A REAL FAILURE` | red with no banner | read the log and fix it; a re-run fails again |
| `DISPLACED, AND CARRIED ANYWAY` | queued run cancelled by a later merge, whose deploy rsynced your commit too | nothing |
| `CANCELLED, AND NOT SHIPPED` | cancelled, and the box does not have it | re-run the workflow on main |
| `A MIXED BOX` | marker names your sha but the units came up before it | new code and **applied migrations** on disk, old code in memory; check which files moved before anything else |
| `MERGED BUT NOT ON THE BOX` | green CI, box behind | this is what the hourly `deploy_drift` row reports |
| `SHIPPED, BUT /ready IS NOT 200` | box has your sha, the live process is not answering | read the units and the journal first; CI passing never proved the process came up |
| `STILL RUNNING` | the run is queued or in progress | nothing is wrong and nothing has shipped; `gh run watch <id>` |
| `NOT MERGED` | the PR number you gave has no merge commit | nothing to triage yet |
| `GREEN IN CI, BOX NOT CHECKED` | every job passed, `--no-box` was used | re-run without `--no-box`; CI green is not an answer about production |
| `GREEN IN CI, BOX UNREADABLE` | jobs passed, the box could not be reached | not evidence of trouble and not evidence of health — say which |
| `UNDETERMINED, BOX NOT CHECKED` | run ended non-success with no job having run, `--no-box` was used | only the box separates a displaced queue entry from a deploy that never happened |
| `UNKNOWN` | a revision, PR or API call could not be read | a thing that could not be READ is never a thing in trouble — say so, do not guess |

## Two things not to do

- **Do not read a conclusion string as an answer.** A dead run arrives as
  `cancelled` (job timeout) and as `failure` (`run-suite.sh` out of retries),
  and a benign displaced run arrives as `cancelled` too.
- **Do not trust timestamps in either direction.** On a healthy deploy the
  marker leads the restart by up to ~14 minutes, which is the identical
  signature to a deploy that died before restarting.

The full reasoning is in `.claude/rules/deploying.md`, and the stories are in
`olma2/docs/incidents.md`. This skill is the order to ask them in, not a
replacement for them.
