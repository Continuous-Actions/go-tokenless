---
title: "npm error 404 Not Found - PUT https://registry.npmjs.org (trusted publishing)"
description: Why npm publish returns 404 Not Found on PUT in GitHub Actions with trusted publishing or an expired token, and how to fix it.
---

# `npm error 404 Not Found - PUT https://registry.npmjs.org/<package>`

```
npm error code E404
npm error 404 Not Found - PUT https://registry.npmjs.org/my-package - Not found
```

The package exists, so why "Not found"? npm answers **404 instead of 401/403** when the publish isn't authorised. Common causes:

1. **The token expired or was revoked.** Granular tokens default to 90 days, and a 2FA-bypass token loses direct publishing in January 2027. This is how most people find out. The fix is to stop using a token: see the [checklist](../).
2. **No trusted publisher matches this run.** On npmjs.com → package → Settings → Trusted publishing, check:
   - the GitHub owner and repository
   - the **workflow file name** (exact, with `.yml`; for reusable workflows, the caller's file)
   - the **environment**, if your job sets `environment:`; it must match
3. **No `id-token: write`** on the publishing job, or **npm older than 11.5.1**. With these, npm falls back to whatever token is configured.
4. **Scoped package, first publish.** A trusted publisher can only be added to a package that already exists. Publish the first version by hand.

## Check it automatically

```bash
npx go-tokenless
```

It lists the missing pieces in your workflows and prints the exact `npm trust github …` command for each package, including `--env` when your job uses an environment.

[← All errors](../)
