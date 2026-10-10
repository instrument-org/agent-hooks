# @instrument-org/agent-hooks

Shared agent hook scripts for Instrument repos, consumed via GitHub dep. `agent-reference.json` declares every consuming repo, so `agent-reference status` lists what a change here has to be rolled out to; add a repo there when it starts depending on this package.

## Usage

In `.claude/settings.json` and `.codex/hooks.json`, point hook commands at:

```
node "$(git rev-parse --show-toplevel)/node_modules/@instrument-org/agent-hooks/format.mjs"
```

## Updating

1. Edit `format.mjs`, verify with the scripts below, push, tag
2. In each consuming repo `agent-reference.json` lists: `pnpm update @instrument-org/agent-hooks`
3. Commit the lockfile bump

## Verifying a change

Both scripts run against a real consuming repo (one with `node_modules` installed) and confine their fixtures to a temp directory inside it, removed on exit. Neither touches anything else, which matters because a consuming repo usually has work in progress.

```sh
# 19 behavioural assertions: what formats when, what is left alone,
# the parallel-agent scoping guarantee, nested worktrees, blocking,
# and degenerate input
node scripts/smoke.mjs <path-to-consuming-repo>

# turn cost, cold and warm, optionally compared against any git ref
node scripts/bench.mjs <path-to-consuming-repo> --packages 3 --baseline HEAD~1
```

Read `docs/findings/hook-performance.md` before taking a timing by hand. A cold first run inflates results, and there are a few other traps that produce confidently wrong numbers.

## Docs

- `docs/architecture/format-hook.md` — events, the session ledger, pipeline order, and why each piece is shaped the way it is
- `docs/findings/hook-performance.md` — where the time goes, how to measure it, and what is not worth trying
