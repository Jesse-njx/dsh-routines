# dsh-routines

Scheduled agents for DSH — run a prompt on a cron, get the digest where you already are.

`dsh-routines` is a plugin bundle for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). A **routine** is a named prompt + schedule + delivery stored as a plain YAML file — human-diffable, git-committable. The scheduler launches each due run through the headless runner as its **own one-shot session** (full session log = full audit, replay-able later by dsh-replay), then delivers a digest: the last assistant message when it is short, otherwise a one-shot summarizer call over the session log.

```
┌──────────────────────┐   every night 02:00   ┌──────────────────────────────┐
│  dsh --profile ops   │ ─────────────────────▶ │ dsh --profile headless        │
│  scheduler tick      │   (own session, cwd   │  "run the test suite, ..."     │
│  reads .dsh/routines │    = routine cwd,     │  approval policy: never        │
│  /*.yaml             │    approval: never)   └──────────────┬───────────────┘
└──────────────────────┘                                      │ run record: status,
       │ digest + run record                                  │ digest, session id,
       ▼                                                      │ denied approvals
  .dsh/routines/runs/<runId>.json  (+ .md)  ──►  file delivery (always on)
  ctx.chatnode (optional)          ──►  chatnode delivery (soft dependency)
```

## Flagship demo — nightly test triage

A routine that runs your test suite at 2am, diagnoses the top failure, and leaves a digest in the project — then, with a conversation node installed, that digest lands in WeChat and you reply to approve follow-ups (v0.2; v0.1 delivers to file and chatnode when a node is installed).

```yaml
# ~/work/projectx/.dsh/routines/nightly-tests.yaml
name: nightly-tests
schedule: "0 2 * * *"        # 5-field cron; also accept "@daily", "every 4h"
timezone: Asia/Shanghai       # explicit, no silent host-tz default
prompt: |
  Run the test suite. If anything fails, diagnose the top failure
  and draft a fix on a branch. Summarize in <10 lines.
cwd: ~/work/projectx
profile: headless              # which DSH profile/plugin set the run uses
overlap: skip                  # skip | queue | cancel-previous
timeoutMin: 45
deliver:
  - type: file                 # always on: digest written under .dsh/routines/runs/
  - type: chatnode             # optional: any installed conversation node (wechat…)
```

```console
$ dsh --profile ops routines list
nightly-tests          active   0 2 * * *           tz=Asia/Shanghai next=2026-08-15T02:00:00.000Z
```

Next morning, the digest is waiting:

```console
$ dsh --profile ops routines logs nightly-tests --limit 3
[completed] 2026-08-14T18:00:01.000Z 41213 ms session=session-2f7d…
  tests: 3 failed of 412; top failure: flaky wait in auth.spec.ts — drafted fix on branch fix/auth-wait
```

## Install

```console
# 1. Create the profile that hosts the scheduler + CLI (installs this bundle).
#    From the npm registry once published, or straight from this repository:
dsh plugin --profile ops add @dsh-routines/bundle          # npm (when published)
dsh plugin --profile ops add github:Jesse-njx/dsh-routines  # or: straight from GitHub

# 2. Keep it alive so schedules fire (daemon mode; Ctrl-C to stop).
dsh --profile ops
```

Routine runs boot the `headless` profile by default, which ships with DSH — **no extra setup needed**. A routine that needs another profile's plugin set sets `profile: <name>`; that profile must be one-shot-capable (include the headless bundle, or install this bundle into it as well — the run overlay disables the nested scheduler either way).

### Scheduler host

The scheduler ticks inside whatever profile the bundle is installed into, so you can also add the bundle to your main `web` profile and routines fire while the web app runs:

```console
dsh plugin --profile web add @dsh-routines/bundle
```

Keep the process alive for schedules to fire; `dsh --profile ops` with no inner arguments is the intended daemon form (the CLI stays silent and the scheduler owns process lifetime).

## Routine files

Routines live in two watched directories (hot-reload on change; invalid files are reported, never crash the store):

| Directory | Scope |
| --- | --- |
| `<cwd>/.dsh/routines/*.yaml` | Project routines (override global on name) |
| `~/.dsh/routines/*.yaml` | Global routines |

