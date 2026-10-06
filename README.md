# go-tokenless

**Delete your `NPM_TOKEN`.** One command switches your GitHub Actions release workflow to [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC), so no long-lived npm token has to be stored anywhere.

```bash
npx go-tokenless          # show what would change (writes nothing)
npx go-tokenless apply    # make the changes
```

npm is retiring direct publishing with tokens: from **January 2027** a granular token with "bypass 2FA" can no longer publish on its own ([npm docs](https://docs.npmjs.com/about-access-tokens/)). Trusted publishing is the replacement for CI. It also adds a provenance badge to every release.

## What it does

It reads your workflows and `package.json` files, then:

| Problem | Fix it makes |
|---|---|
| `NODE_AUTH_TOKEN` / `NPM_TOKEN` passed to the publish step or job | Removes it (a token, even an empty one, stops npm from using OIDC) |
| Job can't request an OIDC token | Adds `permissions: id-token: write` (keeping the permissions the job already had) |
| Node 22 or older ships npm < 11.5.1 | Adds an `npm install -g npm@^12` step (pinned to one major, see [npm version](#npm-version)), or moves Node < 22 to 24 |
| `actions/setup-node` without `registry-url` | Adds `registry-url: https://registry.npmjs.org` |
| `changesets/action@v1`, `JS-DevTools/npm-publish@v3` | Updates to the version that supports trusted publishing |
| Script writes `_authToken` into `.npmrc` | Removes those lines |
| `repository` missing or in the wrong form in `package.json` | Adds `git+https://github.com/<owner>/<repo>.git` (with `directory` in monorepos) |

It also prints the exact `npm trust github …` command for every package and the remaining manual steps.

It **refuses** (exit code 1) rather than guessing when trusted publishing can't work: self-hosted runners, or a `repository` field pointing at another repo. It leaves jobs that publish to GitHub Packages alone.

## Example

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
  4. Delete the old secret (`gh secret delete NPM_TOKEN`) and revoke the token on npmjs.com.
```

The default command also prints a unified diff. Your file's comments, quoting and layout are kept: only the lines that need to change are touched.

## Supported release setups

| Setup | Supported | Notes |
|---|---|---|
| `npm publish` (incl. workspaces) | ✓ | |
| pnpm `publish` / `-r publish` | ✓ | pnpm 10 hands off to npm; pnpm 11 needs 11.1.3+ |
| Yarn Berry `yarn npm publish` | ✓ | Yarn 4.10.3+; remove `npmAuthToken` from `.yarnrc.yml` |
| changesets (`changesets/action`) | ✓ | updated to v2 |
| semantic-release | ✓ | needs @semantic-release/npm 13.1.0+ (semantic-release 25+) |
| release-please + `npm publish` | ✓ | |
| Lerna / Nx release | ✓ | Lerna 9+ |
| JS-DevTools/npm-publish | ✓ | updated to v4 |
| release-it | ✓ | also set `npm.skipChecks: true` |
| Yarn 1 `yarn publish`, `bun publish` | warns | not supported by those tools yet; switch the command to `npm publish` |
| Reusable workflows (`workflow_call`) | ✓ | npm checks the *calling* workflow's file name; the plan uses it |

Version floors are checked against your `package.json` where possible.

## Things only you can do

The tool never touches your npm account. After applying:

1. **Add a trusted publisher** for each package: the printed `npm trust github …` commands (npm 11.15+, needs your 2FA), or npmjs.com → package → **Settings → Trusted publishing**.
2. **Brand-new packages** must be published once by hand first; npm can only attach a trusted publisher to a package that exists. The plan flags these.
3. **Delete the secret** and revoke the token once a release has gone out.

## Use it from an AI coding agent

Agents can run the CLI with `--json` (stable shape, `status` field, exit codes), or use the MCP server:

```bash
claude mcp add go-tokenless -- npx -y go-tokenless mcp
```

```json
{ "mcpServers": { "go-tokenless": { "command": "npx", "args": ["-y", "go-tokenless", "mcp"] } } }
```

Tools: `plan_trusted_publishing` (read-only) and `apply_trusted_publishing` (writes files, no git or network writes). There is also an [Agent Skill](skills/go-tokenless/SKILL.md):

```bash
npx skills add Continuous-Actions/go-tokenless
```

Or install the skill and MCP server together as a plugin:

```bash
# Claude Code
/plugin marketplace add Continuous-Actions/go-tokenless
/plugin install go-tokenless@continuous-actions
```

```bash
# Gemini CLI
gemini extensions install https://github.com/Continuous-Actions/go-tokenless
```

Just ask: *"Move our npm publishing to trusted publishing."*

## Options

```text
npx go-tokenless [plan|apply|mcp] [--json] [--diff] [--repo owner/repo] [--cwd dir] [--offline]
                  [--npm-version <range>] [--npm-args "<args>"]
```

| Option | Meaning |
|---|---|
| `--json` | Print the full plan as JSON |
| `--diff` | Include the diff (always on for `plan`) |
| `--repo` | GitHub `owner/repo`, when the `origin` remote isn't GitHub |
| `--offline` | Skip the npm registry lookup that checks each package already exists |
| `--npm-version <range>` | npm version for the inserted upgrade step. Default `^12` |
| `--npm-args "<args>"` | Extra arguments appended to every npm command it generates: the upgrade step and the `npm trust` commands (for example `--registry=…` or `--loglevel=warn`) |

Exit codes: `0` ok, `1` blocked (errors to fix by hand), `2` usage error, `3` unexpected error. Needs Node 22.14+.

### npm version

When a publish job runs on a Node version whose bundled npm is too old, go-tokenless adds `npm install -g npm@^12`. It is pinned to one major on purpose: a new npm major can change how publishing behaves, and a release pipeline should not change under you. npm 12 needs Node 22.22.2+ or 24.15+; jobs pinned to an older exact Node 22 get a warning.

To use a different npm, pass `--npm-version` (for example `--npm-version ^11.6.0`). go-tokenless warns that an untested version may break the release, and refuses versions older than 11.5.1, which cannot use trusted publishing.

## Troubleshooting the errors people hit

- **`npm error code ENEEDAUTH`**: the job has no `id-token: write`, npm is older than 11.5.1, or the workflow file name doesn't match the trusted publisher exactly (case-sensitive, with `.yml`).
- **`npm error 404 Not Found - PUT https://registry.npmjs.org/...`**: usually the same causes as ENEEDAUTH, an `environment` mismatch, or the package has no trusted publisher yet.
- **`npm error code E422` … `repository.url`**: `package.json` `repository` doesn't match the GitHub repo. `go-tokenless apply` fixes the format; a different repo is reported as an error.
- **Publishing still uses the token**: something still sets `NODE_AUTH_TOKEN`, `NPM_TOKEN`, an `.npmrc` `_authToken`, or `.yarnrc.yml` `npmAuthToken`. Run `npx go-tokenless` again; it reports leftovers.

## License

MIT
