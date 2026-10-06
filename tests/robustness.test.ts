import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeRepo, pkg, plan, read, run } from './helpers.ts';

const PKG = pkg({ name: 'pkg-a', version: '1.0.0', repository: { type: 'git', url: 'git+https://github.com/acme/widgets.git' } });
const head = 'on: push\njobs:\n  rel:\n    runs-on: ubuntu-latest\n    permissions:\n      id-token: write\n    steps:\n      - uses: actions/setup-node@v6\n        with:\n          node-version: 24\n          registry-url: https://registry.npmjs.org\n';
const TOKEN = '${{ secrets.NPM_TOKEN }}';

describe('file safety (round A)', () => {
  it('never writes package.json files outside the repo', () => {
    const outer = mkdtempSync(join(tmpdir(), 'go-tokenless-outer-'));
    const victim = join(outer, 'victim');
    mkdirSync(victim);
    writeFileSync(join(victim, 'package.json'), '{"name":"victim","version":"1.0.0"}');
    const root = join(outer, 'repo');
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    writeFileSync(join(root, '.github/workflows/r.yml'), `${head}      - run: npm publish\n        env:\n          NODE_AUTH_TOKEN: ${TOKEN}\n`);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'root', private: true, workspaces: ['../victim', '../*', '/abs'] }));
    run(root, 'apply', '--repo', 'acme/widgets');
    expect(readFileSync(join(victim, 'package.json'), 'utf8')).toBe('{"name":"victim","version":"1.0.0"}');
  });

  it('ignores symlinked workflow folders and odd file names without crashing', () => {
    const root = makeRepo({ '.github/workflows/x(.yml': `${head}      - run: npm publish\n`, '.github/workflows/(a+)+.yml': 'on: push\njobs: {}\n', 'package.json': PKG });
    mkdirSync(join(root, '.github/workflows/dir.yml'));
    try { symlinkSync(join(root, 'nowhere'), join(root, '.github/workflows/dangling.yml')); } catch { /* no symlink rights on Windows */ }
    const r = run(root, '--json');
    expect(r.code).toBe(0);
  });

  it('keeps package.json formatting (big numbers, escapes, order)', () => {
    const text = '{\n  "name": "pkg-a",\n  "version": "1.0.0",\n  "big": 12345678901234567890,\n  "esc": "\\u00e9",\n  "files": ["a", "b"]\n}\n';
    const root = makeRepo({ '.github/workflows/r.yml': `${head}      - run: npm publish\n        env:\n          NODE_AUTH_TOKEN: ${TOKEN}\n`, 'package.json': text });
    run(root, 'apply');
    expect(read(root, 'package.json')).toBe('{\n  "name": "pkg-a",\n  "version": "1.0.0",\n  "repository": {\n    "type": "git",\n    "url": "git+https://github.com/acme/widgets.git"\n  },\n  "big": 12345678901234567890,\n  "esc": "\\u00e9",\n  "files": ["a", "b"]\n}\n');
  });

  it('writes nothing when the plan is blocked', () => {
    const wf = `${head.replace('ubuntu-latest', '[self-hosted]')}      - run: npm publish\n        env:\n          NODE_AUTH_TOKEN: ${TOKEN}\n`;
    const files = { '.github/workflows/r.yml': wf, '.github/workflows/ok.yml': `${head}      - run: npm publish\n        env:\n          NODE_AUTH_TOKEN: ${TOKEN}\n`, 'package.json': PKG };
    const root = makeRepo(files);
    expect(run(root, 'apply').code).toBe(1);
    expect(read(root, '.github/workflows/ok.yml')).toBe(files['.github/workflows/ok.yml']);
  });

  it('handles crash inputs: valueless keys, prototype script names', () => {
    const root = makeRepo({ '.github/workflows/r.yml': `${head}      - run: npm run constructor\n      - run: npm publish\n        env: { NODE_AUTH_TOKEN: "${TOKEN}", DEBUG }\n`, 'package.json': PKG });
    expect(run(root, 'apply').code).toBe(0);
    expect(read(root, '.github/workflows/r.yml')).toContain('env: { DEBUG }');
  });

  it('stays fast on huge run scripts', () => {
    const big = `${'npm config set '.repeat(40000)}x`;
    const root = makeRepo({ '.github/workflows/r.yml': `${head}      - run: "${big}"\n      - run: npm publish\n`, 'package.json': PKG });
    const t = Date.now();
    run(root);
    expect(Date.now() - t).toBeLessThan(5000);
  });
});

