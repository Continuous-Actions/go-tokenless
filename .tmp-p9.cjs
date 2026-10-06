const fs = require('fs');
let s = fs.readFileSync('src/workflow.ts', 'utf8');
const rep = (a, b) => { if (!s.includes(a)) throw new Error('missing ' + a.slice(0, 60)); s = s.replace(a, b); };
rep("import { parseDocument, isMap, isSeq, type Node, type Pair, type YAMLMap, type YAMLSeq } from 'yaml';",
    "import { parseDocument, isAlias, isMap, isSeq, visit, type Node, type Pair, type YAMLMap, type YAMLSeq } from 'yaml';");
rep("const isAuthTokenWriter = (run: string) => /_authToken|npm\s+config\s+set\s+[^\n]*:_auth/.test(run);",
    "// Cheap substring test first; the regex never scans more than one bounded line.\nconst isAuthTokenWriter = (run: string) => (run.includes('_authToken') || run.includes(':_auth')) && run.split('\n').some((l) => l.length < 4000 && /_authToken|npm\s+config\s+set\s+\S*:_auth/.test(l));");
const wrapStart = s.indexOf('export function planWorkflow(');
s = s.slice(0, wrapStart) + `export function planWorkflow(file: string, text: string, scripts: ScriptLookup, callers: string[] = [], npm: NpmOptions = DEFAULT_NPM): WorkflowPlan {
  const first = planOnce(file, text, scripts, callers, npm);
  if (first.jobs.length > 0 && hasAnchors(text)) {
    // Anchors and merge keys share nodes between jobs: a line edit could change other jobs,
    // and tokens can hide behind an alias. Report instead of editing.
    const findings = [...first.findings.filter((f) => f.level !== 'ok'), { file, line: 1, level: 'error' as const, code: 'yaml-anchors', message: 'This workflow uses YAML anchors or aliases, which go-tokenless will not edit automatically. Make the listed changes by hand, or expand the anchors and run it again.' }];
    return { ...first, findings, jobs: first.jobs.map((j) => ({ ...j, alreadyTokenless: false, blocked: true })), after: text };
  }
  let after = first.after;
  for (let i = 0; i < 3 && after !== text; i++) {
    const next = planOnce(file, after, scripts, callers, npm);
    if (next.after === after || next.findings.some((f) => f.code === 'patch-failed')) break;
    after = next.after;
  }
  if (after !== text && !sameApartFromMigration(text, after)) {
    const findings = [...first.findings, { file, line: 1, level: 'error' as const, code: 'patch-failed', message: 'The automatic edit would have changed more than the migration (for example a step merged into another). Nothing was written; make the listed changes by hand.' }];
    return { ...first, findings, after: text };
  }
  return { ...first, after };
}

function hasAnchors(text: string): boolean {
  if (!/[&*]/.test(text)) return false;
  let found = false;
  visit(parseDocument(text), (_k, node) => {
    if (isAlias(node) || ((node as any)?.anchor && typeof (node as any).anchor === 'string')) { found = true; return visit.BREAK; }
    return undefined;
  });
  return found;
}

/**
 * True when two workflow texts mean the same thing once the changes go-tokenless is
 * allowed to make are removed from both: token env vars, permissions, setup-node and
 * npm-upgrade steps, the npm-publish token input, action refs it bumps, .npmrc token lines.
 */
export function sameApartFromMigration(before: string, after: string): boolean {
  const norm = (t: string) => JSON.stringify(normalize(parseDocument(t).toJS({ maxAliasCount: 100 })));
  try {
    return norm(before) === norm(after);
  } catch {
    return false;
  }
}

function normalize(doc: any): any {
  const stripEnv = (env: any) => {
    if (!env || typeof env !== 'object') return env;
    const out: any = {};
    for (const [k, v] of Object.entries(env)) if (!isTokenKey(k)) out[k] = v;
    return Object.keys(out).length ? out : undefined;
  };
  const clean = (o: any) => { for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]; return o; };
  if (!doc || typeof doc !== 'object') return doc;
  const root = { ...doc, permissions: undefined, env: stripEnv(doc.env) };
  if (root.jobs && typeof root.jobs === 'object') {
    const jobs: any = {};
    for (const [id, job] of Object.entries<any>(root.jobs)) {
      if (!job || typeof job !== 'object' || !Array.isArray(job.steps)) { jobs[id] = job; continue; }
      const steps = job.steps
        .filter((st: any) => !(st && typeof st === 'object' && (/^actions\/setup-node@/i.test(String(st.uses ?? '')) || /^npm install -g npm@/.test(String(st.run ?? '')))))
        .map((st: any) => {
          if (!st || typeof st !== 'object') return st;
          const uses = String(st.uses ?? '');
          const out: any = { ...st, env: stripEnv(st.env) };
          if (/^(changesets\/action|js-devtools\/npm-publish)@/i.test(uses)) {
            out.uses = uses.replace(/@.*/, '');
            if (st.with && typeof st.with === 'object') {
              const w = { ...st.with };
              delete w.token;
              out.with = Object.keys(w).length ? w : undefined;
            }
          }
          if (typeof st.run === 'string') out.run = st.run.split('\n').filter((l: string) => !isAuthTokenWriter(l)).join('\n').trim();
          return clean(out);
        });
      jobs[id] = clean({ ...job, permissions: undefined, env: stripEnv(job.env), steps });
    }
    root.jobs = jobs;
  }
  return clean(root);
}
`;
fs.writeFileSync('src/workflow.ts', s);
