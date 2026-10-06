// Property-based fuzzing (fast-check): random release workflows built from the shapes seen
// in real repositories. Whatever the input, planning must not throw, edits must keep the
// file valid and mean the same apart from the migration, and a second run must be a no-op.

import fc from 'fast-check';
import { parseDocument } from 'yaml';
import { describe, expect, it } from 'vitest';
import { sameApartFromMigration } from '../src/verify.ts';
import { planWorkflow } from '../src/workflow.ts';

const scripts = (n: string) => ({ release: 'semantic-release', 'ci:publish': 'changeset publish' })[n];

const trigger = fc.constantFrom('push', '[push, workflow_dispatch]', 'release:\n    types: [published]', 'pull_request', 'pull_request_target', '{ push: { tags: ["v*"] } }');
const token = fc.constantFrom('${{ secrets.NPM_TOKEN }}', "${{ secrets['NPM_TOKEN'] }}", '""', '${{ secrets.GITHUB_TOKEN }}');
const tokenKey = fc.constantFrom('NODE_AUTH_TOKEN', 'NPM_TOKEN', 'YARN_NPM_AUTH_TOKEN', 'OTHER');
const publish = fc.constantFrom('npm publish', 'npm publish --provenance --access public', 'pnpm -r publish', 'npm run release', 'npx semantic-release', 'yarn npm publish', 'npm publish --dry-run', 'echo npm publish', 'if ! out=$(npm publish 2>&1); then exit 1; fi');
const perms = fc.constantFrom('', '    permissions:\n      contents: read\n', '    permissions:\n      id-token: write\n', '    permissions: read-all\n', '    permissions: { contents: write }\n');
const setup = fc.constantFrom('', '      - uses: actions/setup-node@v4\n        with:\n          node-version: 20\n', '      - uses: actions/setup-node@v4\n        with: { node-version: 24, registry-url: https://registry.npmjs.org }\n', '      - uses: actions/setup-node@v4\n        with:\n          node-version: 22\n          registry-url: https://npm.pkg.github.com\n');
const comment = fc.constantFrom('', '      # publish step\n', '\n');
const runner = fc.constantFrom('ubuntu-latest', '[self-hosted, linux]', '${{ matrix.os }}');

const workflow = fc.record({ trigger, token, tokenKey, publish, perms, setup, comment, runner, jobEnv: fc.boolean(), flow: fc.boolean(), crlf: fc.boolean() }).map((o) => {
  const env = o.flow
    ? `        env: { ${o.tokenKey}: "${o.token}" }\n`
    : `        env:\n          ${o.tokenKey}: ${o.token}\n`;
  const text = `on:\n  ${o.trigger}\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm ci\n  release:\n    runs-on: ${o.runner}\n${o.perms}${o.jobEnv ? `    env:\n      ${o.tokenKey}: ${o.token}\n` : ''}    steps:\n      - uses: actions/checkout@v5\n${o.setup}      - run: npm ci\n${o.comment}      - run: ${o.publish}\n${env}`;
  return o.crlf ? text.replace(/\n/g, '\r\n') : text;
});

describe('fuzz: planWorkflow', () => {
  it('never throws, keeps YAML valid and meaning intact, and is idempotent', () => {
    fc.assert(
      fc.property(workflow, fc.boolean(), (text, readToken) => {
        const npm = { npmVersion: '^12', readTokenSecret: readToken ? 'NPM_READ_TOKEN' : undefined };
        const first = planWorkflow('.github/workflows/release.yml', text, scripts, [], npm);
        if (first.after === text) return;
        expect(parseDocument(first.after).errors).toEqual([]);
        expect(sameApartFromMigration(text, first.after)).toBe(true);
        const second = planWorkflow('.github/workflows/release.yml', first.after, scripts, [], npm);
        expect(second.after).toBe(first.after);
      }),
      { numRuns: 400 },
    );
  });

  it('never grants id-token in workflows outsiders can trigger', () => {
    fc.assert(
      fc.property(workflow, (text) => {
        const plan = planWorkflow('.github/workflows/release.yml', text, scripts);
        if (/pull_request_target/.test(text)) expect(plan.after).toBe(text);
      }),
      { numRuns: 200 },
    );
  });

  it('survives arbitrary text', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), (text) => {
        planWorkflow('.github/workflows/x.yml', `on: push\njobs:\n  a:\n    steps:\n      - run: ${text}\n`, scripts);
        planWorkflow('.github/workflows/x.yml', text, scripts);
      }),
      { numRuns: 300 },
    );
  });
});