describe('edits keep the workflow meaning (round A)', () => {
  it('one-line step with a token: reported, not deleted', () => {
    const wf = `${head}      - { name: Publish, run: npm publish, env: { NODE_AUTH_TOKEN: "${TOKEN}" } }\n`;
    const root = makeRepo({ '.github/workflows/r.yml': wf, 'package.json': PKG });
    const p = plan(root).plan;
    expect(p.findings.map((f: any) => f.code)).toContain('one-line-step');
    run(root, 'apply');
    expect(read(root, '.github/workflows/r.yml')).toContain('- { name: Publish, run: npm publish');
  });

  it('`- env:` as the first key keeps the step intact', () => {
    const wf = `${head}      - env:\n          NODE_AUTH_TOKEN: ${TOKEN}\n        run: npm publish\n`;
    const root = makeRepo({ '.github/workflows/r.yml': wf, 'package.json': PKG });
    run(root, 'apply');
    expect(read(root, '.github/workflows/r.yml')).toBe(`${head}      - run: npm publish\n`);
  });

  it('a bare `-` step gets the new step above it, not inside it', () => {
    const wf = 'on: push\njobs:\n  rel:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      -\n        run: npm publish\n        env:\n          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n';
    const root = makeRepo({ '.github/workflows/r.yml': wf, 'package.json': PKG });
    run(root, 'apply');
    const out = read(root, '.github/workflows/r.yml');
    expect(out).toContain('      - uses: actions/setup-node@v7\n');
    expect(out).toContain('      -\n        run: npm publish\n');
    expect(plan(root).plan.status).toBe('already-tokenless');
  });

  it('does not cut # lines out of a multi-line string above `steps:`', () => {
    const wf = 'on: push\njobs:\n  rel:\n    runs-on: ubuntu-latest\n    env:\n      NOTES: |\n        # heading\n    steps:\n      - run: npm publish\n        env:\n          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n';
    const root = makeRepo({ '.github/workflows/r.yml': wf, 'package.json': PKG });
    run(root, 'apply');
    expect(read(root, '.github/workflows/r.yml')).toContain('      NOTES: |\n        # heading\n    permissions:');
  });

  it('refuses to edit workflows that use anchors', () => {
    const wf = 'on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    env: &e\n      NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n    steps:\n      - run: npm publish\n  b:\n    runs-on: ubuntu-latest\n    env: *e\n    steps:\n      - run: npm test\n';
    const root = makeRepo({ '.github/workflows/r.yml': wf, 'package.json': PKG });
    const p = plan(root);
    expect(p.code).toBe(1);
    expect(p.plan.findings.map((f: any) => f.code)).toContain('yaml-anchors');
  });
});

