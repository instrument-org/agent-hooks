# Format hook

`format.mjs` is a single executable that every consuming repo wires into its
agent runtime. It reads one JSON payload on stdin, does its work, and writes one
JSON object on stdout. It never exits non-zero: a hook that fails loudly on an
unrelated problem would block every turn, so all errors are caught, logged to
stderr, and swallowed.

## Why it exists

The repos enforce a set of pedantic-but-mechanical rules: import and object key
ordering, Tailwind class order, formatting. An agent writing code cannot
reliably satisfy those while also solving the actual problem, and asking it to
would burn a fix-lint-fix cycle on every file. The hook applies them instead, so
the agent instruction can be "don't hand-format, expect files to change after
you write them" rather than "hand-sort everything correctly".

That instruction is only true because the hook runs. If the hook stops working,
the guidance in the consuming repos becomes actively wrong.

## Events

| Event                           | Source      | Work                                                    |
| ------------------------------- | ----------- | ------------------------------------------------------- |
| `PostToolUse` (`Edit`, `Write`) | Claude Code | oxfmt the one file, record it                           |
| `PostToolUse` (`apply_patch`)   | Codex       | oxfmt each patched file, record them                    |
| `afterFileEdit`                 | Cursor      | oxfmt the one file, record it                           |
| `Stop` / `stop`                 | all         | format + lint-fix the turn's edits, report what remains |

Cursor sends camelCase event names and Claude Code sends PascalCase;
`normalizeEventName` folds them together. The blocking report is gated on the
raw `hook_event_name === "Stop"` rather than the normalized value, because only
Claude Code honours the block contract.

## The session ledger

Every recorded edit is appended to `<tmp>/instrument-agent-hooks/<session>.txt`.
The ledger is the hook's answer to two problems:

**Parallel agents.** More than one agent may work in the same checkout. Acting
on the repo's dirty set would mean rewriting files another agent is midway
through editing. Everything at `Stop` is therefore scoped to what _this_ session
edited.

**Repeated work.** `Stop` consumes the ledger by renaming it aside before
reading, so each turn end processes only the edits made since the previous one
instead of replaying the whole session. Edits arriving while a turn runs land in
a fresh file and are picked up next time.

Files older than a week are pruned on each `Stop`.

## Pipeline order

At `Stop`, for the files this turn edited:

1. `oxfmt` over everything formattable
2. `oxlint --fix` over the lintable subset
3. `eslint --fix` (plus `--max-warnings=0` when reporting) over the same subset
4. `oxfmt` again, but only over files a fixer actually rewrote

The order matters. oxlint runs before ESLint so the report reflects content
oxlint has already fixed. The trailing oxfmt exists because lint fixes change
layout, and it is filtered by an mtime comparison so an unchanged file does not
pay for a second pass.

ESLint fixes and reports in one spawn. Type-aware rules moved to oxlint, so
ESLint no longer builds a TypeScript program and each package's real config is
cheap enough to autofix with. Running the real config also means what `--fix`
leaves behind is exactly what `check:lint` would report, with no second pass and
no divergence between the two.

## Which files get formatted when

`OXFMT_EXT` is everything oxfmt handles. `IMMEDIATE_FORMAT_EXT` is the subset
formatted the moment it is written, and it deliberately excludes prose and
stylesheets: a turn often makes several edits to one document against remembered
content, and reformatting between them invalidates the text the next edit is
anchored to. Those file types wait for `Stop`. Code earns the immediate pass
because the lint fixes at `Stop` build on already-formatted input.

`registry/` and `node_modules/` are skipped everywhere.

## Process pool

Cost is dominated by process spawns, not by linting. ESLint flat config does not
cascade, so each directory with its own `eslint.config.*` needs its own spawn
with that directory as cwd. Those spawns, and the batches within them, are
dispatched concurrently through a pool bounded at `min(8, cores)`. The pool is
the only place concurrency is limited, so callers can use `Promise.all` freely.

Batches are capped at 40 files to keep argv under `ARG_MAX`.

## Multi-root workspaces

`getStopRoots` resolves the roots to act on. When a workspace has several, only
the alphabetically-first root's session does the work, so parallel sessions do
not each repeat it. A root only qualifies if its `package.json` name is one of
the known Instrument roots and it has a `.git` entry.

## Verifying changes

`scripts/smoke.mjs` asserts the behaviours above against a real consuming repo.
`scripts/bench.mjs` measures turn cost and can compare against any git ref. Both
confine their fixtures to a temp directory inside the target repo and remove
them on exit. See `docs/findings/hook-performance.md` before trusting any
timing you take by hand.
