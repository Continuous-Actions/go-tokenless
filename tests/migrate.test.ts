import { describe, expect, it } from 'vitest';
import { makeRepo, pkg, plan, read, run } from './helpers.ts';

const NPM_PUBLISH = `name: Release
on:
  release:
    types: [published]

jobs:
  publish:
    runs-on: ubuntu-latest
    env:
      # token for npm
      NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}
    steps:
      - uses: actions/checkout@v5

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          registry-url: 'https://registry.npmjs.org'

      - run: npm ci

      - run: npm publish --provenance --access public
`;

describe('plain npm publish', () => {
  it('plans without writing, then applies the full migration', () => {
    const root = makeRepo({ '.github/workflows/release.yml': NPM_PUBLISH, 'package.json': pkg({ name: 'widgets', version: '1.0.0' }) });
    const before = read(root, '.github/workflows/release.yml');
    const p = plan(root);
    expect(p.code).toBe(0);
    expect(p.plan.status).toBe('ready');
    expect(p.plan.repository).toBe('acme/widgets');
    expect(read(root, '.github/workflows/release.yml')).toBe(before);
    expect(p.plan.trust).toEqual([
      { package: 'widgets', workflow: 'release.yml', command: 'npm trust github widgets --repo acme/widgets --file release.yml --allow-publish --yes' },
    ]);
    expect(p.plan.diff).toContain('-      NODE_AUTH_TOKEN');

    const a = run(root, 'apply');
    expect(a.code).toBe(0);
    expect(a.stdout).toContain('Workflow changes written');
    expect(a.stdout).toContain('gh secret delete NPM_TOKEN');
    const wf = read(root, '.github/workflows/release.yml');
    expect(wf).toBe(`name: Release
on:
  release:
    types: [published]

jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@v5

      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          registry-url: 'https://registry.npmjs.org'

      - run: npm ci

      - run: npm publish --provenance --access public
`);
    expect(JSON.parse(read(root, 'package.json')).repository).toEqual({ type: 'git', url: 'git+https://github.com/acme/widgets.git' });
    // Idempotent.
    expect(plan(root).plan.status).toBe('already-tokenless');
  });

  it('upgrades npm on Node 22 and removes token-writing lines from scripts', () => {
    const root = makeRepo({
      '.github/workflows/publish.yml': `on: push
permissions:
  contents: read
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with: { node-version: 22.x }
      - name: Publish
        run: |
          npm config set //registry.npmjs.org/:_authToken=$NODE_AUTH_TOKEN
          npm publish
        env:
          NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}
          OTHER: keep-me
`,
      'package.json': pkg({ name: 'x', version: '1.0.0', repository: 'github:acme/widgets' }),
    });
    expect(run(root, 'apply').code).toBe(0);
    expect(read(root, '.github/workflows/publish.yml')).toBe(`on: push
permissions:
  contents: read
jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/setup-node@v4
        with: { node-version: 22.x, registry-url: https://registry.npmjs.org }
      - name: Use an npm version that supports trusted publishing
        run: npm install -g npm@^11.5.1
      - name: Publish
        run: |
          npm publish
        env:
          OTHER: keep-me
`);
    expect(JSON.parse(read(root, 'package.json')).repository.url).toBe('git+https://github.com/acme/widgets.git');
  });

  it('keeps CRLF line endings', () => {
    const root = makeRepo({ '.github/workflows/release.yml': NPM_PUBLISH.replace(/\n/g, '\r\n'), 'package.json': pkg({ name: 'w', version: '1.0.0' }) });
    run(root, 'apply');
    const wf = read(root, '.github/workflows/release.yml');
    expect(wf).toContain('id-token: write\r\n');
    expect(wf.replace(/\r\n/g, '')).not.toContain('\n');
  });
});

