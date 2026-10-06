---
name: go-tokenless
description: Migrate npm publishing in GitHub Actions from NPM_TOKEN / NODE_AUTH_TOKEN secrets to npm trusted publishing (OIDC, provenance). Use when the user wants to remove or rotate an npm token, set up npm trusted publishing or OIDC, fix ENEEDAUTH / 404 / E422 errors from `npm publish` in CI, prepare for npm's January 2027 removal of token publishing, or asks to make releases more secure. Works with npm, pnpm, Yarn Berry, changesets, semantic-release, release-please, Lerna, Nx and JS-DevTools/npm-publish.
---

# Move npm publishing to trusted publishing with go-tokenless

1. **Plan (writes nothing):** run from the repository root:
   `npx -y go-tokenless --json`
   Read `status`:
   - `ready`: changes are listed in `changes` and `diff`.
   - `already-tokenless`: nothing to change; see `nextSteps`.
   - `no-publish-workflow`: no workflow publishes to npm. Stop.
   - `blocked`: `findings` with `level: "error"` must be fixed first (self-hosted runner, `repository` pointing at another repo). Explain them to the user; do not work around them.
2. **Apply:** `npx -y go-tokenless apply`. It edits only the needed lines in `.github/workflows/*.yml` and `package.json` files. Show the user the diff (`git diff`) and commit on a branch.
3. **Hand the user the remaining steps from `nextSteps` verbatim.** They need the user's npm account with 2FA, so never try to do them yourself:
   - run each `trust[].command` (`npm trust github <pkg> --repo <owner/repo> --file <workflow.yml> --allow-publish --yes`), or use npmjs.com → package → Settings → Trusted publishing;
   - packages with `published: false` must be published once by hand first;
   - after the first successful release, `gh secret delete <name>` for the secrets listed and revoke the token on npmjs.com.
4. Surface every `warning` finding to the user (for example tool versions that are too old, `bun publish`, or a reusable workflow whose caller needs `id-token: write`).

Rules:
- Don't hand-edit workflows to add `NODE_AUTH_TOKEN: ""` or similar: any token value, even empty, stops npm from using OIDC.
- Trusted publishing works only on GitHub-hosted runners and needs npm 11.5.1+ (Node 24 ships it).
- An MCP server is available as `npx -y go-tokenless mcp` with tools `plan_trusted_publishing` and `apply_trusted_publishing` (argument `path`: absolute repo root).
