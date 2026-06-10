# @instrument-org/agent-hooks

Shared agent hook scripts for Instrument repos. Consumed by `internal`, `instrument`, and `skills` via GitHub dep.

## Usage

In `.claude/settings.json` and `.codex/hooks.json`, point hook commands at:

```
node "$(git rev-parse --show-toplevel)/node_modules/@instrument-org/agent-hooks/format.mjs"
```

## Updating

1. Edit `format.mjs`, push, tag
2. In each consuming repo: `pnpm update @instrument-org/agent-hooks`
3. Commit the lockfile bump
