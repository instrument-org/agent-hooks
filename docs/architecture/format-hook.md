# Format hook

`format.mjs` is a single executable that every consuming repo wires into its agent runtime. It reads one JSON payload on stdin, does its work, and writes one JSON object on stdout. It never exits non-zero: a hook that fails loudly on an unrelated problem would block every turn, so all errors are caught, logged to stderr, and swallowed.

## Why it exists

The repos enforce a few mechanical rules: formatting, Tailwind class order, and whatever else oxlint can autofix. An agent writing code cannot reliably satisfy those while also solving the actual problem, and asking it to would burn a fix-lint-fix cycle on every file. The hook applies them instead, so the agent instruction can be "don't hand-format, expect files to change after you write them". What it cannot fix it hands back in the same turn, so the agent never has to run lint by hand to find it.

That instruction is only true because the hook runs. If the hook stops working, the guidance in the consuming repos becomes actively wrong.

## Events

| Event                           | Source      | Work                                                                               |
| ------------------------------- | ----------- | ---------------------------------------------------------------------------------- |
| `PostToolUse` (`Edit`, `Write`) | Claude Code | oxfmt the one file, record it                                                      |
| `PreToolUse` (`Bash`)           | Claude Code | note the checkout's dirty files and their mtimes                                   |
| `PostToolUse` (`Bash`)          | Claude Code | oxfmt and record each dirty file the command changed                               |
| `PostToolUse` (`apply_patch`)   | Codex       | oxfmt each patched file, record them                                               |
| `afterFileEdit`                 | Cursor      | oxfmt the one file, record it                                                      |
| `Stop` / `stop`                 | all         | format + lint-fix the turn's edits, report what remains, what knip finds unused, and related tests that fail |

Cursor sends camelCase event names and Claude Code sends PascalCase; `normalizeEventName` folds them together. The blocking report is gated on the raw `hook_event_name === "Stop"` rather than the normalized value, because only Claude Code honours the block contract.

## The session ledger

Every recorded edit is appended to `<tmp>/instrument-agent-hooks/<session>.txt`. The ledger is the hook's answer to two problems:

**Parallel agents.** More than one agent may work in the same checkout. Acting on the repo's dirty set would mean rewriting files another agent is midway through editing. Everything at `Stop` is therefore scoped to what _this_ session edited.

**Repeated work.** `Stop` consumes the ledger by renaming it aside before reading, so each turn end processes only the edits made since the previous one instead of replaying the whole session. Edits arriving while a turn runs land in a fresh file and are picked up next time.

Files older than a week are pruned on each `Stop`.

## Shell edits

An agent writes files from Bash as well as through Edit and Write: a heredoc, `sed -i`, a script. Nothing in a Bash event names those files, and before this they reached neither the immediate format nor the Stop sweep. So `PreToolUse` on Bash notes every changed or untracked file in the session's checkout with its mtime (`git status`, about 25ms), and `PostToolUse` records each one whose mtime moved, or that became dirty, during the command, formatting it like an Edit. The two together add about 140ms to a Bash call, almost all of it Node starting twice.

The window is the command's own run, so a parallel agent writing in the same checkout during those seconds is attributed to this session, which the ledger otherwise avoids. A session working in a worktree of its own has no such neighbor. A command that writes in a checkout other than the session's is not seen.

## Pipeline order

At `Stop`, for the files this turn edited:

1. `typos --write-changes` over every edited file, whatever its type
2. `oxfmt` over everything formattable
3. `oxlint --fix` over the lintable subset, plus `--type-aware --quiet` when reporting
4. `oxfmt` again, but only over files a fixer actually rewrote
5. `knip`, when reporting and the turn edited code or a `package.json`
6. `vitest related`, when reporting, alongside knip

The order matters. typos runs first so everything after it formats corrected text. The trailing oxfmt exists because lint fixes change layout, and it is filtered by an mtime comparison so an unchanged file does not pay for a second pass.

The spelling pass goes through the consuming repo's own `scripts/typos.ts`, which vendors the pinned checksum-verified binary, so a repo without that script skips the pass. It passes `--force-exclude`, without which typos would ignore `typos.toml`'s `extend-exclude` for the paths handed to it: the files excluded there are excluded because their misspellings are the content, and correcting one erases what it documents.

