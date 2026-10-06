# Security

go-tokenless only reads and edits files in the repository you point it at. It never runs repository code, never reads secrets, and makes no network requests except read-only lookups to `https://registry.npmjs.org` (disable with `--offline`).

Report vulnerabilities privately via GitHub's "Report a vulnerability" on this repository.
