# Agent notes

- Yarn 4 via corepack (`corepack enable && yarn install`). `yarn check` = typecheck + build + tests.
- Tests are end-to-end (Vitest): they run the bundled `dist/cli.js` against temporary git repos. Rebuild (`yarn build`) before `yarn test`.
- Workflow edits are text patches (`src/edits.ts`) located with the `yaml` parser, so untouched lines stay byte-identical. Never re-serialise a whole YAML document.
- Every change must keep `apply` idempotent: planning again after `apply` must report `already-tokenless`.
- Commit messages and PR titles start with `feat:`, `fix:` or `chore:`.
