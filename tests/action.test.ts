import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeRepo, pkg, run } from './helpers.ts';

const CHECK = resolve('action/check.mjs');
const wf = 'on: push\njobs:\n  rel:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm publish\n        env:\n          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n';

function check(root: string, mode = 'check') {
  const dir = mkdtempSync(join(tmpdir(), 'go-tokenless-action-'));
  const planFile = join(dir, 'plan.json');
  writeFileSync(planFile, run(root, '--json').stdout);
  const summary = join(dir, 'summary.md');
  const output = join(dir, 'output');
  writeFileSync(summary, '');
  writeFileSync(output, '');
  const r = spawnSync(process.execPath, [CHECK, planFile, mode], { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output } });
  return { code: r.status, stdout: r.stdout, summary: readFileSync(summary, 'utf8'), output: readFileSync(output, 'utf8') };
}

describe('action check script', () => {
  it('fails and annotates when publishing still uses a token', () => {
    const r = check(makeRepo({ '.github/workflows/release.yml': wf, 'package.json': pkg({ name: 'p', version: '1.0.0' }) }));
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/::warning file=\.github\/workflows\/release\.yml,title=go-tokenless%3A still token-based::/);
    expect(r.summary).toContain('npm publishing still depends on a stored token');
    expect(r.summary).toContain('npm trust github p');
    expect(r.output).toContain('status=ready');
  });

  it('report mode never fails', () => {
    const r = check(makeRepo({ '.github/workflows/release.yml': wf, 'package.json': pkg({ name: 'p', version: '1.0.0' }) }), 'report');
    expect(r.code).toBe(0);
  });

  it('passes when already tokenless or nothing publishes', () => {
    const ok = wf.replace('    steps:\n', '    permissions:\n      id-token: write\n    steps:\n').replace('        env:\n          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n', '');
    expect(check(makeRepo({ '.github/workflows/release.yml': ok, 'package.json': pkg({ name: 'p', version: '1.0.0', repository: { type: 'git', url: 'git+https://github.com/acme/widgets.git' } }) })).code).toBe(0);
    expect(check(makeRepo({ 'package.json': pkg({ name: 'p' }) })).code).toBe(0);
  });
});
