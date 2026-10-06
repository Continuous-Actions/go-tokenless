---
title: "npm error code ENEEDAUTH with trusted publishing (GitHub Actions)"
description: Why npm publish fails with ENEEDAUTH after switching to trusted publishing (OIDC) in GitHub Actions, and how to fix it.
---

# `npm error code ENEEDAUTH` with trusted publishing

```
npm error code ENEEDAUTH
npm error need auth This command requires you to be logged in to https://registry.npmjs.org/
```

In a GitHub Actions release that uses [trusted publishing](https://docs.npmjs.com/trusted-publishers), this means npm didn't get or didn't use an OIDC token. Check these in order:

1. **No `id-token: write`.** The publishing **job** needs it:
   ```yaml
   permissions:
     contents: read
     id-token: write
   ```
   A job-level `permissions` block replaces the workflow-level one, so add `id-token: write` where the publish job is.
2. **npm is older than 11.5.1.** Node 22 ships npm 10, which can't do OIDC publishing. Use Node 24, or add `- run: npm install -g npm@^12` before publishing. pnpm 10 calls npm for the publish, so the same applies.
3. **The workflow file name doesn't match the trusted publisher.** The publisher on npmjs.com names one file, such as `release.yml`. It's case-sensitive, includes the extension, and must be the **calling** workflow when you use `workflow_call`.
4. **A self-hosted runner.** Trusted publishing only accepts GitHub-hosted runners.

## Check it automatically

```bash
npx go-tokenless
```

[go-tokenless](https://github.com/Continuous-Actions/go-tokenless) reads your workflows and lists exactly what's missing: the permission, the npm version, `registry-url`, leftover tokens and `repository.url`. `npx go-tokenless apply` fixes them.

[← All errors](../)