describe('real-world detection (round C)', () => {
  it('follows composite actions, shell scripts and make targets', () => {
    const cases: Array<[string, Record<string, string>]> = [
      ['      - uses: ./.github/actions/release\n', { '.github/actions/release/action.yml': 'runs:\n  using: composite\n  steps:\n    - run: npm publish\n      shell: bash\n' }],
      ['      - run: ./scripts/release.sh\n', { 'scripts/release.sh': '#!/bin/sh\nnpm run build && npm publish --access public\n' }],
      ['      - run: make publish\n', { Makefile: 'publish:\n\t@npm publish\n' }],
      ['      - run: pnpm --filter=pkg-a publish\n', {}],
      ['      - run: npx semantic-release@24\n', {}],
    ];
    for (const [step, extra] of cases) {
      const root = makeRepo({ '.github/workflows/r.yml': `${head}${step}        env:\n          NODE_AUTH_TOKEN: ${TOKEN}\n`, 'package.json': PKG, ...extra });
      expect(plan(root).plan.status, step).toBe('ready');
    }
  });

  it('ignores echo lines and dry runs', () => {
    const root = makeRepo({ '.github/workflows/r.yml': `${head}      - run: echo "run npm publish later"\n      - run: npm publish --dry-run\n`, 'package.json': PKG });
    expect(plan(root).plan.status).toBe('no-publish-workflow');
  });

  it('says so when a token is passed but the publish command is hidden', () => {
    const root = makeRepo({ '.github/workflows/r.yml': `${head}      - uses: some-org/secret-publisher@v1\n        env:\n          NPM_TOKEN: ${TOKEN}\n`, 'package.json': PKG });
    const p = plan(root);
    expect(p.code).toBe(1);
    expect(p.plan.findings.map((f: any) => f.code)).toContain('publish-not-found');
  });

  it('leaves jobs already on OIDC alone', () => {
    const wf = 'on: push\njobs:\n  rel:\n    runs-on: ubuntu-latest\n    permissions:\n      id-token: write\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 20\n      - uses: changesets/action@v1\n        with:\n          publish: npx changeset publish\n';
    const root = makeRepo({ '.github/workflows/r.yml': wf, 'package.json': PKG });
    const p = plan(root).plan;
    expect(p.status).toBe('already-tokenless');
    expect(p.diff).toBe('');
  });

  it('keeps a GitHub Packages token next to the npm migration', () => {
    const wf = `${head}      - run: npm publish\n        env:\n          NODE_AUTH_TOKEN: ${TOKEN}\n      - run: npm publish --registry=https://npm.pkg.github.com\n        env:\n          NODE_AUTH_TOKEN: \${{ secrets.GITHUB_TOKEN }}\n`;
    const root = makeRepo({ '.github/workflows/r.yml': wf, 'package.json': PKG });
    run(root, 'apply');
    const out = read(root, '.github/workflows/r.yml');
    expect(out).not.toContain('secrets.NPM_TOKEN');
    expect(out).toContain('NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
  });

  it('trusts every caller of a reusable publish workflow', () => {
    const reusable = `on:\n  workflow_call:\njobs:\n  rel:\n    runs-on: ubuntu-latest\n    permissions:\n      id-token: write\n    steps:\n      - run: npm publish\n        env:\n          NODE_AUTH_TOKEN: ${TOKEN}\n`;
    const caller = (n: string) => `on: [push]\njobs:\n  ${n}:\n    uses: ./.github/workflows/publish.yml\n`;
    const root = makeRepo({ '.github/workflows/publish.yml': reusable, '.github/workflows/a.yml': caller('a'), '.github/workflows/b.yml': caller('b'), 'package.json': PKG });
    expect(plan(root).plan.trust.map((t: any) => t.workflow).sort()).toEqual(['a.yml', 'b.yml']);
  });

  it('uses working-directory to find scripts and the package', () => {
    const wf = `${head}      - run: npm run release\n        working-directory: packages/b\n        env:\n          NODE_AUTH_TOKEN: ${TOKEN}\n`;
    const root = makeRepo({
      '.github/workflows/r.yml': wf,
      'package.json': pkg({ name: 'root', private: true, workspaces: ['packages/*'] }),
      'packages/a/package.json': pkg({ name: 'pkg-a', version: '1.0.0' }),
      'packages/b/package.json': pkg({ name: 'pkg-b', version: '1.0.0', scripts: { release: 'npm publish' } }),
    });
    const p = plan(root).plan;
    expect(p.status).toBe('ready');
    expect(p.trust.map((t: any) => t.package)).toEqual(['pkg-b']);
  });

  it('keeps contents: write for jobs that create GitHub releases', () => {
    const wf = 'on: push\njobs:\n  rel:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/setup-node@v6\n        with:\n          node-version: 24\n          registry-url: https://registry.npmjs.org\n      - run: npm publish\n        env:\n          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n      - uses: softprops/action-gh-release@v2\n';
    const root = makeRepo({ '.github/workflows/r.yml': wf, 'package.json': PKG });
    run(root, 'apply');
    expect(read(root, '.github/workflows/r.yml')).toContain('      contents: write\n      id-token: write\n');
  });

  it('rejects a missing repository folder', () => {
    expect(run(makeRepo({}), '--cwd', join(tmpdir(), 'does-not-exist-go-tokenless')).code).toBe(2);
  });
});
