# Privacy

go-tokenless (the CLI, the MCP server, the Agent Skill and the Claude and Gemini plugins) collects no personal data and has no telemetry.

- **Local:** it runs entirely on your machine, reads files in the repository you point it at, and writes only to that repository's workflow and `package.json` files when you run `apply`.
- **Network:** the only requests it makes are read-only `GET` requests to `https://registry.npmjs.org/<package>`, to check that each package exists. Turn them off with `--offline` (MCP: `offline: true`). These requests carry no repository contents or credentials.
- **Never accessed:** your secrets, tokens, npm account or GitHub account.
- **Third parties:** npm's own privacy policy covers requests to the npm registry.

Questions: open an issue at https://github.com/continuous-actions/go-tokenless/issues.
