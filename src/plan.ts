// Builds the whole migration plan for a repository and applies it.

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { findPackages, githubSlug, planPackages, type PackagePlan } from './packages.ts';
import { DEFAULT_NPM_VERSION, planWorkflow, type NpmOptions, type Repo, type WorkflowPlan } from './workflow.ts';
import type { Finding } from './types.ts';

export type Status =
  /** Nothing in this repo publishes to npm from GitHub Actions. */
  | 'no-publish-workflow'
  /** Every publishing job already uses trusted publishing. */
  | 'already-tokenless'
  /** Changes are ready to apply. */
  | 'ready'
  /** Files were changed by `apply`; the human steps remain. */
  | 'applied'
  /** Something must be fixed by hand first (see errors). */
  | 'blocked';

export type TrustCommand = {
  package: string;
  workflow: string;
  environment?: string;
  command: string;
  /** False when the package isn't on npm yet (first publish must use a token). */
  published?: boolean;
};

export type Plan = {
  version: 1;
  status: Status;
  /** `owner/repo` on GitHub, when known. */
  repository?: string;
  workflows: Array<Pick<WorkflowPlan, 'file' | 'trustFile' | 'reusable' | 'jobs' | 'changes' | 'secrets'>>;
  packages: Array<{ name: string; dir: string; version?: string; change?: string; published?: boolean }>;
  changes: Array<{ file: string; description: string }>;
  findings: Finding[];
  trust: TrustCommand[];
  /** Ordered steps a human (with npm 2FA) must still do. */
  nextSteps: string[];
  /** Unified diff of all file changes. */
  diff: string;
};

export type PlanOptions = {
  /** Override `owner/repo` (otherwise read from `git remote get-url origin`). */
  repo?: string;
  /** Skip the npm registry lookups. */
  offline?: boolean;
  fetch?: typeof fetch;
  /** npm version range for the inserted upgrade step (default `^12`). */
  npmVersion?: string;
  /** Extra arguments appended to every npm command go-tokenless generates. */
  npmArgs?: string;
  /** Secret name holding a read-only npm token, given to install steps for private packages. */
  readToken?: string;
};

/** Throws a usage error for npm options that would produce a broken workflow. */
export function checkNpmOptions(opts: PlanOptions): void {
  // A single version or caret/tilde range: it is written into a shell command.
  if (opts.npmVersion !== undefined && !/^[\^~]?\d+(\.(\d+|x))?(\.(\d+|x))?(-[\w.]+)?$/.test(opts.npmVersion.trim())) {
    throw new UsageError(`--npm-version must be a version or a ^/~ range (e.g. ^12, ~11.6.0, 12.2.0), got "${opts.npmVersion}"`);
  }
  // Flags only (e.g. --registry=https://… --loglevel=warn): no shell syntax, no expressions.
  if (opts.npmArgs !== undefined && !/^(\s*--?[\w-]+(=[\w@%+:,./~-]+)?)*\s*$/.test(opts.npmArgs)) {
    throw new UsageError('--npm-args must be npm flags such as "--registry=https://registry.npmjs.org --loglevel=warn" (no shell characters or ${{ }})');
  }
  if (opts.repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(opts.repo)) {
    throw new UsageError(`repo must look like owner/repo, got "${opts.repo}"`);
  }
  if (opts.readToken !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(opts.readToken)) {
    throw new UsageError(`--read-token must be a secret name such as NPM_READ_TOKEN, got "${opts.readToken}"`);
  }
}

export class UsageError extends Error {}

type Internal = { plan: Plan; files: Map<string, string> };