oxlint fixes and reports in one spawn from the repo root, where it resolves each file's nearest `.oxlintrc.json`, so a turn that touched three packages still costs one process. What `--fix` leaves behind is exactly what `check:lint` would report. The report includes type-aware rules, which cost about 1.5s for a turn's worth of files, and leaves out warnings, which are advice rather than something to block a turn on. `--no-error-on-unmatched-pattern` keeps a batch made only of ignored files quiet instead of reporting "no files found" as a problem.

knip runs last because a lint fix can be what leaves something unused: dropping an unused import can orphan the export it named. It analyzes the whole project, about 1.4s in the monorepo, and the hook keeps two kinds of finding: anything in a file the turn edited, and dependency findings in the `package.json` of any workspace the turn edited a file in. The second is wider than the ledger because a dependency goes unused when its last import is deleted somewhere else, and is added by `pnpm add`, neither of which reaches the manifest through a recorded edit. An export left unused in a file the turn never edited is not reported, since a parallel agent's half-finished work produces exactly that; CI's `check:unused` still catches it. knip exits non-zero whenever it finds anything, so only output that parses as its JSON report counts, and a config error or crash is dropped rather than handed to the agent. A repo without `node_modules/.bin/knip` skips the pass.

The tests that import the turn's code edits run last, beside knip, since both only read. Each edit runs in the package that owns it, and only when that package has its own `node_modules/.bin/vitest` and a `vitest.config.*`: a root that only hoists the binary would crawl every test in the tree without the aliases each package's config sets up. The projects named by `--project` in the package's `test:ci` are the ones run, so a browser project CI leaves out stays out. Packages run one at a time with `--maxWorkers=40%` and `CI=true`, matching CI, because other agents usually share the checkout. The whole pass shares a 60s deadline; a package still running at the deadline is killed and reports nothing, as does a run that leaves no JSON report. A typical studio edit pulls in 40 to 70 test files and adds about 10s to the turn. The report asks the agent to say so and move on when a failure comes from code it never touched, since that can be another agent's work in progress. A test in one package that imports a file from another is not found: the run is scoped to the edit's own package, and CI still catches it.

## Which files get formatted when

`OXFMT_EXT` is everything oxfmt handles. `IMMEDIATE_FORMAT_EXT` is the subset formatted the moment it is written, and it deliberately excludes prose and stylesheets: a turn often makes several edits to one document against remembered content, and reformatting between them invalidates the text the next edit is anchored to. Those file types wait for `Stop`. Code earns the immediate pass because the lint fixes at `Stop` build on already-formatted input.

`registry/` and `node_modules/` are skipped everywhere.

## Process pool

Cost is dominated by process spawns and, for the report, by tsgolint building each touched package's TypeScript program. Batches are dispatched concurrently through a pool bounded at `min(8, cores)`. The pool is the only place concurrency is limited, so callers can use `Promise.all` freely.

Batches are capped at 40 files to keep argv under `ARG_MAX`.

## Multi-root workspaces

`getStopRoots` decides whether this session's Stop runs at all. When a workspace has several roots, only the alphabetically-first root's session does the work, so parallel sessions do not each repeat it. A root only qualifies if its `package.json` name is one of the known Instrument roots and it has a `.git` entry.

## Checkout roots

Each edited file is formatted and linted from its own checkout, the nearest directory with a `.git` entry (`getCheckoutRoot`), not from the session's working directory. A linked worktree nested in a checkout (`.claude/worktrees/<name>`) is a checkout of its own, and its root `.oxlintrc.json` sets options only a root config may (`options.typeAware`). Run from the outer checkout, oxlint reads that file as a nested config and refuses it, so a session that edited a worktree and then left it before Stop got a config error back as lint to fix. The same resolution keeps the PostToolUse oxfmt pass on the edited file's own tools.

## Verifying changes

`scripts/smoke.mjs` asserts the behaviours above against a real consuming repo. `scripts/bench.mjs` measures turn cost and can compare against any git ref. Both confine their fixtures to a temp directory inside the target repo and remove them on exit. See `docs/findings/hook-performance.md` before trusting any timing you take by hand.
