import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const CLI = resolve('dist/cli.js');

// Temp repos are removed when the test process exits.
const made: string[] = [];
process.on('exit', () => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

/** Create a git repo with an `origin` remote and the given files. */
export function makeRepo(files: Record<string, string>, remote = 'https://github.com/acme/widgets.git'): string {
  const root = mkdtempSync(join(tmpdir(), 'go-tokenless-'));
  made.push(root);
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), text);
  }
  execFileSync('git', ['init', '-q'], { cwd: root });
  if (remote) execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: root });
  return root;
}

export function run(root: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, '--offline', ...args], { cwd: root, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

export function plan(root: string, ...args: string[]) {
  const r = run(root, ...args, '--json');
  return { code: r.code, plan: JSON.parse(r.stdout) };
}

export const read = (root: string, f: string) => readFileSync(join(root, f), 'utf8');

export const pkg = (o: Record<string, unknown>) => `${JSON.stringify(o, null, 2)}\n`;
