---
title: "npm notice: npm tokens that bypass 2FA are being restricted (what to do)"
description: What the npm notice about 2FA-bypass tokens means for GitHub Actions releases, the January 2027 deadline, and how to migrate to trusted publishing.
---

# `npm notice npm tokens that bypass 2FA are being restricted`

```
npm notice npm tokens that bypass 2FA are being restricted for account changes and direct publishing. Learn how to prepare: https://gh.io/npm-gat-bypass2fa-deprecation
```

Your release workflow publishes with a granular access token that has "bypass 2FA" enabled. npm is phasing that out:

- **Since August 2026:** those tokens can't change account settings.
- **From January 2027:** they can no longer **publish directly**. They can only stage a publish that a human approves with 2FA ([npm docs](https://docs.npmjs.com/about-access-tokens/)).

For CI, the replacement is **trusted publishing (OIDC)**. No token is stored at all.

## Migrate

```bash
npx go-tokenless          # see the exact changes for your repo
npx go-tokenless apply    # make them
```

Then add the trusted publisher. go-tokenless prints the `npm trust github …` command for each package, or you can add it on npmjs.com → package → Settings → Trusted publishing. Delete the old secret after the first tokenless release.

See the full [checklist](../).

[← All errors](../)
