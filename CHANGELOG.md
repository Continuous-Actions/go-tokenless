# Changelog

## 0.1.0

- First release: `plan`, `apply` and `mcp` commands.
- Rewrites GitHub Actions workflows from npm tokens to trusted publishing: removes token env vars, `.npmrc` token lines and the `token` input; adds `id-token: write`; ensures npm 11.5.1+ and `registry-url`; updates changesets/action to v2 and JS-DevTools/npm-publish to v4.
- Fixes `repository.url` in `package.json` files (workspaces get `directory`).
- Prints `npm trust github` commands per package, flags packages not yet on npm, reusable workflows, self-hosted runners and tool versions that are too old.
- Agent Skill, `llms.txt` and an MCP server (`plan_trusted_publishing`, `apply_trusted_publishing`).