describe('release tools', () => {
  it('changesets: bumps the action to v2 and keeps GITHUB_TOKEN', () => {
    const root = makeRepo({
      '.github/workflows/release.yml': `name: Release
on:
  push:
    branches: [main]
jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v6
        with:
          node-version: 24
      - run: pnpm install
      - uses: changesets/action@v1
        with:
          publish: pnpm release
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          NPM_TOKEN: \${{ secrets.NPM_TOKEN }}
`,
      'package.json': pkg({ name: 'root', private: true, scripts: { release: 'changeset publish' }, workspaces: ['packages/*'] }),
      'packages/a/package.json': pkg({ name: '@acme/a', version: '1.0.0' }),
      'packages/b/package.json': pkg({ name: '@acme/b', version: '1.0.0', private: true }),
    });
    const p = plan(root).plan;
    expect(p.workflows[0].jobs[0].tools).toEqual(['changesets']);
    expect(p.packages.map((x: any) => x.name)).toEqual(['@acme/a']);
    run(root, 'apply');
    const wf = read(root, '.github/workflows/release.yml');
    expect(wf).toContain('uses: changesets/action@v2');
    expect(wf).toContain('      pull-requests: write\n      id-token: write\n');
    expect(wf).toContain('GITHUB_TOKEN');
    expect(wf).not.toContain('NPM_TOKEN');
    expect(wf).toContain('registry-url: https://registry.npmjs.org');
    expect(wf).not.toContain('npm install -g npm');
    expect(JSON.parse(read(root, 'packages/a/package.json')).repository).toEqual({ type: 'git', url: 'git+https://github.com/acme/widgets.git', directory: 'packages/a' });
  });

  it('semantic-release via npm script, with environment', () => {
    const root = makeRepo({
      '.github/workflows/ci.yml': `on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
  release:
    needs: test
    runs-on: ubuntu-latest
    environment: npm
    steps:
      - uses: actions/setup-node@v6
        with:
          node-version: lts/*
      - run: npm run semantic-release
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          NPM_TOKEN: \${{ secrets.NPM_TOKEN }}
`,
      'package.json': pkg({ name: 'lib', version: '0.0.0-development', scripts: { 'semantic-release': 'semantic-release' }, devDependencies: { 'semantic-release': '^24.0.0' } }),
    });
    const p = plan(root).plan;
    expect(p.workflows[0].jobs.map((j: any) => j.job)).toEqual(['release']);
    expect(p.trust[0].command).toBe('npm trust github lib --repo acme/widgets --file ci.yml --env npm --allow-publish --yes');
    expect(p.findings.map((f: any) => f.code)).toContain('semantic-release-too-old');
    run(root, 'apply');
    const wf = read(root, '.github/workflows/ci.yml');
    expect(wf).toContain('    permissions:\n      contents: write\n      issues: write\n      pull-requests: write\n      id-token: write\n    steps:');
    expect(wf).not.toContain('NPM_TOKEN');
  });

  it('JS-DevTools/npm-publish: drops the token input and updates to v4', () => {
    const root = makeRepo({
      '.github/workflows/p.yml': `on: push
jobs:
  p:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
    steps:
      - uses: actions/setup-node@v6
        with:
          node-version: 24
          registry-url: https://registry.npmjs.org
      - uses: JS-DevTools/npm-publish@v3
        with:
          token: \${{ secrets.NPM_TOKEN }}
`,
      'package.json': pkg({ name: 'p', version: '1.0.0', repository: { type: 'git', url: 'git+https://github.com/acme/widgets.git' } }),
    });
    run(root, 'apply');
    const wf = read(root, '.github/workflows/p.yml');
    expect(wf).toContain('      - uses: JS-DevTools/npm-publish@v4\n');
    expect(wf).not.toContain('secrets.NPM_TOKEN');
    expect(plan(root).plan.status).toBe('already-tokenless');
  });
});

describe('guards', () => {
  it('blocks self-hosted runners and changes nothing', () => {
    const wf = NPM_PUBLISH.replace('ubuntu-latest', '[self-hosted, linux]');
    const root = makeRepo({ '.github/workflows/release.yml': wf, 'package.json': pkg({ name: 'w', version: '1.0.0' }) });
    const r = run(root, 'apply');
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('self-hosted');
    expect(read(root, '.github/workflows/release.yml')).toBe(wf);
  });

  it('leaves GitHub Packages publishing alone', () => {
    const root = makeRepo({ '.github/workflows/release.yml': NPM_PUBLISH.replace('https://registry.npmjs.org', 'https://npm.pkg.github.com'), 'package.json': pkg({ name: 'w', version: '1.0.0' }) });
    const p = plan(root).plan;
    expect(p.status).toBe('no-publish-workflow');
    expect(p.findings[0].code).toBe('other-registry');
  });

  it('reports a repository mismatch as an error', () => {
    const root = makeRepo({ '.github/workflows/release.yml': NPM_PUBLISH, 'package.json': pkg({ name: 'w', version: '1.0.0', repository: 'https://github.com/someone/else' }) });
    const p = plan(root);
    expect(p.code).toBe(1);
    expect(p.plan.status).toBe('blocked');
    expect(p.plan.findings.find((f: any) => f.level === 'error').code).toBe('repository-mismatch');
  });

  it('reusable workflows: trusts the caller file', () => {
    const root = makeRepo({
      '.github/workflows/publish.yml': NPM_PUBLISH.replace(/on:\n  release:\n    types: \[published\]/, 'on:\n  workflow_call:'),
      '.github/workflows/release.yml': `on:
  push:
    tags: ['v*']
jobs:
  call:
    uses: ./.github/workflows/publish.yml
    secrets: inherit
`,
      'package.json': pkg({ name: 'w', version: '1.0.0' }),
    });
    const p = plan(root).plan;
    expect(p.trust[0].workflow).toBe('release.yml');
    expect(p.findings.map((f: any) => f.code)).toEqual(expect.arrayContaining(['reusable-workflow', 'caller-needs-id-token']));
  });

  it('reports no publish workflow', () => {
    const root = makeRepo({ '.github/workflows/ci.yml': 'on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n', 'package.json': pkg({ name: 'w' }) });
    const r = run(root);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('No workflow here publishes to npm');
  });
});

describe('cli', () => {
  it('prints help and rejects bad usage', () => {
    const root = makeRepo({});
    expect(run(root, '--help').stdout).toContain('npx go-tokenless apply');
    expect(run(root, 'frobnicate').code).toBe(2);
    expect(run(root, '--repo', 'nope').code).toBe(2);
  });

  it('uses --repo when there is no git remote', () => {
    const root = makeRepo({ '.github/workflows/release.yml': NPM_PUBLISH, 'package.json': pkg({ name: 'w', version: '1.0.0' }) }, '');
    expect(plan(root).plan.repository).toBeUndefined();
    expect(plan(root).plan.trust[0].command).toContain('--repo <owner>/<repo>');
    expect(plan(root, '--repo', 'me/mine').plan.trust[0].command).toContain('--repo me/mine');
  });
});
