---
title: "npm error code E422 repository.url (provenance / trusted publishing)"
description: Fix npm publish E422 "repository.url" errors with provenance or trusted publishing in GitHub Actions.
---

# `npm error code E422` … `repository.url`

```
npm error code E422
npm error 422 Unprocessable Entity - PUT https://registry.npmjs.org/my-package - Error verifying sigstore provenance bundle: Failed to validate repository information: package.json: "repository.url" is "", expected to match "https://github.com/OWNER/REPO" from provenance
```

With provenance (automatic under trusted publishing), npm checks that `package.json` names the repository the workflow ran in.

## Fix

```json
{
  "repository": {
    "type": "git",
    "url": "git+https://github.com/OWNER/REPO.git"
  }
}
```

- **Monorepos:** each published package needs the field, plus `"directory": "packages/name"`.
- **Case:** `OWNER/REPO` must match GitHub's exact case.
- **Forks:** if `repository` points at the upstream, publishing from the fork will fail, and that is intended.

## Fix it automatically

```bash
npx go-tokenless apply
```

[go-tokenless](https://github.com/continuous-actions/go-tokenless) adds or fixes `repository` in every publishable package. It only rewrites shorthands and missing fields, and edits only that property's text. If `repository` points at a different repo, it stops and reports it instead.

[← All errors](../)
