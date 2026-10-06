<p align="center">
  <img src="https://raw.githubusercontent.com/Continuous-Actions/go-tokenless/main/docs/assets/header.png" alt="go-tokenless: removes NODE_AUTH_TOKEN from a release workflow and adds id-token: write" width="100%">
</p>

# go-tokenless

[![CI](https://github.com/Continuous-Actions/go-tokenless/actions/workflows/ci.yml/badge.svg)](https://github.com/Continuous-Actions/go-tokenless/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/go-tokenless?logo=npm)](https://www.npmjs.com/package/go-tokenless)
[![MCP Registry](https://img.shields.io/badge/MCP_Registry-go--tokenless-blue)](https://registry.modelcontextprotocol.io/v0/servers?search=go-tokenless)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/Continuous-Actions/go-tokenless/badge)](https://scorecard.dev/viewer/?uri=github.com/Continuous-Actions/go-tokenless)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

**Delete your `NPM_TOKEN`.** One command switches npm publishing in GitHub Actions to [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC). No long-lived token is stored anywhere, and every release gets a provenance badge.

> npm is retiring token publishing: from **January 2027** a token can no longer publish on its own ([npm docs](https://docs.npmjs.com/about-access-tokens/)).

## Quick start

From the root of the repository that publishes to npm:

```bash
npx go-tokenless          # 1. preview: lists every change and shows a diff, writes nothing
npx go-tokenless apply    # 2. edit the workflow and package.json files
```

Then follow the **Next** steps it prints: commit the change, connect the package to the workflow on npm, and delete the old secret. Needs Node 22.14+.

## What it changes

Only the lines that need to change are touched. Comments, quoting and layout are kept.

| Problem in your release workflow | What go-tokenless does |
|---|---|
| `NODE_AUTH_TOKEN` / `NPM_TOKEN` on the publish step or job | Removes it. Any token, even an empty one, stops npm from using OIDC |
| Job can't request an OIDC token | Adds `permissions: id-token: write`, keeping the permissions it had |
| npm older than 11.5.1 (Node 22 and below) | Adds `npm install -g npm@^12`, or moves Node < 22 to 24 |
| `actions/setup-node` without `registry-url` | Adds `registry-url: https://registry.npmjs.org` |
| `changesets/action@v1`, `JS-DevTools/npm-publish@v3` | Updates them to versions that support trusted publishing |
| A script writes `_authToken` to `.npmrc` | Removes those lines |
| `repository` missing or in the wrong form in `package.json` | Sets `git+https://github.com/<owner>/<repo>.git` (with `directory` in monorepos) |

It stops with exit code `1` instead of guessing when trusted publishing can't work, such as on a self-hosted runner or when `repository` points at another repo. Jobs that publish to GitHub Packages are left alone.

<details>
<summary><b>Example output</b></summary>

```text
$ npx go-tokenless
go-tokenless: Ready to go tokenless. (acme/widgets)

Changes:
  .github/workflows/release.yml
    - publish: remove `NODE_AUTH_TOKEN` from job env
    - publish: grant `id-token: write`
    - publish: raise setup-node from Node 20 to 24 (trusted publishing needs Node 22.14+)
  package.json
    - widgets: add repository.url git+https://github.com/acme/widgets.git

Next:
  1. Run `npx go-tokenless apply` (or apply the diff above) and commit the changes on a branch.
  2. Add a trusted publisher for each package. With npm 11.15+ logged in with 2FA, run:
       npm trust github widgets --repo acme/widgets --file release.yml --allow-publish --yes
  3. Merge, then let the release workflow publish once. Check the new version shows a provenance badge.
  4. Delete the old publish token secret (`gh secret delete NPM_TOKEN`) and revoke the token on npmjs.com.
```

</details>

## Supported release setups

| Setup | Notes |
|---|---|
| `npm publish` (incl. workspaces) | |
| pnpm `publish` / `-r publish` | pnpm 10 hands off to npm; pnpm 11 needs 11.1.3+ |
| Yarn Berry `yarn npm publish` | Yarn 4.10.3+; remove `npmAuthToken` from `.yarnrc.yml` |
| changesets (`changesets/action`) | Updated to v2 |
| semantic-release | Needs @semantic-release/npm 13.1.0+ (semantic-release 25+) |
| release-please + `npm publish` | |
| Lerna / Nx release | Lerna 9+ |
| JS-DevTools/npm-publish | Updated to v4 |
| release-it | Also set `npm.skipChecks: true` |
| Reusable workflows (`workflow_call`) | npm checks the *calling* workflow's file name; the plan uses it |
| Yarn 1 `yarn publish`, `bun publish` | Flagged: those tools can't use trusted publishing yet, so switch to `npm publish` |

## Private packages

If your installs need private packages from your npm org, give the install steps a **read-only** token. Publish steps stay token-free:

```bash
npx go-tokenless apply --read-token NPM_READ_TOKEN
```

```diff
       - run: npm ci
+        env:
+          NODE_AUTH_TOKEN: ${{ secrets.NPM_READ_TOKEN }}
       - run: npm publish
```

Create a granular token on npmjs.com with read-only access to your packages and save it with `gh secret set NPM_READ_TOKEN`.

## Use it with AI agents

go-tokenless is built to be run by coding agents: `--json` output, clear exit codes, an MCP server and an Agent Skill. Ask your agent: *"Move our npm publishing to trusted publishing."*

| Client | Setup |
|---|---|
| Claude Code (plugin: skill + MCP) | `/plugin marketplace add Continuous-Actions/go-tokenless` then `/plugin install go-tokenless@continuous-actions` |
| Claude Code (MCP only) | `claude mcp add go-tokenless -- npx -y go-tokenless mcp` |
| Gemini CLI | `gemini extensions install https://github.com/Continuous-Actions/go-tokenless` |
| Cursor, VS Code, others | Add the MCP config below |
| Any agent with skills | `npx skills add Continuous-Actions/go-tokenless` |

```json
{ "mcpServers": { "go-tokenless": { "command": "npx", "args": ["-y", "go-tokenless", "mcp"] } } }
```

MCP tools: `plan_trusted_publishing` (read-only) and `apply_trusted_publishing` (writes files; no git or network writes). It is listed in the [MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=go-tokenless) as `io.github.Continuous-Actions/go-tokenless`. See also [llms.txt](llms.txt) and the [Agent Skill](skills/go-tokenless/SKILL.md).

## Options

```text
npx go-tokenless [plan | apply | mcp] [options]
```

| Option | Description |
|---|---|
| `--json` | Print the full plan as JSON (`status`, `changes`, `diff`, `findings`, `trust`, `nextSteps`) |
| `--diff` | Include the diff in text output (always on for `plan`) |
| `--repo <owner/repo>` | GitHub repository, when `origin` isn't GitHub |
| `--cwd <dir>` | Repository root (default: current directory) |
| `--offline` | Skip the npm registry check that each package already exists |
| `--read-token <SECRET>` | Give install steps a read-only token from this secret ([private packages](#private-packages)) |
| `--npm-version <range>` | npm for the inserted upgrade step. Default `^12`, pinned to one major so releases don't change under you. Other versions show a warning; below 11.5.1 is refused |
| `--npm-args "<args>"` | Extra arguments for every npm command it generates (upgrade step and `npm trust`) |

Exit codes: `0` ok · `1` blocked (needs a human fix) · `2` usage error · `3` unexpected error.

## What only you can do

go-tokenless never touches your npm account, secrets or git history. After `apply`:

1. **Connect each package to the workflow**: run the printed `npm trust github …` commands (npm 11.15+, asks for 2FA), or go to npmjs.com → package → **Settings → Trusted publishing**.
2. **New packages** must be published once by hand first; npm can only connect a package that exists. The plan flags these.
3. **Delete the old secret** and revoke the token after the first tokenless release.

## Troubleshooting

| Error | Usual cause |
|---|---|
| `npm error code ENEEDAUTH` | No `id-token: write`, npm older than 11.5.1, or the workflow file name doesn't match the trusted publisher exactly (case-sensitive, with `.yml`) |
| `npm error 404 Not Found - PUT https://registry.npmjs.org/...` | Same as above, an `environment` mismatch, or no trusted publisher yet |
| `npm error code E422` … `repository.url` | `package.json` `repository` doesn't match the GitHub repo. `apply` fixes the format |
| Publishing still uses the token | Something still sets `NODE_AUTH_TOKEN`, `NPM_TOKEN`, an `.npmrc` `_authToken` or `.yarnrc.yml` `npmAuthToken`. Run `npx go-tokenless` again to find it |

## Contributing

Issues and pull requests are welcome. Run `corepack enable && yarn install && yarn check` (typecheck, build and end-to-end tests). See [AGENTS.md](AGENTS.md) for how the code is laid out, and [SECURITY.md](SECURITY.md) to report a vulnerability.

## License

[MIT](LICENSE) © Continuous-Actions
