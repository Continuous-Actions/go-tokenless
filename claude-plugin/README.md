# go-tokenless (Claude plugin)

Move npm publishing in GitHub Actions from a stored `NPM_TOKEN` to npm **trusted publishing** (OIDC). npm is retiring token publishing: from January 2027, a token can no longer publish on its own.

The plugin gives Claude an Agent Skill and an MCP server. Ask *"Move our npm publishing to trusted publishing"* and Claude:
- previews the exact workflow and `package.json` changes
- applies them on request
- tells you the remaining steps that need your npm login: the `npm trust github …` commands, and deleting the old secret

## What it runs and accesses

- **MCP server:** started with `npx -y go-tokenless@<pinned version> mcp`, the published [go-tokenless](https://www.npmjs.com/package/go-tokenless) npm package. Its source is at https://github.com/continuous-actions/go-tokenless.
- **Files:** it reads `.github/workflows/*.yml`, `package.json` files and scripts in the repository you point it at. The apply tool writes only to workflow and `package.json` files inside that repository, and never follows links out of it.
- **Network:** read-only `GET` requests to `https://registry.npmjs.org/<package>`, to check that each package already exists (the `offline` option turns this off). Nothing else is fetched or sent. There is no telemetry.
- **Never:** it doesn't run repository code, read secrets or environment tokens, change git state, or contact npm or GitHub on your behalf.

## Tools

- `plan_trusted_publishing`: read-only. Returns the plan, the diff, the trust commands and the next steps.
- `apply_trusted_publishing`: writes the planned file changes.

Full documentation: https://github.com/continuous-actions/go-tokenless#readme. License: MIT.
