# agent-wire

- Zero runtime dependencies: `src/` and `bin/` import only `node:` builtins (MCP stdio and Slack Web API are
  hand-written). Do not add a package to do what they already do.
- Verify a change with `npm test` (`node --test "test/*.test.mjs"`, no network). Where `node` is a bun shim, run
  `/usr/bin/node --test "test/*.test.mjs"` instead; bun prints its help and runs nothing.
- `bench/` and `tools/` are not shipped (`files` in `package.json`); `tools/who-updated.mjs` hits the real Slack
  workspace with the local config.
