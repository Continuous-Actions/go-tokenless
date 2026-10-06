---
title: "npm still publishes with NPM_TOKEN after switching to trusted publishing"
description: Why npm keeps using NODE_AUTH_TOKEN or NPM_TOKEN instead of OIDC trusted publishing in GitHub Actions, and where leftover tokens hide.
---

# Publishing still uses `NPM_TOKEN` after the migration

You added `id-token: write` and a trusted publisher, but releases still use the old token. Revoking it breaks publishing, and the provenance badge is missing.

npm tries OIDC first but **falls back to a configured token**. Any token that reaches the publish step keeps the old credential in use. Look for these:

- **`env` blocks:** `NODE_AUTH_TOKEN`, `NPM_TOKEN` or `NPM_AUTH_TOKEN` at the step, the job or the **workflow** level.
- **Other syntax:** `${{ secrets['NPM_TOKEN'] }}` and `${{ format('…', secrets.NPM_TOKEN) }}` are the same token.
- **`.npmrc`:** a committed file or a script that writes `//registry.npmjs.org/:_authToken=...`.
- **Yarn Berry:** `npmAuthToken` in `.yarnrc.yml`, or `YARN_NPM_AUTH_TOKEN`.
- **Actions with token inputs:** for example `JS-DevTools/npm-publish` `token:`. Update it to v4, which no longer requires one.
- **Other steps in the publish job:** any other step that receives the token can write it into `.npmrc`.

If installs need private packages, keep a **read-only** token on the install step only (`npm ci`), not on the publish.

## Find them automatically

```bash
npx go-tokenless                          # lists every token that still reaches publishing
npx go-tokenless apply --read-token NPM_READ_TOKEN   # removes them; installs get a read-only token
```

[← All errors](../)
