# Where the format hook spends its time

Measured 2026-07-25 against the `instrument` monorepo, Apple silicon, warm
caches unless noted.

## The cost is process spawns, not linting

Per-spawn, single file:

| Pass                                    | Warm  | Cold    |
| --------------------------------------- | ----- | ------- |
| node startup                            | 60ms  |         |
| `oxfmt`                                 | 155ms |         |
| `oxlint --fix`                          | 514ms |         |
| `eslint --fix` (formatting-only config) | 766ms |         |
| `eslint` report (real config)           | 160ms | 1,600ms |

Linting a file is a rounding error next to starting the tool that lints it.
ESLint on ten files costs about the same as on one; going to thirty adds roughly
30ms per file on top of a fixed startup. So the lever is **spawn count**, not
file count, and the two ways to pull it are running fewer passes and running
independent ones concurrently.

Two consequences shaped the current design:

- Fixing and reporting with two different ESLint configs cost two spawns and two
  module graphs. Collapsing them into one `--fix --max-warnings=0` against the
  real config removed the larger half of a single-file turn. This is only safe
  because type-aware rules moved to oxlint, so ESLint no longer builds a
  TypeScript program and the real config is cheap enough to autofix with.
- ESLint flat config does not cascade, so a turn touching three packages needs
  three spawns. Sequential: 412ms. Concurrent: 162ms.

Turn-end cost, before and after those changes:

| Scenario                     | Before     | After |
| ---------------------------- | ---------- | ----- |
| 1 package edited             | 4.4s       | 2.0s  |
| 3 packages edited            | 6.3s       | 2.2s  |
| No new edits since last turn | full sweep | 75ms  |

## The cold cache is a factor of ten, and installs reset it

ESLint compiles each package's TypeScript flat config through jiti and caches
the result under `node_modules/.cache/jiti`. Cold, a single ESLint spawn costs
about 1.6s with **zero files linted**. Warm, the same spawn is about 160ms.

`pnpm install` wipes that cache, so the first turn after any install pays the
cold price in every package it touches. Seven config directories cold is on the
order of ten seconds, which is what the worst observed turn-end times were.

Warming the cache in the background at session start would move that cost off
the turn-end path. Not currently done: it needs a change in each consuming
repo's hook config rather than here.

## Three ways to measure this wrong

Every one of these produced a confidently wrong number during the work above.

**Cold caches.** The first measurement of the ESLint report pass was 1.7s and
looked like a fixed per-group cost worth redesigning around. It was a cold jiti
cache. Warm, it was 160ms, and the real problem was somewhere else entirely.
Always discard the first run, and report cold and warm separately.
`scripts/bench.mjs` does both.

**`execFile` has no `input` option.** That option only exists on the sync
variants. Async `execFile` ignores it silently and leaves stdin open, so the
hook waits forever on a stream that never ends and the run hangs with no output.
Drive stdin explicitly and set a timeout.

**Shell foot-guns when hand-rolling a harness.** zsh does not word-split
unquoted variables, so `for f in $FILES` iterates once over the whole string and
the fixture list silently becomes one nonexistent path, making the hook look
instantaneous because it did nothing. And `cd x && cmd` inside an `eval` leaks
the working directory into the next timed command, so later measurements run
from the wrong place and report near-zero. Use arrays and subshells, or use the
scripts in `scripts/`.

## What is not worth trying

**`eslint --cache`.** The original reason for dropping it from the consuming
repos (unsafe with type-aware rules, since a type edit leaves dependent files
stale) no longer applies now that ESLint is purely syntactic. It still would not
help: warm per-file lint is around 3ms, and the cost is spawn overhead, which
caching does not touch.

**Optimising the `PostToolUse` path.** It is one `oxfmt` on one file, about
234ms measured across roughly 2,000 real invocations, against a 60ms node
startup floor. There is nothing meaningful left without a persistent daemon.

## Is the hook worth its cost?

From 200 session transcripts spanning 31 projects over 8 days: roughly 2,000
silent formatting operations against 15 plausibly hook-caused edit retries out
of 2,214 `Edit`/`Write` calls, a 0.68% failure rate. The failures are the
`File has been modified` and `String to replace not found` families, where the
hook rewrote a file between an agent's read and its next edit. Three of the
seven `File has been modified` cases were markdown, which is why prose now waits
for `Stop` rather than reformatting on every edit.

The trade is heavily favourable and the residual cost is inherent to
formatting-on-write.
