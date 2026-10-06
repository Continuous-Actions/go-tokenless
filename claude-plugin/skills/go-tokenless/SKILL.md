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
   - `blocked`: `findings` with `level: "error"` must be fixed first. Examples: `untrusted-trigger` (publishing from pull_request_target/issue_comment/workflow_run), `self-hosted-runner`, `repository-mismatch`, `yaml-anchors`, `publish-not-found`. Nothing was written. Explain them to the user; never work around `untrusted-trigger` by granting `id-token: write` yourself.
2. **Apply:** `npx -y go-tokenless apply`. It edits only the needed lines in `.github/workflows/*.yml` and `package.json` files. Show the user the diff (`git diff`) and commit on a branch.
3. **Hand the user the remaining steps from `nextSteps` verbatim.** They need the user's npm account with 2FA, so never try to do them yourself:
   - run each `trust[].command` (`npm trust github <pkg> --repo <owner/repo> --file <workflow.yml> --allow-publish --yes`), or use npmjs.com → package → Settings → Trusted publishing;
   - packages with `published: false` must be published once by hand first;
   - after the first successful release, `gh secret delete <name>` for the secrets listed and revoke the token on npmjs.com.
4. Surface every `warning` finding to the user (for example tool versions that are too old, `bun publish`, or a reusable workflow whose caller needs `id-token: write`).

Rules:
- Don't leave or add `NODE_AUTH_TOKEN` on publish steps: npm falls back to a configured token, so the old token stays in use and can't be deleted.
- Trusted publishing works only on GitHub-hosted runners and needs npm 11.5.1+ (Node 24 ships it). The inserted upgrade step is pinned to `npm@^12`; only pass `--npm-version` if the user asks, and relay the warning it produces. Use `--npm-args "<args>"` for extra npm flags such as a registry mirror.
- If installs need private packages from the user's npm org, add `--read-token NPM_READ_TOKEN` (any secret name). Install steps get a read-only token; publish steps stay tokenless. Tell the user to create a read-only granular token and `gh secret set` it.
- An MCP server is available as `npx -y go-tokenless mcp` with tools `plan_trusted_publishing` and `apply_trusted_publishing` (argument `path`: absolute repo root).
