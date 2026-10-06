// Publishable packages in the repo, and the `repository` field npm checks
// against the workflow's repository when it accepts an OIDC publish.

import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
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
    return JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));
  } catch {
    return undefined;
  }
}

/** Expand simple workspace globs: `a/b`, `a/*`, `a/**`, `!a/x`. */
function expand(root: string, patterns: string[]): string[] {
  patterns = patterns.filter((p): p is string => typeof p === 'string');
  const out = new Set<string>();
  // Only real (non-symlink) folders inside the repo: a pattern may not climb out with `..` or be absolute.
  const inside = (p: string) => !p.startsWith('/') && !/^[a-z]:/i.test(p) && !p.split('/').includes('..');
  const isDir = (rel: string) => { try { return lstatSync(join(root, rel)).isDirectory(); } catch { return false; } };
  const hasPkg = (rel: string) => { try { return lstatSync(join(root, rel, 'package.json')).isFile(); } catch { return false; } };
  patterns = patterns.map((p) => p.replace(/\\/g, '/')).filter((p) => inside(p.replace(/^!/, '').replace(/^\.\//, '')));
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
      if (!isDir(child)) continue;
      if (hasPkg(child)) out.add(child);
      if (deep) walk(child, true);
    }
  };
  for (const raw of patterns) {
    if (raw.startsWith('!')) continue;
    const p = raw.replace(/^\.\//, '').replace(/\/+$/, '');
    const star = p.indexOf('*');
    if (star < 0) {
      if (isDir(p) && hasPkg(p)) out.add(p);
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
      for (const e of entries) {
        const rel = dir ? `${dir}/${e}` : e;
        if (e.startsWith(namePrefix) && isDir(rel) && hasPkg(rel)) out.add(rel);
      }
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

/**
 * Set `repository` in package.json text by editing only that property's text, so
 * everything else (key order, number formatting, escapes, duplicate keys) is untouched.
 */
export function setRepository(text: string, url: string, directory?: string): string | undefined {
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = text.slice(bom.length);
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) return undefined;
  const keys = topLevelKeys(body);
  if (!keys) return undefined;
  const nl = body.includes('\r\n') ? '\r\n' : '\n';
  const indent = body.match(/^[ \t]+(?=")/m)?.[0] ?? '  ';
  const prev = pkg.repository;
  const dir = directory ?? (prev && typeof prev === 'object' ? (prev as { directory?: string }).directory : undefined);
  const fields: Array<[string, string]> = [['type', 'git'], ['url', url], ...(dir ? [['directory', dir] as [string, string]] : [])];
  const render = (pad: string) => `{${nl}${fields.map(([k, v]) => `${pad}${indent}${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(`,${nl}`)}${nl}${pad}}`;
  const existing = keys.filter((k) => k.key === 'repository').pop();
  if (existing) return bom + body.slice(0, existing.valueStart) + render(indent) + body.slice(existing.valueEnd);
  const after = ['description', 'version', 'name'].map((k) => keys.filter((x) => x.key === k).pop()).find(Boolean) ?? keys[keys.length - 1];
  const prop = `${JSON.stringify('repository')}: ${render(indent)}`;
  if (!after) {
    const open = body.indexOf('{');
    return bom + body.slice(0, open + 1) + `${nl}${indent}${prop}${nl}` + body.slice(open + 1).replace(/^\s*/, '');
  }
  return bom + body.slice(0, after.valueEnd) + `,${nl}${indent}${prop}` + body.slice(after.valueEnd);
}

/** Offsets of each top-level key's value in a JSON object text (strings and nesting aware). */
function topLevelKeys(text: string): Array<{ key: string; valueStart: number; valueEnd: number }> | undefined {
  const out: Array<{ key: string; valueStart: number; valueEnd: number }> = [];
  let depth = 0;
  let i = 0;
  const skipString = (from: number) => {
    let k = from + 1;
    while (k < text.length && text[k] !== '"') k += text[k] === '\\' ? 2 : 1;
    return k + 1;
  };
  let pendingKey: string | undefined;
  let valueStart = -1;
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      const end = skipString(i);
      if (depth === 1 && pendingKey === undefined && valueStart < 0) {
        // A key: look ahead for the colon.
        const rest = text.slice(end).match(/^\s*:\s*/);
        if (rest) {
          pendingKey = JSON.parse(text.slice(i, end));
          valueStart = end + rest[0].length;
          i = valueStart - 1;
          continue;
        }
      }
      i = end - 1;
      continue;
    }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0 && pendingKey !== undefined) {
        out.push({ key: pendingKey, valueStart, valueEnd: text.slice(valueStart, i).trimEnd().length + valueStart });
        pendingKey = undefined;
        valueStart = -1;
      }
    } else if (c === ',' && depth === 1 && pendingKey !== undefined) {
      out.push({ key: pendingKey, valueStart, valueEnd: text.slice(valueStart, i).trimEnd().length + valueStart });
      pendingKey = undefined;
      valueStart = -1;
    }
  }
  return depth === 0 ? out : undefined;
}
