# Changelog

## Unreleased

- GitHub Action (`uses: continuous-actions/go-tokenless@v1`): check mode fails CI when npm publishing still relies on a stored token, with annotations and a job summary listing the fixes; `mode: report` only annotates.

## 1.0.0

First stable release. The CLI options, exit codes, `--json` plan shape and MCP tool inputs will not change incompatibly within 1.x.

- Full GitHub `repository` URLs are left as they are; only shorthands and missing fields are rewritten.
- Releases attach the npm tarball with a signed SLSA provenance attestation. CodeQL, Dependabot and fast-check fuzzing were added.

### Security

- **Untrusted triggers are blocked.** A publish job in a workflow started by `pull_request_target`, `issue_comment`, `workflow_run` or similar is never given `id-token: write` or a trust command.
- **Dry runs don't count as publishing.** Neither does `npm publish --dry-run` or an `echo` line.
- **Edits are checked by meaning.** Each edit is compared before and after with aliases resolved, and nothing is written if anything other than the migration would change. Workflows with YAML anchors are reported, not edited.
- **`blocked` writes nothing.** Files are only read and written if they are regular files inside the repo: no `..` workspace globs, no symlinks.
- **No injection:**
  - trust commands shell-quote every value
  - invalid npm package names are refused
  - `--npm-version` takes only a version or a `^`/`~` range
  - `--npm-args` takes only npm flags
  - `repo` is validated for the MCP server too
  - terminal control characters are stripped from output
- **Token detection:**
  - catches `secrets['X']`, `format(...)` and `YARN_NPM_AUTH_TOKEN`
  - catches tokens passed to other steps of the publish job
  - catches `npmAuthToken` written to `.yarnrc.yml`
  - never reports "already tokenless" while one remains
- **Registry check:** lookalike registry hosts (`registry.npmjs.org.evil.example`) are treated as other registries.
- **Permissions:**
  - `read-all` stays read-only
  - jobs that create GitHub releases or push tags keep `contents: write`
  - an inserted `actions/setup-node` is SHA-pinned when the job pins its actions
- **`--read-token` set to the current publish secret** is flagged, with a rotate-and-revoke step.

### Detection

- **Publishes inside other files:** follows `./scripts/*.sh`, `make <target>` and local composite actions.
- **More ways to run the tools:**
  - `npx semantic-release@x`, `pnpm semantic-release` and `node_modules/.bin/...`
  - `pnpm --filter=x publish`
  - `changesets/action/publish`
  - release-it actions
- **`working-directory`** is used to find scripts and to pick the package for each trust command.
- **Reusable workflows:** a trust command is printed for every caller.
- **Already on OIDC:** jobs with `id-token: write` and no token are left alone, with no setup churn. `changesets/action` is no longer bumped to v2.
- **Hidden publish commands:** a workflow that passes an npm token but whose publish command can't be found is reported (`publish-not-found`) instead of "nothing to migrate".
- **GitHub Packages:** `GITHUB_TOKEN` values and GitHub Packages `.npmrc` lines are kept.
- **Unparsable workflows** are reported.
- **`package.json` edits** change only the `repository` text: key order, numbers and escapes are kept, and a BOM is handled.

### And more


- `--read-token <SECRET>` (MCP: `readToken`) gives install steps a read-only `NODE_AUTH_TOKEN` for private org packages; publish steps stay tokenless.
- README rewritten with a header image, badges, agent setup for Claude Code, Gemini CLI and MCP clients, and a troubleshooting table.
- Release workflow: a manual MCP Registry run is limited to `main` and checks the version is on npm. A test keeps `server.json`, the plugin and the Gemini manifest versions in step with `package.json`.
- OpenSSF Scorecard workflow.

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
