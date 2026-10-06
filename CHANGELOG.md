# Changelog

## Unreleased

- The inserted npm upgrade step is pinned to `npm@^12` (was `^11.5.1`).
- `--npm-version <range>` overrides it, with a warning; versions below 11.5.1 are refused.
- `--npm-args "<args>"` appends extra arguments to the npm upgrade step and the `npm trust` commands. Both options are also MCP tool inputs.
- Warns when a job pins a Node 22 release older than npm 12 supports.
- Fix: two lines inserted at the same spot could land in the wrong order.

## 0.1.0

- First release: `plan`, `apply` and `mcp` commands.
- Rewrites GitHub Actions workflows from npm tokens to trusted publishing: removes token env vars, `.npmrc` token lines and the `token` input; adds `id-token: write`; ensures npm 11.5.1+ and `registry-url`; updates changesets/action to v2 and JS-DevTools/npm-publish to v4.
- Fixes `repository.url` in `package.json` files (workspaces get `directory`).
- Prints `npm trust github` commands per package, flags packages not yet on npm, reusable workflows, self-hosted runners and tool versions that are too old.
- Agent Skill, `llms.txt` and an MCP server (`plan_trusted_publishing`, `apply_trusted_publishing`).
