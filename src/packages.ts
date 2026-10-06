// Publishable packages in the repo, and the `repository` field npm checks
// against the workflow's repository when it accepts an OIDC publish.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Finding } from './types.ts';

export type PackageInfo = {
  name: string;
  /** Repo-relative folder ('.' for the root). */
  dir: string;
  file: string;
  version?: string;
  repositoryUrl?: string;
  scripts: Record<string, string>;
};

export type PackagePlan = PackageInfo & {
  /** Fixed package.json text, when the repository field needs changing. */
  after?: string;
  change?: string;
};

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.yarn']);

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Expand simple workspace globs: `a/b`, `a/*`, `a/**`, `!a/x`. */
function expand(root: string, patterns: string[]): string[] {
  const out = new Set<string>();
  const negated = patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1).replace(/^\.\//, '').replace(/\/+$/, ''));
  const walk = (rel: string, deep: boolean) => {
    let entries: string[] = [];
    try {
      entries = readdirSync(join(root, rel));
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP.has(e) || e.startsWith('.')) continue;
      const child = rel ? `${rel}/${e}` : e;
      if (!statSync(join(root, child)).isDirectory()) continue;
      if (existsSync(join(root, child, 'package.json'))) out.add(child);
      if (deep) walk(child, true);
    }
  };
  for (const raw of patterns) {
    if (raw.startsWith('!')) continue;
    const p = raw.replace(/^\.\//, '').replace(/\/+$/, '');
    const star = p.indexOf('*');
    if (star < 0) {
      if (existsSync(join(root, p, 'package.json'))) out.add(p);
      continue;
    }
    const base = p.slice(0, star).replace(/\/+$/, '');
    const deep = p.includes('**');
    const prefix = p.slice(0, star);
    if (!deep && /\*[^/]/.test(p.slice(star))) {
      // e.g. packages/plugin-* : one level, name prefix filter
      const namePrefix = prefix.slice(prefix.lastIndexOf('/') + 1);
      const dir = prefix.slice(0, prefix.lastIndexOf('/'));
      let entries: string[] = [];
      try { entries = readdirSync(join(root, dir)); } catch { /* none */ }
      for (const e of entries) if (e.startsWith(namePrefix) && existsSync(join(root, dir, e, 'package.json'))) out.add(dir ? `${dir}/${e}` : e);
      continue;
    }
    walk(base, deep);
  }
  return [...out].filter((d) => !negated.some((n) => d === n || d.startsWith(`${n}/`))).sort();
}

export function findPackages(root: string): PackageInfo[] {
  const rootPkg = readJson(join(root, 'package.json'));
  const patterns: string[] = [];
  if (Array.isArray(rootPkg?.workspaces)) patterns.push(...rootPkg.workspaces);
  else if (Array.isArray(rootPkg?.workspaces?.packages)) patterns.push(...rootPkg.workspaces.packages);
  const pnpm = join(root, 'pnpm-workspace.yaml');
  if (existsSync(pnpm)) {
    try {
      const y = parseYaml(readFileSync(pnpm, 'utf8'));
      if (Array.isArray(y?.packages)) patterns.push(...y.packages);
    } catch { /* ignore */ }
  }
  const lerna = readJson(join(root, 'lerna.json'));
  if (Array.isArray(lerna?.packages)) patterns.push(...lerna.packages);
  const dirs = ['.', ...expand(root, patterns)];
  const out: PackageInfo[] = [];
  for (const dir of [...new Set(dirs)]) {
    const file = dir === '.' ? 'package.json' : `${dir}/package.json`;
    const pkg = dir === '.' ? rootPkg : readJson(join(root, file));
    if (!pkg || typeof pkg.name !== 'string') continue;
    const info: PackageInfo = { name: pkg.name, dir, file, version: pkg.version, scripts: pkg.scripts ?? {}, repositoryUrl: repoUrl(pkg.repository) };
    if (pkg.private === true) {
      if (dir === '.') out.push({ ...info, name: '' }); // keep root scripts for lookup, not publishable
      continue;
    }
    out.push(info);
  }
  return out;
}

function repoUrl(r: unknown): string | undefined {
  if (typeof r === 'string') return r;
  if (r && typeof r === 'object' && typeof (r as any).url === 'string') return (r as any).url;
  return undefined;
}

/** `owner/repo` from any common GitHub repository URL form, or undefined. */
export function githubSlug(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const u = url.trim();
  let m = u.match(/^(?:github:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (m && !u.includes('://') && !u.includes('@')) return `${m[1]}/${m[2]}`;
  m = u.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[#/?].*)?$/i);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/** Check (and fix) each package's repository field against `owner/repo`. */
export function planPackages(root: string, packages: PackageInfo[], slug: string | undefined, findings: Finding[]): PackagePlan[] {
  const plans: PackagePlan[] = [];
  for (const p of packages) {
    if (!p.name) continue;
    const plan: PackagePlan = { ...p };
    plans.push(plan);
    if (!slug) continue;
    const have = githubSlug(p.repositoryUrl);
    const canonical = `git+https://github.com/${slug}.git`;
    if (have && have.toLowerCase() !== slug.toLowerCase()) {
      findings.push({ level: 'error', file: p.file, code: 'repository-mismatch', message: `\`${p.name}\` declares repository ${p.repositoryUrl}, but this repo is ${slug}. npm rejects the publish (E422) unless they match. Fix it if the package moved; leave it if this is a fork that doesn't publish.` });
      continue;
    }
    if (have === slug && p.repositoryUrl && /^git\+https:\/\/github\.com\//.test(p.repositoryUrl)) continue;
    const text = readFileSync(join(root, p.file), 'utf8');
    const after = setRepository(text, canonical, p.dir === '.' ? undefined : p.dir);
    if (after && after !== text) {
      plan.after = after;
      plan.change = have ? `${p.name}: normalise repository.url to ${canonical}` : `${p.name}: add repository.url ${canonical}${p.dir === '.' ? '' : ` (directory ${p.dir})`}`;
    }
  }
  return plans;
}

/** Set `repository` in package.json text, keeping indentation and key order. */
export function setRepository(text: string, url: string, directory?: string): string | undefined {
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(text);
  } catch {
    return undefined;
  }
  const indent = text.match(/^[ \t]+(?=")/m)?.[0] ?? '  ';
  const prev = pkg.repository;
  const value: Record<string, string> = { type: 'git', url };
  const dir = directory ?? (prev && typeof prev === 'object' ? (prev as any).directory : undefined);
  if (dir) value.directory = dir;
  let next: Record<string, unknown>;
  if ('repository' in pkg) {
    next = { ...pkg, repository: value };
  } else {
    next = {};
    const after = ['description', 'version', 'name'].find((k) => k in pkg);
    for (const [k, v] of Object.entries(pkg)) {
      next[k] = v;
      if (k === after) next.repository = value;
    }
    if (!('repository' in next)) next.repository = value;
  }
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  let out = JSON.stringify(next, null, indent);
  if (nl === '\r\n') out = out.replace(/\n/g, '\r\n');
  return text.endsWith('\n') ? out + nl : out;
}