| Field | Default | Meaning |
| --- | --- | --- |
| `name` | — (required) | `[a-z0-9][a-z0-9-]*`, ≤ 64 chars |
| `schedule` | — (required) | `0 2 * * *`, `@daily`, `@hourly`, `@weekly`, `@monthly`, `@yearly`, `every 4h`, `every 30m` |
| `timezone` | `UTC` | IANA zone for schedule math (never the host zone) |
| `prompt` | — (required) | The task the headless run executes |
| `cwd` | operator cwd | Working directory of the run; also where its digest lands |
| `profile` | `headless` | DSH profile the run boots |
| `overlap` | `skip` | `skip` (never stack two agents on one repo), `queue` (run after the current one), `cancel-previous` |
| `timeoutMin` | `45` | Hard stop; a wedged 2am agent must not still hold the repo at 9am |
| `deliver` | `[{type: file}]` | Digest delivery channels |

Cron fields support `*`, step suffixes (`*/15`), ranges (`9-17`), lists (`0,30`), `?`, and month/day names. When both day-of-month and day-of-week are restricted, a day matches if either matches (Vixie cron semantics).

Scheduler bookkeeping (paused set, last-run anchors) lives in `<cwd>/.dsh/routines/state.json`.

## CLI

`dsh --profile ops routines <command>`

| Command | Description |
| --- | --- |
| `list` | routines with schedule, pause state, next run |
| `run <name>` | manual trigger (runs now; prints the digest and exits) |
| `pause <name>` / `resume <name>` | stop / restart scheduled runs |
| `logs <name> [--limit n]` | recent run records: status, duration, digest, session id |

Run records are JSON files under `<routine.cwd>/.dsh/routines/runs/<runId>.json`, with a human-readable `<runId>.md` digest next to them. `run` is also the manual trigger for testing a routine before you trust its schedule.

## Safety defaults

Scheduled agents run unattended, so each run subprocess is patched to:

- **Auto-deny anything that would prompt** — the run overlay forces the approval policy to `never` (sandbox mode stays whatever the profile inherits, normally `workspace-write`). Denied requests are collected into the run record (`denied`) and surface in the digest.
- **Never schedule nested runs** — the run overlay disables the scheduler row inside the run profile.
- **Never crash the scheduler** — delivery failures, summarizer failures, and spawn failures are recorded on the run record, not thrown.

Missed runs (laptop asleep): at most one catch-up run fires on wake, never a backlog replay.

## Delivery

- **file** (always on): the run record + digest markdown under `.dsh/routines/runs/`.
- **chatnode** (optional): digests are sent through a `ctx.chatnode` service (`{ send(input: { text, title? }): Promise<void> }`) when one is installed; otherwise the delivery is recorded as `not-installed` and the run still completes. A future `@dsh-cowork/chatnode-wechat` exposing that service lights this up automatically.

## Architecture

One bundle, three plugins (+ a run driver), all installable as subpaths:

| Module | Role |
| --- | --- |
| `@dsh-routines/bundle/store` | watches `.dsh/routines/*.yaml` (project + global), validates, hot-reloads, owns durable state |
| `@dsh-routines/bundle/scheduler` | registers due routines on `ctx.jobs` (kind `routine`); owns overlap, missed-run, and timeout semantics |
| `@dsh-routines/bundle/cli` | the `dsh routines ...` command line |
| `@dsh-routines/bundle/run` | child-side driver injected into each one-shot run via a generated `--patch` overlay; writes the run record and digest |

Runs boot `dsh --profile <routine.profile> --patch <generated overlay> -- "<prompt>"` with the routine's cwd as the workspace. The overlay disables the stock headless runner, mounts the `run` driver on the same task service, and forces the unattended approval policy — so the run keeps the full headless experience (fresh persisted session, provider selection) while writing the audit record only dsh-routines knows how to read.

## Development

```console
pnpm install
pnpm build      # tsc -> lib/
pnpm test       # node --test (46 tests: cron, scheduler matrix, store, run, cli, e2e)
```

The e2e test boots a real `dsh` subprocess against a scripted mock LLM adapter (no network, no credentials) in a throwaway `DSH_HOME`, so the whole pipeline — store → scheduler → jobs → subprocess → run driver → digest → record — is exercised in CI.

## Non-goals

Cloud execution (local machine only; the missed-run policy handles an asleep laptop honestly), routine marketplaces, sub-minute schedules.

## License

MIT
