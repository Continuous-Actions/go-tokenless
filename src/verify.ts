// Safety net for workflow edits. Edits are line patches, so before anything is written
// the old and new files are compared by meaning: with aliases resolved and the changes
// go-tokenless is allowed to make removed from both, they must be identical.

import { isAlias, parseDocument, visit } from 'yaml';

/** Env names that carry an npm auth token. */
export const isTokenKey = (k: string) =>
  ['NODE_AUTH_TOKEN', 'NPM_TOKEN', 'NPM_AUTH_TOKEN', 'NPM_CONFIG_TOKEN', 'NPM_PUBLISH_TOKEN'].includes(k) ||
  /^(YARN_NPM_AUTH_TOKEN|NPM_CONFIG__AUTH(TOKEN)?)$/i.test(k) ||
  /NPM\w*TOKEN|TOKEN\w*NPM/i.test(k);

/** A shell line that writes an npm auth token (cheap substring test first; bounded regex). */
export const isAuthTokenWriter = (run: string) =>
  (run.includes('_authToken') || run.includes(':_auth') || run.includes('npmAuthToken')) &&
  run.split('\n').some((l) => l.length < 4000 && !l.includes('npm.pkg.github.com') && /_authToken|npmAuthToken|npm\s+config\s+set\s+\S*:_auth/.test(l));

/** True when the YAML uses anchors, aliases or merge keys anywhere. */
export function hasAnchors(text: string): boolean {
  if (!/[&*]/.test(text)) return false;
  let found = false;
  visit(parseDocument(text), (_k, node) => {
    if (isAlias(node) || typeof (node as { anchor?: unknown } | null)?.anchor === 'string') {
      found = true;
      return visit.BREAK;
    }
    return undefined;
  });
  return found;
}

export function sameApartFromMigration(before: string, after: string): boolean {
  try {
    const norm = (t: string) => JSON.stringify(normalize(parseDocument(t).toJS({ maxAliasCount: 100 })));
    return norm(before) === norm(after);
  } catch {
    return false;
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

function stripEnv(env: unknown): unknown {
  if (!isObj(env)) return env;
  const out: Obj = {};
  for (const [k, v] of Object.entries(env)) if (!isTokenKey(k)) out[k] = v;
  return Object.keys(out).length > 0 ? out : undefined;
}

function clean(o: Obj): Obj {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

/** A run script whose only job is writing an npm token into .npmrc (the planner deletes these steps). */
export const isTokenOnlyScript = (run: string) => {
  const lines = run.split('\n').map((l) => l.trim()).filter(Boolean);
  return isAuthTokenWriter(run) && lines.every((l) => isAuthTokenWriter(l) || /^(echo|cat|npm config|printf)\b.*registry/.test(l));
};

const MIGRATION_STEP = (st: Obj) =>
  /^actions\/setup-node@/i.test(String(st.uses ?? '')) ||
  /^npm install -g npm@/.test(String(st.run ?? '')) ||
  (typeof st.run === 'string' && isTokenOnlyScript(st.run));
const BUMPED = /^(changesets\/action|js-devtools\/npm-publish)@/i;

function normalizeStep(st: unknown): unknown {
  if (!isObj(st)) return st;
  const out: Obj = { ...st, env: stripEnv(st.env) };
  const uses = String(st.uses ?? '');
  if (BUMPED.test(uses)) {
    out.uses = uses.replace(/@.*/, '');
    if (isObj(st.with)) {
      const w = { ...st.with };
      delete w.token;
      out.with = Object.keys(w).length > 0 ? w : undefined;
    }
  }
  if (typeof st.run === 'string') out.run = st.run.split('\n').filter((l) => !isAuthTokenWriter(l)).join('\n').trim();
  return clean(out);
}

export function normalize(doc: unknown): unknown {
  if (!isObj(doc)) return doc;
  const root: Obj = { ...doc, permissions: undefined, env: stripEnv(doc.env) };
  if (isObj(root.jobs)) {
    const jobs: Obj = {};
    for (const [id, job] of Object.entries(root.jobs)) {
      if (!isObj(job) || !Array.isArray(job.steps)) {
        jobs[id] = job;
        continue;
      }
      const steps = job.steps.filter((st) => !(isObj(st) && MIGRATION_STEP(st))).map(normalizeStep);
      jobs[id] = clean({ ...job, permissions: undefined, env: stripEnv(job.env), steps });
    }
    root.jobs = jobs;
  }
  return clean(root);
}