export async function buildPlan(root: string, opts: PlanOptions = {}): Promise<Internal> {
  checkNpmOptions(opts);
  if (!isDirectory(root)) throw new UsageError(`Not a directory: ${root}`);
  const findings: Finding[] = [];
  const files = new Map<string, string>();
  const slug = opts.repo ?? remoteSlug(root);
  if (!slug) findings.push({ level: 'warning', file: '.', code: 'repo-unknown', message: 'Could not tell which GitHub repository this is (no GitHub `origin` remote). Pass `--repo owner/repo` so the trust commands and `repository` fields can be filled in.' });
  const npm: NpmOptions = { npmVersion: opts.npmVersion?.trim() || DEFAULT_NPM_VERSION, npmArgs: opts.npmArgs?.trim() || undefined, readTokenSecret: opts.readToken };
  const extraArgs = npm.npmArgs ? ` ${npm.npmArgs}` : '';
  const packages = findPackages(root);
  const byDir = new Map(packages.map((p) => [p.dir, p.scripts]));
  const own = (o: Record<string, string> | undefined, k: string) => (o && Object.hasOwn(o, k) && typeof o[k] === 'string' ? o[k] : undefined);
  const repo: Repo = {
    script: (name, dir) => own(byDir.get(normDir(dir)), name) ?? own(byDir.get('.'), name) ?? own(readJsonSafe(root, `${normDir(dir)}/package.json`)?.scripts, name),
    read: (rel) => readInside(root, rel),
  };

  const wfDir = join(root, '.github', 'workflows');
  const wfFiles = isDirectory(wfDir) ? readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f) && readInside(root, `.github/workflows/${f}`) !== undefined).sort() : [];
  const texts = new Map(wfFiles.map((f) => [`.github/workflows/${f}`, readInside(root, `.github/workflows/${f}`)!]));
  // Callers of a reusable workflow: any `uses: ./.github/workflows/<file>` (plain string match, no regex from file names).
  const callersOf = (file: string) =>
    [...texts].filter(([f, t]) => f !== file && t.split('\n').some((l) => l.replace(/['"]/g, '').replace(/\s+#.*$/, '').trim().replace(/^-\s*/, '') === `uses: ./${file}`)).map(([f]) => f);

  const workflows: WorkflowPlan[] = [];
  for (const [file, text] of texts) {
    const wp = planWorkflow(file, text, repo, callersOf(file), npm);
    if (wp.jobs.length === 0 && wp.findings.length === 0) continue;
    workflows.push(wp);
    findings.push(...wp.findings);
    if (wp.after !== text) files.set(file, wp.after);
  }
  const publishing = workflows.filter((w) => w.jobs.length > 0);

  // A workflow that hands an npm token to a job but whose publish command we can't see
  // (a script outside the repo, a third-party action): say so instead of "nothing to do".
  for (const [file, text] of texts) {
    if (publishing.some((w) => w.file === file)) continue;
    const m = text.match(/^\s*([A-Z_]*NPM[A-Z_]*TOKEN|NODE_AUTH_TOKEN|YARN_NPM_AUTH_TOKEN)\s*:\s*['"]?\$\{\{[^}]*\bsecrets\b/m);
    if (m && !/secrets\.GITHUB_TOKEN/.test(m[0])) {
      findings.push({ level: 'error', file, code: 'publish-not-found', message: `Passes \`${m[1]}\` from a secret, but go-tokenless could not find the command that publishes (it may be inside an action or a script it can't read). Migrate this workflow by hand: grant \`id-token: write\` to the publishing job and remove the token.` });
    }
  }

  // Reusable publish workflows: the caller needs id-token too.
  for (const w of publishing.filter((x) => x.reusable)) {
    for (const caller of callersOf(w.file)) {
      const text = files.get(caller) ?? texts.get(caller)!;
      if (!/id-token:\s*write/.test(text)) {
        findings.push({ level: 'warning', file: caller, code: 'caller-needs-id-token', message: `Calls the publishing workflow ${w.file}; the calling job also needs \`permissions: id-token: write\`.` });
      }
    }
  }

  const pkgPlans: PackagePlan[] = publishing.length > 0 ? planPackages(root, packages, slug, findings) : [];
  for (const p of pkgPlans) if (p.after) files.set(p.file, p.after);

  // Version floors read from the root package.json.
  if (publishing.length > 0) versionFindings(root, publishing, findings);
  if (publishing.length > 0 && npm.npmVersion !== DEFAULT_NPM_VERSION) {
    // Lowest version the range allows, e.g. "^11.2" -> 11.2.0, "11" -> 11.0.0.
    const m = npm.npmVersion.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
    const low = m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : [99, 0, 0];
    const tooOld = low[0]! < 11 || (low[0] === 11 && (low[1]! < 5 || (low[1] === 5 && low[2]! < 1)));
    findings.push(tooOld
      ? { level: 'error', file: '.github/workflows', code: 'npm-version-too-old', message: `--npm-version ${npm.npmVersion} is older than npm 11.5.1, which trusted publishing needs.` }
      : { level: 'warning', file: '.github/workflows', code: 'npm-version-override', message: `Using npm@${npm.npmVersion} instead of the tested ${DEFAULT_NPM_VERSION}. A different npm major may change how publishing or trusted publishing behaves and can break the release; test it before relying on it.` });
  }

  // Which packages each publishing workflow covers (best effort).
  const trust: TrustCommand[] = [];
  const pubs = pkgPlans.filter((p) => p.name);
  for (const w of publishing) {
    const text = texts.get(w.file)!;
    const inDirs = pubs.filter((p) => w.publishDirs.includes(p.dir));
    const mentioned = pubs.filter((p) => p.dir !== '.' && (text.includes(p.dir) || text.includes(p.name)));
    const covered = inDirs.length > 0 ? inDirs : publishing.length === 1 || mentioned.length === 0 ? pubs : mentioned;
    const okJobs = w.jobs.filter((j) => !j.blocked);
    if (okJobs.length === 0) continue; // never name a blocked workflow as a trusted publisher
    const envs = [...new Set(okJobs.map((j) => j.environment))];
    // npm checks the workflow that started the run: every caller of a reusable workflow.
    const trustFiles = w.reusable ? callersOf(w.file).map((c) => c.split('/').pop()!) : [w.trustFile];
    for (const p of covered) {
      if (!isValidNpmName(p.name)) {
        findings.push({ level: 'error', file: p.file, code: 'invalid-package-name', message: `"${p.name}" is not a valid npm package name, so no trust command was generated for it.` });
        continue;
      }
      for (const trustFile of trustFiles.length > 0 ? trustFiles : [w.trustFile]) {
        for (const env of envs) {
          const parts = ['npm', 'trust', 'github', p.name, '--repo', slug ?? '<owner>/<repo>', '--file', trustFile];
          if (env) parts.push('--env', env);
          parts.push('--allow-publish', '--yes');
          const command = parts.map((x) => (x === '<owner>/<repo>' ? x : shellQuote(x))).join(' ') + extraArgs;
          trust.push({ package: p.name, workflow: trustFile, environment: env, command });
        }
      }
    }
  }
  if (publishing.length > 1) {
    findings.push({ level: 'info', file: '.github/workflows', code: 'multiple-publish-workflows', message: `${publishing.length} workflows publish to npm. Each package's trusted publisher was matched to the workflow that mentions it; check the list before running the commands.` });
  }

  // Registry lookups: npm trust needs the package to exist.
  const published = new Map<string, boolean>();
  if (!opts.offline && pubs.length > 0) {
    const f = opts.fetch ?? fetch;
    await Promise.all(pubs.map(async (p) => {
      try {
        const res = await f(`https://registry.npmjs.org/${p.name.replace('/', '%2F')}`, { method: 'GET', headers: { accept: 'application/vnd.npm.install-v1+json' }, signal: AbortSignal.timeout(8000) });
        if (res.status === 404) published.set(p.name, false);
        else if (res.ok) published.set(p.name, true);
      } catch { /* offline: unknown */ }
    }));
    for (const t of trust) t.published = published.get(t.package);
    const fresh = pubs.filter((p) => published.get(p.name) === false);
    if (fresh.length > 0) {
      findings.push({ level: 'warning', file: fresh[0]!.file, code: 'not-on-npm-yet', message: `${fresh.map((p) => `\`${p.name}\``).join(', ')} ${fresh.length === 1 ? 'is' : 'are'} not on npm yet. A trusted publisher can only be added to an existing package, so publish the first version from your machine (\`npm publish\` with 2FA), then add the trusted publisher.` });
    }
  }

  const changes = [
    ...publishing.flatMap((w) => w.changes.map((d) => ({ file: w.file, description: d }))),
    ...pkgPlans.filter((p) => p.change).map((p) => ({ file: p.file, description: p.change! })),
  ];
  const secrets = [...new Set(publishing.flatMap((w) => w.secrets))];
  if (opts.readToken && secrets.includes(opts.readToken)) {
    findings.push({ level: 'warning', file: '.github/workflows', code: 'read-token-is-publish-token', message: `\`${opts.readToken}\` is the secret that publishes today. Install steps would get that publish-capable token. Put a read-only token in it (or use a new secret name) and revoke the old one.` });
  }
  const hasErrors = findings.some((f) => f.level === 'error');
  const allTokenless = publishing.length > 0 && publishing.every((w) => w.jobs.every((j) => j.alreadyTokenless));
  const status: Status = publishing.length === 0 ? 'no-publish-workflow' : hasErrors ? 'blocked' : allTokenless && changes.length === 0 ? 'already-tokenless' : 'ready';

  const plan: Plan = {
    version: 1,
    status,
    repository: slug,
    workflows: workflows.map(({ file, trustFile, reusable, jobs, changes: c, secrets: s }) => ({ file, trustFile, reusable, jobs, changes: c, secrets: s })),
    packages: pubs.map((p) => ({ name: p.name, dir: p.dir, version: p.version, change: p.change, published: published.get(p.name) })),
    changes,
    findings,
    trust,
    nextSteps: nextSteps(status, trust, secrets, slug, opts.readToken),
    diff: [...files].map(([f, after]) => unifiedDiff(f, readFileSync(join(root, f), 'utf8'), after)).join(''),
  };
  return { plan, files };
}

/** Write the planned file changes. Returns the plan with status `applied`. */
export async function applyPlan(root: string, opts: PlanOptions = {}): Promise<Plan> {
  const { plan, files } = await buildPlan(root, opts);
  // Blocked means a human has to decide something first: write nothing.
  if (plan.status !== 'ready') return plan;
  for (const f of files.keys()) if (readInside(root, f) === undefined) throw new Error(`Refusing to write outside the repository or through a link: ${f}`);
  for (const [f, text] of files) writeFileSync(join(root, f), text);
  const status: Status = 'applied';
  return { ...plan, status, nextSteps: nextSteps(status, plan.trust, [...new Set(plan.workflows.flatMap((w) => w.secrets))], plan.repository, opts.readToken) };
}

function nextSteps(status: Status, trust: TrustCommand[], secrets: string[], slug?: string, readToken?: string): string[] {
  if (status === 'no-publish-workflow') return ['No GitHub Actions workflow in this repo publishes to npm. Nothing to migrate.'];
  if (status === 'already-tokenless') {
    return secrets.length > 0 ? [`Delete the unused secret${secrets.length > 1 ? 's' : ''}: ${secrets.map((s) => `\`gh secret delete ${s}\``).join(', ')}.`] : ['Already using trusted publishing. Nothing to do.'];
  }
  const steps: string[] = [];
  if (status === 'blocked') steps.push('Fix the errors listed above first.');
  if (status === 'ready') steps.push('Run `npx go-tokenless apply` (or apply the diff above) and commit the changes on a branch.');
  if (status === 'applied') steps.push('Review the changed files and commit them on a branch.');
  if (trust.some((t) => t.published === false)) steps.push('Publish packages that are not on npm yet once from your machine (`npm publish`), so a trusted publisher can be attached.');
  if (trust.length > 0) {
    steps.push(`Add a trusted publisher for each package. With npm 11.15+ logged in with 2FA, run:\n${trust.map((t) => `    ${t.command}`).join('\n')}\n  Or on npmjs.com: package → Settings → Trusted publishing → GitHub Actions${slug ? ` (repository ${slug})` : ''}.`);
  }
  if (readToken && (status === 'ready' || status === 'applied')) {
    steps.push(`Create a read-only granular npm token (Packages and scopes: read-only, for your org's private packages) and save it as the \`${readToken}\` secret: \`gh secret set ${readToken}\`.`);
  }
  steps.push('Merge, then let the release workflow publish once. Check the new version shows a provenance badge on npmjs.com.');
  const old = secrets.filter((s) => s !== readToken);
  if (readToken && secrets.includes(readToken)) {
    steps.push(`\`${readToken}\` holds your current publish token. Replace its value with a read-only token before merging (\`gh secret set ${readToken}\`), then revoke the old token on npmjs.com → Access Tokens.`);
  }
  if (old.length > 0) steps.push(`Delete the old publish token secret${old.length > 1 ? 's' : ''} (${old.map((s) => `\`gh secret delete ${s}\``).join(', ')}) and revoke the token on npmjs.com → Access Tokens.`);
  steps.push('Optional: in each package\'s npm settings choose "Require two-factor authentication and disallow tokens".');
  return steps;
}

function remoteSlug(root: string): string | undefined {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return githubSlug(url);
  } catch {
    return undefined;
  }
}

function versionFindings(root: string, publishing: WorkflowPlan[], findings: Finding[]) {
  let pkg: any;
  try { pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')); } catch { return; }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>;
  const tools = new Set(publishing.flatMap((w) => w.jobs.flatMap((j) => j.tools)));
  const below = (v: string | undefined, min: number[]) => {
    const m = v?.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
    if (!m) return false;
    const have = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
    for (let i = 0; i < 3; i++) if (have[i] !== min[i]) return have[i]! < min[i]!;
    return false;
  };
  const pm = String(pkg.packageManager ?? '');
  const check = (cond: boolean, code: string, message: string) => { if (cond) findings.push({ level: 'warning', file: 'package.json', code, message }); };
  check(tools.has('yarn') && pm.startsWith('yarn@') && below(pm.slice(5), [4, 10, 3]), 'yarn-too-old', `packageManager is ${pm}. Yarn needs 4.10.3+ to publish with trusted publishing.`);
  check(tools.has('pnpm') && pm.startsWith('pnpm@11') && below(pm.slice(5), [11, 1, 3]), 'pnpm-too-old', `packageManager is ${pm}. Use pnpm 11.1.3+ (or pnpm 10, which hands publishing to npm).`);
  check(tools.has('semantic-release') && below(deps['@semantic-release/npm'], [13, 1, 0]), 'semantic-release-npm-too-old', `@semantic-release/npm is ${deps['@semantic-release/npm']}; trusted publishing needs 13.1.0+.`);
  check(tools.has('semantic-release') && !deps['@semantic-release/npm'] && below(deps['semantic-release'], [25, 0, 0]), 'semantic-release-too-old', `semantic-release is ${deps['semantic-release']}; trusted publishing needs semantic-release 25+ (@semantic-release/npm 13.1.0+).`);
  check(tools.has('lerna') && below(deps.lerna, [9, 0, 0]), 'lerna-too-old', `lerna is ${deps.lerna}; trusted publishing needs lerna 9+.`);
  const yarnrc = join(root, '.yarnrc.yml');
  if (existsSync(yarnrc) && /npmAuthToken/.test(readFileSync(yarnrc, 'utf8'))) {
    findings.push({ level: 'warning', file: '.yarnrc.yml', code: 'yarnrc-auth-token', message: 'Sets `npmAuthToken`. Remove it (or scope it to installs only) so Yarn uses trusted publishing when it publishes.' });
  }
  const npmrc = join(root, '.npmrc');
  if (existsSync(npmrc) && /registry\.npmjs\.org\/:_authToken/.test(readFileSync(npmrc, 'utf8'))) {
    findings.push({ level: 'warning', file: '.npmrc', code: 'npmrc-auth-token', message: 'Sets an `_authToken` for registry.npmjs.org. Remove that line; a configured token stops npm from using trusted publishing.' });
  }
}

/** Minimal unified diff (whole-file hunks are fine for review output). */
export function unifiedDiff(file: string, before: string, after: string): string {
  if (before === after) return '';
  const a = before.split('\n'), b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1, endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB--; }
  // Inner lines are diffed with a simple LCS so separate edits read naturally.
  const ctx = 3;
  const from = Math.max(0, start - ctx);
  const toA = Math.min(a.length - 1, endA + ctx), toB = Math.min(b.length - 1, endB + ctx);
  const body = lcsDiff(a.slice(start, endA + 1), b.slice(start, endB + 1));
  const lines = [
    ...a.slice(from, start).map((l) => ` ${l}`),
    ...body,
    ...a.slice(endA + 1, toA + 1).map((l) => ` ${l}`),
  ];
  return `--- a/${file}\n+++ b/${file}\n@@ -${from + 1},${toA - from + 1} +${from + 1},${toB - from + 1} @@\n${lines.join('\n')}\n`;
}

function lcsDiff(a: string[], b: string[]): string[] {
  if (a.length * b.length > 250_000) return [...a.map((l) => `-${l}`), ...b.map((l) => `+${l}`)];
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: string[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push(` ${a[i]}`); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push(`-${a[i++]}`);
    else out.push(`+${b[j++]}`);
  }
  while (i < a.length) out.push(`-${a[i++]}`);
  while (j < b.length) out.push(`+${b[j++]}`);
  return out;
}

/** npm package name rules: lowercase, URL-safe, optional @scope/. */
export function isValidNpmName(name: string): boolean {
  return name.length <= 214 && /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(name);
}

/** Single-quote a word for the shell unless it only has safe characters. */
export function shellQuote(word: string): string {
  return /^[\w@%+=:,./~-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\''`)}'`;
}

const MAX_FILE = 1024 * 1024;

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const normDir = (dir: string | undefined) => (dir ? dir.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '') || '.' : '.');

/**
 * Read a repo-relative file only if it is a regular file (not a link) that really lives
 * inside the repository and is a sensible size. Everything go-tokenless reads or writes goes through here.
 */
export function readInside(root: string, rel: string): string | undefined {
  if (!rel || isAbsolute(rel) || rel.replace(/\\/g, '/').split('/').includes('..')) return undefined;
  const full = join(root, rel);
  try {
    const st = lstatSync(full);
    if (!st.isFile() || st.size > MAX_FILE) return undefined;
    const r = relative(realpathSync(root), realpathSync(full));
    if (r.startsWith('..') || isAbsolute(r)) return undefined;
    return readFileSync(full, 'utf8');
  } catch {
    return undefined;
  }
}

function readJsonSafe(root: string, rel: string): any {
  const t = readInside(root, rel);
  try {
    return t ? JSON.parse(t.replace(/^﻿/, '')) : undefined;
  } catch {
    return undefined;
  }
}
