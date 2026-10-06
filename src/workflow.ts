// Finds jobs that publish to npm in a GitHub Actions workflow and works out the
// text edits that move them from a stored token to trusted publishing (OIDC).

import { parse as parseYaml, parseDocument, isMap, isSeq, type Node, type Pair, type YAMLMap, type YAMLSeq } from 'yaml';
import {
  Source, addPair, applyEdits, deletePair, get, getPair, indentUnit, insertStepBefore, str, type TextEdit,
} from './edits.ts';
import type { Finding } from './types.ts';
import { hasAnchors, isAuthTokenWriter, isTokenKey, isTokenOnlyScript, sameApartFromMigration } from './verify.ts';

export const NPM_REGISTRY = 'https://registry.npmjs.org';
/** Env/input names that carry an npm publish token. */
const TOKEN_KEYS = new Set(['NODE_AUTH_TOKEN', 'NPM_TOKEN', 'NPM_AUTH_TOKEN', 'NPM_CONFIG_TOKEN', 'NPM_PUBLISH_TOKEN']);

export type PublishTool =
  | 'npm' | 'pnpm' | 'yarn' | 'bun' | 'changesets' | 'semantic-release' | 'lerna' | 'release-it' | 'np' | 'nx' | 'npm-publish-action';

export type JobPlan = {
  job: string;
  line: number;
  tools: PublishTool[];
  /** GitHub environment, used as `--env` on the trusted publisher. */
  environment?: string;
  alreadyTokenless: boolean;
  blocked: boolean;
};

export type WorkflowPlan = {
  file: string;
  /** Workflow file name that npm validates (the caller, for reusable workflows). */
  trustFile: string;
  reusable: boolean;
  jobs: JobPlan[];
  findings: Finding[];
  changes: string[];
  /** Secret names the removed token references used (to delete afterwards). */
  secrets: string[];
  /** working-directory values of publish steps (repo-relative), when set. */
  publishDirs: string[];
  /** Patched file text; equal to the input when nothing changes. */
  after: string;
};

export type ScriptLookup = (name: string, dir?: string) => string | undefined;

/** npm CLI used by the inserted upgrade step. Pinned to a major: a new npm major can change publishing behaviour. */
export const DEFAULT_NPM_VERSION = '^12';
export type NpmOptions = {
  /** Version range for `npm install -g npm@<range>`. */
  npmVersion: string;
  /** Extra arguments appended to the npm commands go-tokenless generates. */
  npmArgs?: string;
  /** Secret holding a read-only npm token for install steps (private packages). */
  readTokenSecret?: string;
};
const DEFAULT_NPM: NpmOptions = { npmVersion: DEFAULT_NPM_VERSION };

/** YAML plain scalar when safe, otherwise single-quoted. */
function yamlScalar(v: string): string {
  return /^[\w@^~./=<>*|-][\w@^~./=<>*|:,"+ -]*$/.test(v) && !/\s$/.test(v) && !/: |\s#/.test(v) ? v : `'${v.replace(/'/g, "''")}'`;
}

/** Read access to the repository, used to follow scripts, Makefiles and composite actions. */
export type Repo = {
  /** A package.json script body, from the package in `dir` (repo-relative) or the root. */
  script(name: string, dir?: string): string | undefined;
  /** A repo-relative text file, or undefined (missing, outside the repo, or too large). */
  read(rel: string): string | undefined;
};
const asRepo = (r: Repo | ScriptLookup): Repo => (typeof r === 'function' ? { script: (n) => r(n), read: () => undefined } : r);

/** One shell command at a time: split on separators so patterns never scan a whole script. */
function commands(run: string): string[] {
  const out: string[] = [];
  for (const raw of run.split('\n')) {
    if (raw.length > 4000) continue; // generated blobs, not commands
    const line = raw.trim();
    if (!line || line.startsWith('#') || /^(echo|printf)\b/.test(line)) continue;
    // `$( … )` and `( … )` run commands too: treat their contents as separate commands.
    const flat = line.replace(/\$\(|`/g, ' ; ').replace(/[()]/g, ' ; ');
    for (let c of flat.split(/&&|\|\||;|\|/)) {
      c = c.trim().replace(/\s+\d?>&?\d*\S*/g, ' ').trim();
      // Shell keywords and assignments in front of the command.
      for (let prev = ''; prev !== c; ) { prev = c; c = c.replace(/^(if|then|else|elif|do|while|until|!|\{|time|exec|\w+=\S*)\s+/, ''); }
      if (c) out.push(c.replace(/["']/g, ''));
    }
  }
  return out;
}

/** Package-manager subcommands (anything else after `pnpm`/`yarn`/`bun` is a script or binary). */
const PM_COMMANDS = new Set(['install', 'i', 'add', 'remove', 'run', 'exec', 'dlx', 'publish', 'npm', 'test', 'build', 'pack', 'version', 'workspace', 'workspaces', 'why', 'up', 'upgrade', 'link', 'config', 'set', 'init', 'create', '-r', '--recursive', '--filter', '-F', '-w', '-C']);

/** Which publishing tool a single command runs, if any. Dry runs never count. */
function commandTool(cmd: string): PublishTool | undefined {
  if (/(^|\s)(--dry-run|-n)(\s|=|$)/.test(cmd)) return undefined;
  let w = cmd.replace(/^(\w+=\S*\s+)*/, '').replace(/^(npx|pnpx|pnpm\s+exec|pnpm\s+dlx|yarn\s+dlx|yarn\s+exec|bunx)\s+(-y\s+|--yes\s+)?/, '').split(/\s+/);
  // `pnpm semantic-release` / `yarn lerna publish` run a package binary.
  if (/^(pnpm|yarn|bun)$/.test(w[0] ?? '') && w[1] && !w[1].startsWith('-') && !PM_COMMANDS.has(w[1])) w = w.slice(1);
  // node_modules/.bin/semantic-release, semantic-release@19.0.5
  w[0] = (w[0] ?? '').split('/').pop()!.replace(/@[\w.^~-]*$/, '');
  const [a, b] = w;
  const has = (x: string) => w.slice(1, 12).includes(x);
  if (a === 'npm' && has('publish')) return 'npm';
  if (a === 'pnpm' && has('publish')) return 'pnpm';
  if (a === 'yarn' && (b === 'publish' || (has('npm') && has('publish')))) return 'yarn';
  if (a === 'bun' && b === 'publish') return 'bun';
  if (a === 'changeset' && b === 'publish') return 'changesets';
  if (a === 'semantic-release' || (a === 'node' && /semantic-release/.test(b ?? ''))) return 'semantic-release';
  if (a === 'lerna' && b === 'publish') return 'lerna';
  if (a === 'release-it') return 'release-it';
  if (a === 'np' && w.length > 1) return 'np';
  if (a === 'nx' && b === 'release') return 'nx';
  return undefined;
}

/**
 * Publishing tools a shell snippet runs. Follows package.json scripts (`npm run x`, `yarn x`),
 * local shell scripts (`./scripts/release.sh`, `bash scripts/x.sh`) and `make <target>`,
 * a couple of levels deep.
 */
export function toolsInRun(run: string, repo: Repo | ScriptLookup, depth = 0, dir?: string): PublishTool[] {
  const r = asRepo(repo);
  const out = new Set<PublishTool>();
  for (const cmd of commands(run)) {
    const t = commandTool(cmd);
    if (t) out.add(t);
    if (depth >= 3) continue;
    const follow = (body: string | undefined) => { if (body) for (const x of toolsInRun(body, r, depth + 1, dir)) out.add(x); };
    let m = cmd.match(/^(?:npm\s+run(?:-script)?|pnpm(?:\s+run)?|yarn(?:\s+run)?|bun\s+run)\s+([\w:.-]+)/);
    if (m) {
      const body = r.script(m[1]!, dir);
      // Unknown script named after a tool (`npm run semantic-release`): it runs that tool.
      if (body) follow(body);
      else { const t2 = commandTool(m[1]!); if (t2 && t2 !== 'np') out.add(t2); }
    }
    m = cmd.match(/^(?:(?:ba|z)?sh\s+|node\s+|\.\/)?((?:\.\/)?[\w./-]+\.(sh|bash|mjs|cjs|js))(\s|$)/);
    if (m && !m[1]!.includes('..')) {
      const body = r.read(join2(dir, m[1]!.replace(/^\.\//, '')));
      if (body && /^(m|c)?js$/.test(m[2]!)) {
        // A Node script that runs `npm publish` via child_process.
        if (/\bnpm['"`]?\s*,\s*\[\s*['"`]publish['"`]|['"`]npm\s+publish\b/.test(body)) out.add('npm');
      } else follow(body);
    }
    m = cmd.match(/^make\s+(?:-\S+\s+)*([\w.-]+)/);
    if (m) follow(makeTarget(r.read(join2(dir, 'Makefile')), m[1]!));
  }
  return [...out];
}

const join2 = (dir: string | undefined, rel: string) => (dir && dir !== '.' ? `${dir.replace(/^\.\//, '').replace(/\/+$/, '')}/${rel}` : rel);

/** The recipe lines of one Makefile target. */
function makeTarget(makefile: string | undefined, target: string): string | undefined {
  if (!makefile) return undefined;
  const lines = makefile.split('\n');
  const i = lines.findIndex((l) => l.startsWith(`${target}:`));
  if (i < 0) return undefined;
  const body: string[] = [];
  for (const l of lines.slice(i + 1)) {
    if (!l.startsWith('\t')) break;
    body.push(l.slice(1).replace(/^[@-]+/, ''));
  }
  return body.join('\n');
}

function stepTools(step: YAMLMap, repo: Repo, dir?: string): PublishTool[] {
  const uses = str(get(step, 'uses'))?.toLowerCase() ?? '';
  const out = new Set<PublishTool>();
  const add = (ts: PublishTool[]) => { for (const t of ts) out.add(t); };
  if (/^changesets\/action\/publish@/.test(uses)) out.add('changesets');
  else if (uses.startsWith('changesets/action@')) {
    const publish = str(get(get(step, 'with'), 'publish'));
    if (publish) { out.add('changesets'); add(toolsInRun(publish, repo, 0, dir)); }
  }
  if (uses.startsWith('js-devtools/npm-publish')) out.add('npm-publish-action');
  if (uses.startsWith('cycjimmy/semantic-release-action')) out.add('semantic-release');
  if (/release-it/.test(uses)) out.add('release-it');
  // Local composite action: look at the steps inside it.
  const local = str(get(step, 'uses'))?.match(/^\.\/(.+?)\/?$/)?.[1];
  if (local && !local.includes('..')) {
    const text = repo.read(`${local}/action.yml`) ?? repo.read(`${local}/action.yaml`);
    try {
      const steps = text ? (parseYaml(text) as any)?.runs?.steps : undefined;
      if (Array.isArray(steps)) for (const s of steps) if (typeof s?.run === 'string') add(toolsInRun(s.run, repo, 1, dir));
    } catch { /* not YAML */ }
  }
  const run = str(get(step, 'run'));
  if (run) add(toolsInRun(run, repo, 0, dir));
  return [...out];
}

/** A token value: a secret reference, or a blank string (which also breaks OIDC). */
const usesSecret = (v: unknown) => /\bsecrets\s*(\.|\[)/.test(str(v) ?? '') || (str(v) ?? 'x').trim() === '';
/** GitHub's own token (GitHub Packages auth), never an npmjs.org token. */
const isGithubToken = (v: unknown) => /secrets\s*(\.|\[\s*['"])GITHUB_TOKEN\b|\bgithub\.token\b/.test(str(v) ?? '');
/** Env names that carry an npm auth token (beyond the common ones in TOKEN_KEYS). */

/** actions/setup-node used when a SHA-pinned job has none (kept current by Dependabot in this repo's tests). */
const SETUP_NODE_SHA = '820762786026740c76f36085b0efc47a31fe5020';
const SETUP_NODE_TAG = 'v7.0.0';

const READ_ALL_SCOPES =['actions', 'attestations', 'checks', 'contents', 'deployments', 'discussions', 'issues', 'models', 'packages', 'pages', 'pull-requests', 'security-events', 'statuses'];

const UNTRUSTED_TRIGGERS =new Set(['pull_request_target', 'workflow_run', 'issue_comment', 'pull_request_review', 'pull_request_review_comment', 'discussion', 'discussion_comment', 'issues', 'fork', 'watch']);

/** True only for https://registry.npmjs.org (not lookalike hosts). */
export function isNpmRegistry(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.host === 'registry.npmjs.org' && !u.username && !u.password;
  } catch {
    return false;
  }
}

function majorOf(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const m = v.match(/^\s*v?(\d+)/);
  if (m) return Number(m[1]);
  if (/^lts\/\*|^latest$|^current$|^node$/.test(v.trim())) return 24;
  return undefined;
}

function planOnce(file: string, text: string, scripts: Repo | ScriptLookup, callers: string[], npm: NpmOptions): WorkflowPlan {
  const repo = asRepo(scripts);
  const findings: Finding[] = [];
  const changes: string[] = [];
  const name = file.split('/').pop()!;
  const secrets = new Set<string>();
  const publishDirs = new Set<string>();
  /** Jobs that publish to another registry: left completely alone. */
  const otherRegistryJobs = new Set<string>();
  const empty: WorkflowPlan = { file, trustFile: name, reusable: false, jobs: [], findings, changes, secrets: [], publishDirs: [], after: text };
  let doc;
  try {
    doc = parseDocument(text);
  } catch {
    return empty;
  }
  if (doc.errors.length > 0 || !isMap(doc.contents)) {
    if (doc.errors.length > 0 && /publish|NPM_TOKEN|NODE_AUTH_TOKEN/.test(text)) {
      findings.push({ file, level: 'warning', line: 1, code: 'invalid-yaml', message: `Could not parse this workflow (${doc.errors[0]!.message.split('\n')[0]}), so it was not checked. GitHub may reject it too.` });
    }
    return empty;
  }
  const src = new Source(text);
  const unit = indentUnit(doc, src);
  const root = doc.contents as YAMLMap;
  const on = get(root, 'on') ?? get(root, true as any);
  const reusable = isMap(on) ? getPair(on, 'workflow_call') !== undefined : str(on) === 'workflow_call' || (isSeq(on) && on.items.some((i) => str(i) === 'workflow_call'));
  const triggers = isMap(on) ? (on.items as Pair<any, any>[]).map((p) => str(p.key) ?? '') : isSeq(on) ? on.items.map((i) => str(i) ?? '') : [str(on) ?? ''];
  // Events a stranger can fire (fork PRs, comments, runs of other workflows). A job they
  // reach must never get id-token: write or be named as a trusted publisher.
  const untrusted = triggers.filter((t) => UNTRUSTED_TRIGGERS.has(t));
  const jobsMap = get(root, 'jobs');
  if (!isMap(jobsMap)) return { ...empty, reusable };
  const edits: TextEdit[] = [];
  const lineOf = (n: Node) => src.lineOf(n.range![0]) + 1;
  const jobs: JobPlan[] = [];
  const add = (f: Omit<Finding, 'file'>) => findings.push({ file, ...f });
  const noteSecret = (v: unknown) => { for (const m of (str(v) ?? '').matchAll(/secrets\s*(?:\.([\w-]+)|\[\s*['"]([\w-]+)['"]\s*\])/g)) secrets.add((m[1] ?? m[2])!); };

  /** Add the read-only token to install steps that don't have a NODE_AUTH_TOKEN yet. */
  const giveReadToken = (jobId: string, installSteps: YAMLMap[]): TextEdit[] => {
    const value = `\${{ secrets.${npm.readTokenSecret} }}`;
    const out: TextEdit[] = [];
    for (const s of installSteps) {
      const env = get(s, 'env');
      if (getPair(env, 'NODE_AUTH_TOKEN')) continue; // already has one
      out.push(isMap(env) ? addPair(src, env, 'NODE_AUTH_TOKEN', value, { unit }) : addPair(src, s, 'env', { NODE_AUTH_TOKEN: value }, { unit }));
      changes.push(`${jobId}: give step "${str(get(s, 'name')) ?? str(get(s, 'run'))?.split('\n')[0]}" the read-only token \`${npm.readTokenSecret}\` for private packages`);
    }
    return out;
  };

  // Workflow-level env tokens are removed only when every job using them publishes.
  const rootEnv = get(root, 'env');
  const rootPerms = get(root, 'permissions');

  for (const jobPair of (jobsMap as YAMLMap).items as Pair<any, any>[]) {
    const jobId = str(jobPair.key)!;
    const job = jobPair.value as YAMLMap;
    if (!isMap(job)) continue;
    if (get(job, 'uses')) continue; // calls a reusable workflow; that file is planned on its own
    const steps = get(job, 'steps') as YAMLSeq | undefined;
    if (!isSeq(steps)) continue;
    const stepMaps = steps.items.filter(isMap) as YAMLMap[];
    const jobDir = str(get(get(get(job, 'defaults'), 'run'), 'working-directory'));
    const dirOf = (s: YAMLMap) => str(get(s, 'working-directory')) ?? jobDir;
    const publishSteps = stepMaps.map((s) => ({ s, tools: stepTools(s, repo, dirOf(s)) })).filter((x) => x.tools.length > 0);
    for (const { s } of publishSteps) {
      const d = dirOf(s);
      if (d && !d.includes('${{')) publishDirs.add(d.replace(/^\.\//, '').replace(/\/+$/, '') || '.');
    }
    if (publishSteps.length === 0) continue;
    const tools = [...new Set(publishSteps.flatMap((x) => x.tools))];
    const jobLine = lineOf(jobPair.key);

    // Registry: skip jobs that publish somewhere other than npmjs.org.
    const setupNode = stepMaps.find((s) => (str(get(s, 'uses')) ?? '').toLowerCase().startsWith('actions/setup-node'));
    const registry = str(get(get(setupNode, 'with'), 'registry-url'));
    if (registry && !isNpmRegistry(registry)) {
      otherRegistryJobs.add(jobId);
      add({ level: 'info', line: lineOf(jobPair.key), code: 'other-registry', message: `Job \`${jobId}\` publishes to ${registry}, not npmjs.org. Trusted publishing only applies to the npm registry, so it is left alone.` });
      continue;
    }

    const plan: JobPlan = { job: jobId, line: jobLine, tools, alreadyTokenless: false, blocked: false };
    if (untrusted.length > 0) {
      add({ level: 'error', line: jobLine, code: 'untrusted-trigger', message: `Job \`${jobId}\` publishes in a workflow triggered by ${untrusted.map((t) => `\`${t}\``).join(', ')}, which people outside the repo can start. Giving it \`id-token: write\` or a trusted publisher would let them publish. Move publishing to a workflow that runs on \`release\`, \`push\` to a tag or branch, or \`workflow_dispatch\`.` });
      plan.blocked = true;
      jobs.push(plan);
      continue;
    }
    if (triggers.includes('pull_request')) {
      add({ level: 'warning', line: jobLine, code: 'pull-request-trigger', message: `Job \`${jobId}\` publishes in a workflow that also runs on \`pull_request\`. Make sure the publish step only runs for pushes or releases (for example \`if: github.event_name != 'pull_request'\`).` });
    }
    const envNode = get(job, 'environment');
    plan.environment = str(envNode) ?? str(get(envNode, 'name'));
    if (plan.environment?.includes('${{')) {
      add({ level: 'warning', line: jobLine, code: 'dynamic-environment', message: `Job \`${jobId}\` uses a computed environment (${plan.environment}). The trusted publisher must name one fixed environment; set it by hand.` });
      plan.environment = undefined;
    }

    // Runner: trusted publishing needs GitHub-hosted runners.
    const runsOn = get(job, 'runs-on');
    const matrix = get(get(job, 'strategy'), 'matrix');
    const labels = (isSeq(runsOn) ? runsOn.items.map((i) => str(i) ?? '') : [str(runsOn) ?? str(get(runsOn, 'group')) ?? (isMap(runsOn) ? 'group' : '')])
      .flatMap((l) => matrixValues(matrix, l) ?? [l]);
    if (labels.some((l) => /self-hosted/i.test(l)) || (isMap(runsOn) && get(runsOn, 'group'))) {
      add({ level: 'error', line: jobLine, code: 'self-hosted-runner', message: `Job \`${jobId}\` runs on a self-hosted runner. npm trusted publishing only works on GitHub-hosted runners; move the publish job to \`ubuntu-latest\`.` });
      plan.blocked = true;
    } else if (labels.some((l) => l.includes('${{'))) {
      add({ level: 'warning', line: jobLine, code: 'dynamic-runner', message: `Job \`${jobId}\` picks its runner with an expression. Make sure it resolves to a GitHub-hosted runner.` });
    }

    // Token references to remove.
    const tokenEdits: TextEdit[] = [];
    const removeTokens = (envMap: unknown, where: string, parent?: Pair<any, any>, container?: YAMLMap) => {
      if (!isMap(envMap)) return 0;
      if (container?.flow) return 0; // one-line `{ ... }` step: reported below, edited by hand
      const hits = (envMap.items as Pair<any, any>[]).filter((p) => isTokenKey(str(p.key) ?? '') && usesSecret(p.value) && !isGithubToken(p.value));
      if (hits.length === 0) return 0;
      if (envMap.flow) {
        const keep = (envMap.items as Pair<any, any>[]).filter((p) => !hits.includes(p));
        if (keep.length === 0 && parent) tokenEdits.push(deletePair(src, parent, container));
        else tokenEdits.push({ start: envMap.range![0], end: envMap.range![1], text: `{ ${keep.map((p) => src.text.slice((p.key as Node).range![0], ((p.value as Node | null)?.range ?? (p.key as Node).range!)[1])).join(', ')} }` });
      } else if (hits.length === envMap.items.length && parent) {
        tokenEdits.push(deletePair(src, parent, container));
      } else {
        for (const h of hits) tokenEdits.push(deletePair(src, h));
      }
      for (const h of hits) noteSecret(h.value);
      for (const h of hits) changes.push(`${jobId}: remove \`${str(h.key)}\` from ${where}`);
      return hits.length;
    };
    let tokenRefs = 0;
    for (const { s } of publishSteps) {
      tokenRefs += removeTokens(get(s, 'env'), `step "${str(get(s, 'name')) ?? str(get(s, 'uses')) ?? 'run'}" env`, getPair(s, 'env'), s);
      if (s.flow && isMap(get(s, 'env')) && ((get(s, 'env') as YAMLMap).items as Pair<any, any>[]).some((p) => isTokenKey(str(p.key) ?? '') && usesSecret(p.value) && !isGithubToken(p.value))) {
        tokenRefs++;
        add({ level: 'warning', line: lineOf(s), code: 'one-line-step', message: `Job \`${jobId}\` passes an npm token to a one-line \`{ ... }\` step. Remove that env entry by hand.` });
      }
      const withMap = get(s, 'with');
      const tokenInput = getPair(withMap, 'token');
      if ((str(get(s, 'uses')) ?? '').toLowerCase().startsWith('js-devtools/npm-publish') && tokenInput && usesSecret(tokenInput.value)) {
        if (isMap(withMap) && withMap.flow) {
          const keep = (withMap.items as Pair<any, any>[]).filter((p) => p !== tokenInput);
          tokenEdits.push(keep.length === 0 ? deletePair(src, getPair(s, 'with')!, s) : { start: withMap.range![0], end: withMap.range![1], text: `{ ${keep.map((p) => src.text.slice((p.key as Node).range![0], ((p.value as Node | null)?.range ?? (p.key as Node).range!)[1])).join(', ')} }` });
        } else {
          tokenEdits.push(isMap(withMap) && withMap.items.length === 1 ? deletePair(src, getPair(s, 'with')!, s) : deletePair(src, tokenInput, withMap as YAMLMap));
        }
        noteSecret(tokenInput.value);
        changes.push(`${jobId}: remove the \`token\` input from JS-DevTools/npm-publish`);
        tokenRefs++;
      }
    }
    const jobEnvRemoved = removeTokens(get(job, 'env'), 'job env', getPair(job, 'env'), job);
    tokenRefs += jobEnvRemoved;

    // Installs of private packages still need a (read-only) token; publishing must not have one.
    const installEdits: TextEdit[] = [];
    const publishSet = new Set(publishSteps.map((x) => x.s));
    const installSteps = stepMaps.filter((s) => isInstallRun(str(get(s, 'run')) ?? '') && !publishSet.has(s));
    for (const s of npm.readTokenSecret ? publishSteps.map((x) => x.s).filter((s) => isInstallRun(str(get(s, 'run')) ?? '')) : []) {
      add({ level: 'warning', line: lineOf(s), code: 'install-and-publish-in-one-step', message: `Job \`${jobId}\` installs and publishes in the same step. If the install needs private packages, split it into its own step so it can get a read-only token without blocking OIDC on publish.` });
    }
    if (npm.readTokenSecret) installEdits.push(...giveReadToken(jobId, installSteps));
    // Any other step in the publish job that still receives an npm token secret (for
    // example a script that writes .npmrc) keeps token publishing alive: report it.
    for (const s of stepMaps) {
      if (publishSet.has(s) || installSteps.includes(s)) continue;
      const left = ((get(s, 'env') as YAMLMap | undefined)?.items as Pair<any, any>[] | undefined ?? []).filter((p) => isTokenKey(str(p.key) ?? '') && usesSecret(p.value) && !isGithubToken(p.value) && (str(p.value) ?? '').trim() !== '');
      for (const p of left) {
        noteSecret(p.value);
        tokenRefs++;
        add({ level: 'warning', line: lineOf(s), code: 'secret-in-publish-job', message: `Step "${str(get(s, 'name')) ?? str(get(s, 'run'))?.split('\n')[0] ?? str(get(s, 'uses'))}" in job \`${jobId}\` still gets \`${str(p.key)}\` from a secret. If it sets up npm auth, remove it; otherwise the old token keeps publishing.` });
      }
    }
    // Steps that only write a token into .npmrc are deleted; mixed scripts are flagged.
    for (const s of stepMaps) {
      const run = str(get(s, 'run'));
      if (!run || !isAuthTokenWriter(run)) continue;
      if (isTokenOnlyScript(run)) {
        tokenEdits.push(deleteSeqItem(src, steps, s));
        changes.push(`${jobId}: delete step "${str(get(s, 'name')) ?? 'write .npmrc'}" that writes an npm token to .npmrc`);
        tokenRefs++;
      } else {
        // Drop just the token-writing lines from a block script (`run: |`).
        const runNode = get(s, 'run') as Node;
        const [rs, re] = runNode.range!;
        const first = src.lineOf(rs), last = src.lineOf(Math.max(rs, re - 1));
        const drop: TextEdit[] = [];
        if (/^[|>]/.test(src.text.slice(rs, rs + 2).trim()) || src.lineText(first).trimEnd().endsWith('|')) {
          for (let l = first + 1; l <= last; l++) if (isAuthTokenWriter(src.lineText(l))) drop.push({ start: src.lineStart(l), end: src.lineEnd(l), text: '' });
        }
        if (drop.length > 0) {
          tokenEdits.push(...drop);
          changes.push(`${jobId}: remove the line${drop.length > 1 ? 's' : ''} that write${drop.length > 1 ? '' : 's'} an npm token in step "${str(get(s, 'name')) ?? 'run'}"`);
          tokenRefs++;
        } else {
          add({ level: 'warning', line: lineOf(s), code: 'npmrc-token-script', message: `Job \`${jobId}\` writes an npm auth token in a run script. Remove those lines by hand; with trusted publishing a stale \`_authToken\` makes npm skip OIDC.` });
        }
      }
    }

    // Permissions.
    const permPair = getPair(job, 'permissions');
    const perms = permPair?.value;
    const hasIdToken = (m: unknown) => (isMap(m) && str(get(m, 'id-token')) === 'write') || str(m) === 'write-all';
    const jobHasId = permPair ? hasIdToken(perms) : hasIdToken(rootPerms);
    const permEdits: TextEdit[] = [];
    if (!jobHasId) {
      if (permPair && isMap(perms)) {
        const existing = getPair(perms, 'id-token');
        permEdits.push(existing ? { start: (existing.value as Node).range![0], end: (existing.value as Node).range![1], text: 'write' } : addPair(src, perms, 'id-token', 'write', { unit }));
      } else if (permPair && str(perms) === 'read-all') {
        // Keep read-all's meaning: every scope read-only, plus id-token.
        const node = perms as Node;
        permEdits.push({ start: node.range![0], end: node.range![1], text: `{ ${[...READ_ALL_SCOPES.map((k) => `${k}: read`), 'id-token: write'].join(', ')} }` });
      } else {
        // No job permissions: inherit the workflow's (or the repo default) and add id-token.
        const base: Record<string, string> = {};
        if (isMap(rootPerms)) for (const p of rootPerms.items as Pair<any, any>[]) base[str(p.key)!] = str(p.value)!;
        else if (str(rootPerms) === 'read-all') for (const k of READ_ALL_SCOPES) base[k] = 'read';
        else Object.assign(base, defaultPermissions(tools, stepMaps));
        base['id-token'] = 'write';
        permEdits.push(addPair(src, job, 'permissions', base, { before: 'steps', unit }));
        if (rootPerms === undefined && Object.values(base).filter((v) => v === 'write').length > 1) {
          add({ level: 'warning', line: jobLine, code: 'permissions-added', message: `Job \`${jobId}\` had no permissions block, so it ran with the repository's default token permissions. One was added with ${Object.entries(base).filter(([k]) => k !== 'id-token').map(([k, v]) => `${k}: ${v}`).join(', ')}, which ${tools.join('/')} normally needs, plus \`id-token: write\`. Remove any write scope the job does not use.` });
        }
      }
      changes.push(`${jobId}: grant \`id-token: write\``);
    }

    // npm CLI version and registry-url.
    const setupEdits: TextEdit[] = [];
    const firstPublish = publishSteps[0]!.s;
    const npmBased = tools.some((t) => t !== 'yarn' && t !== 'bun');
    // A job that already requests OIDC and passes no token is migrated: leave its setup alone.
    const migrated = jobHasId && tokenRefs === 0;
    if (!migrated) {
    if (!setupNode) {
      // Match the job's pinning style: SHA-pinned jobs get a SHA-pinned setup-node.
      const pinned = stepMaps.some((s) => /@[0-9a-f]{40}\b/i.test(str(get(s, 'uses')) ?? ''));
      const setupRef = pinned ? `actions/setup-node@${SETUP_NODE_SHA} # ${SETUP_NODE_TAG}` : 'actions/setup-node@v7';
      setupEdits.push(insertStepBefore(src, firstPublish, [['uses', setupRef], ['with', { 'node-version': '24', 'registry-url': NPM_REGISTRY }]], unit));
      changes.push(`${jobId}: add actions/setup-node (Node 24, npm registry)`);
    } else {
      const withPair = getPair(setupNode, 'with');
      if (!registry) {
        setupEdits.push(isMap(withPair?.value) ? addPair(src, withPair!.value, 'registry-url', NPM_REGISTRY, { unit }) : addPair(src, setupNode, 'with', { 'registry-url': NPM_REGISTRY }, { unit }));
        changes.push(`${jobId}: set \`registry-url\` on actions/setup-node`);
      }
      const versionNode = get(withPair?.value, 'node-version') as Node | undefined;
      const nodeVersion = str(versionNode);
      let major = majorOf(nodeVersion);
      if (major !== undefined && major < 22 && versionNode?.range) {
        // Trusted publishing needs Node 22.14+; Node 24 also ships a new enough npm.
        setupEdits.push({ start: versionNode.range[0], end: versionNode.range[1], text: "'24'" });
        changes.push(`${jobId}: raise setup-node from Node ${nodeVersion} to 24 (trusted publishing needs Node 22.14+)`);
        major = 24;
      } else if (major === undefined && nodeVersion?.includes('${{')) {
        const values = matrixValues(matrix, nodeVersion);
        const majors = values?.map(majorOf);
        if (majors && majors.every((m) => m !== undefined)) {
          major = Math.min(...(majors as number[]));
          if (major < 22) add({ level: 'warning', line: lineOf(setupNode), code: 'matrix-node-version', message: `Job \`${jobId}\` runs on Node ${values!.join(', ')} from its matrix. Make sure the leg that publishes uses Node 22.14+ (24 recommended).` });
        } else {
          add({ level: 'warning', line: lineOf(setupNode), code: 'dynamic-node-version', message: `Job \`${jobId}\` picks its Node version with an expression (${nodeVersion}). Trusted publishing needs Node 22.14+ in the publishing run.` });
        }
      }
      const hasNpmUpgrade = stepMaps.some((s) => /npm\s+(i|install)\s+(-g|--global)\s+npm/.test(str(get(s, 'run')) ?? ''));
      if (npmBased && (major === undefined || major < 24) && !hasNpmUpgrade) {
        setupEdits.push(insertStepBefore(src, firstPublish, [['name', 'Use an npm version that supports trusted publishing'], ['run', yamlScalar(`npm install -g npm@${npm.npmVersion}${npm.npmArgs ? ` ${npm.npmArgs}` : ''}`)]], unit));
        changes.push(`${jobId}: install npm@${npm.npmVersion} before publishing (trusted publishing needs npm 11.5.1+; ${nodeVersion && !nodeVersion.includes('${{') ? `Node ${nodeVersion} ships` : 'this Node version may ship'} an older npm)`);
        const exact = nodeVersion?.match(/^v?22\.(\d+)/);
        if (exact && Number(exact[1]) < 22 && /^\^?12(\.|$)/.test(npm.npmVersion)) {
          add({ level: 'warning', line: lineOf(setupNode), code: 'node-too-old-for-npm-12', message: `Job \`${jobId}\` pins Node ${nodeVersion}, but npm 12 needs Node 22.22.2+. Use node-version 22 or 24, or pass --npm-version ^11.5.1.` });
        }
      }
    }

    // Actions that need a newer major for trusted publishing.
    for (const { s } of publishSteps) {
      const usesNode = get(s, 'uses') as Node | undefined;
      const uses = str(usesNode) ?? '';
      const floor = ACTION_FLOORS.find((a) => uses.toLowerCase().startsWith(`${a.action}@`));
      if (!floor || !usesNode?.range) continue;
      const ref = uses.slice(uses.indexOf('@') + 1);
      const m = ref.match(/^v?(\d+)/);
      if (/^[0-9a-f]{40}$/i.test(ref)) {
        add({ level: 'warning', line: lineOf(usesNode), code: 'pinned-action-version', message: `${floor.action} is pinned to a commit. Make sure it is ${floor.min} or later; older versions ${floor.why}.` });
      } else if (m && Number(m[1]) < floor.major) {
        const raw = src.text.slice(usesNode.range[0], usesNode.range[1]);
        setupEdits.push({ start: usesNode.range[0], end: usesNode.range[1], text: raw.replace(`@${ref}`, `@v${floor.major}`) });
        changes.push(`${jobId}: update ${floor.action} from ${ref} to v${floor.major} (older versions ${floor.why})`);
      }
    }
    }
    for (const t of tools) {
      const note = TOOL_NOTES[t];
      if (note) add({ level: note.level, line: jobLine, code: `tool-${t}`, message: `Job \`${jobId}\`: ${note.message}` });
    }

    plan.alreadyTokenless = migrated && installEdits.length === 0;
    if (plan.alreadyTokenless) {
      add({ level: 'ok', line: jobLine, code: 'already-tokenless', message: `Job \`${jobId}\` already publishes with trusted publishing.` });
    } else if (!plan.blocked) {
      edits.push(...tokenEdits, ...permEdits, ...setupEdits, ...installEdits);
    }
    if (tokenRefs === 0 && !plan.alreadyTokenless && !jobHasId) {
      add({ level: 'info', line: jobLine, code: 'no-token-found', message: `Job \`${jobId}\` publishes but no npm token reference was found in the workflow. It may come from a repo-level .npmrc or an outer script.` });
    }
    jobs.push(plan);
  }

  // Build and test jobs in the same workflow install private packages too.
  const active = jobs.some((j) => !j.blocked);
  // Never in workflows outsiders can start (those are blocked above anyway).
  if (npm.readTokenSecret && active && untrusted.length === 0) {
    const done = new Set(jobs.map((j) => j.job));
    const given: string[] = [];
    for (const jobPair of (jobsMap as YAMLMap).items as Pair<any, any>[]) {
      const id = str(jobPair.key)!;
      const steps = get(jobPair.value, 'steps');
      if (done.has(id) || otherRegistryJobs.has(id) || !isSeq(steps)) continue;
      const e = giveReadToken(id, (steps.items.filter(isMap) as YAMLMap[]).filter((s) => isInstallRun(str(get(s, 'run')) ?? '')));
      if (e.length > 0) given.push(id);
      edits.push(...e);
    }
    if (given.length > 0) {
      const pr = triggers.includes('pull_request') ? ' The workflow also runs on `pull_request`: pull requests from branches in this repo get the token too (forks never do).' : '';
      add({ level: 'info', line: 1, code: 'read-token-jobs', message: `The read-only token \`${npm.readTokenSecret}\` was also given to install steps in ${given.map((g) => `\`${g}\``).join(', ')}.${pr}` });
    }
  }

  // Workflow-level env tokens.
  if (active && isMap(rootEnv)) {
    const hits = (rootEnv.items as Pair<any, any>[]).filter((p) => isTokenKey(str(p.key) ?? '') && usesSecret(p.value) && !isGithubToken(p.value));
    const keep = (rootEnv.items as Pair<any, any>[]).filter((p) => !hits.includes(p));
    if (hits.length > 0 && rootEnv.flow && keep.length > 0) {
      edits.push({ start: rootEnv.range![0], end: rootEnv.range![1], text: `{ ${keep.map((p) => src.text.slice((p.key as Node).range![0], ((p.value as Node | null)?.range ?? (p.key as Node).range!)[1])).join(', ')} }` });
    }
    for (const h of hits) {
      if (keep.length === 0) edits.push(deletePair(src, getPair(root, 'env')!, root));
      else if (!rootEnv.flow) edits.push(deletePair(src, h, rootEnv as YAMLMap));
      noteSecret(h.value);
      changes.push(`workflow: remove \`${str(h.key)}\` from top-level env`);
    }
  }

  const trustFile = reusable && callers.length > 0 ? callers[0]!.split('/').pop()! : name;
  if (reusable && jobs.length > 0) {
    add({
      level: 'warning', line: 1, code: 'reusable-workflow',
      message: callers.length > 0
        ? `This is a reusable workflow. npm checks the *calling* workflow's file name, so the trusted publisher must name ${callers.map((c) => `\`${c.split('/').pop()}\``).join(' or ')}, and the caller must also grant \`id-token: write\`.`
        : 'This is a reusable workflow but no caller was found in this repo. npm checks the calling workflow\'s file name; set the trusted publisher to that file.',
    });
  }

  const after = edits.length > 0 ? applyEdits(text, dedupe(edits)) : text;
  if (after !== text) {
    const check = parseDocument(after);
    if (check.errors.length > 0) {
      add({ level: 'error', line: 1, code: 'patch-failed', message: `Could not patch this file safely (${check.errors[0]!.message.split('\n')[0]}). Apply the listed changes by hand.` });
      return { file, trustFile, reusable, jobs, findings, changes, secrets: [...secrets], publishDirs: [...publishDirs], after: text };
    }
  }
  return { file, trustFile, reusable, jobs, findings, changes, secrets: [...secrets], publishDirs: [...publishDirs], after };
}

const ACTION_FLOORS = [
  { action: 'js-devtools/npm-publish', major: 4, min: 'v4.1.0', why: 'require the token input' },
];

/** Tool-specific caveats reported next to the rewrite. */
const TOOL_NOTES: Partial<Record<PublishTool, { level: Finding['level']; message: string }>> = {
  yarn: { level: 'info', message: 'Yarn Berry (`yarn npm publish`) supports trusted publishing from 4.10.3. Yarn 1 `yarn publish` does not; switch that command to `npm publish`.' },
  bun: { level: 'warning', message: '`bun publish` does not support trusted publishing yet. Switch the publish command to `npm publish`.' },
  'semantic-release': { level: 'info', message: 'semantic-release needs @semantic-release/npm 13.1.0 or later (semantic-release 25+) for trusted publishing.' },
  changesets: { level: 'info', message: 'changesets/action publishes with trusted publishing once NPM_TOKEN is gone. If the first tokenless release fails to authenticate, update it to changesets/action@v2.' },
  lerna: { level: 'info', message: 'Lerna supports trusted publishing from v9; older versions fail with a 404.' },
  'release-it': { level: 'warning', message: 'release-it needs `npm.skipChecks: true` in its config, because its pre-publish auth check expects a token.' },
  np: { level: 'warning', message: '`np` is interactive and normally runs locally. Trusted publishing only applies to CI publishes.' },
};

/** A run script that installs dependencies (not a global npm upgrade). */
export function isInstallRun(run: string): boolean {
  // Bare `yarn` installs, but `yarn build` does not: after `yarn`/`yarn install` only flags may follow.
  const yarn = /^\s*yarn(\s+install)?(\s+-[\w-]+(=\S+)?)*\s*($|&&|;|\|)/;
  const other = /^\s*(npm\s+(ci|i|install)|pnpm\s+(i|install)|bun\s+install)(\s|$)/;
  return run.split('\n').some((l) => (yarn.test(l) || other.test(l)) && !/\s(-g|--global)(\s|$)/.test(l));
}

/** Static values for a `${{ matrix.key }}` expression, when the matrix lists them. */
function matrixValues(matrix: unknown, expr: string): string[] | undefined {
  const m = expr.match(/^\$\{\{\s*matrix\.([\w-]+)\s*\}\}$/);
  if (!m || !isMap(matrix)) return undefined;
  const v = get(matrix, m[1]!);
  if (isSeq(v)) {
    const vals = v.items.map((i) => str(i));
    return vals.every((x) => x !== undefined) ? (vals as string[]) : undefined;
  }
  const one = str(v);
  return one === undefined ? undefined : [one];
}

function dedupe(edits: TextEdit[]): TextEdit[] {
  const seen = new Set<string>();
  return edits.filter((e) => {
    const k = `${e.start}:${e.end}:${e.text}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function deleteSeqItem(src: Source, seq: YAMLSeq, item: Node): TextEdit {
  const idx = seq.items.indexOf(item as any);
  const start = src.lineStart(src.lineOf(item.range![0]));
  const next = seq.items[idx + 1] as Node | undefined;
  const end = next ? src.lineStart(src.lineOf(next.range![0])) : src.lineEnd(src.lineOf(item.range![1] - 1));
  return { start, end, text: '' };
}

/** Permissions a release job typically needs when the workflow declared none. */
function defaultPermissions(tools: PublishTool[], steps: YAMLMap[]): Record<string, string> {
  if (tools.includes('semantic-release')) return { contents: 'write', issues: 'write', 'pull-requests': 'write' };
  if (tools.includes('changesets') || tools.includes('release-it') || tools.includes('lerna') || tools.includes('nx')) return { contents: 'write', 'pull-requests': 'write' };
  // Steps that create GitHub releases, tags or commits need to write contents.
  const writes = steps.some((s) =>
    /(softprops\/action-gh-release|actions\/create-release|ncipollo\/release-action|release-please-action|git-auto-commit-action|github-push-action|actions\/upload-release-asset)/i.test(str(get(s, 'uses')) ?? '') ||
    /\bgit\s+(push|tag)\b|\bgh\s+release\b/.test(str(get(s, 'run')) ?? ''));
  return { contents: writes ? 'write' : 'read' };
}

/**
 * Plan one workflow file. Edits that touch the same node (e.g. two keys in a
 * one-line `{ ... }` map) can't be applied together, so the file is re-planned
 * until it settles; the first pass's change list and findings describe it all.
 */
export function planWorkflow(file: string, text: string, scripts: Repo | ScriptLookup, callers: string[] = [], npm: NpmOptions = DEFAULT_NPM): WorkflowPlan {
  const first = planOnce(file, text, scripts, callers, npm);
  if (first.jobs.length > 0 && hasAnchors(text)) {
    // Anchors and merge keys share nodes between jobs, so a line edit could change other
    // jobs, and tokens can hide behind an alias. Report instead of editing.
    const findings: Finding[] = [...first.findings.filter((f) => f.level !== 'ok'), { file, line: 1, level: 'error', code: 'yaml-anchors', message: 'This workflow uses YAML anchors or aliases, which go-tokenless does not edit automatically. Make the listed changes by hand, or expand the anchors and run it again.' }];
    return { ...first, findings, jobs: first.jobs.map((j) => ({ ...j, alreadyTokenless: false, blocked: true })), after: text };
  }
  let after = first.after;
  for (let i = 0; i < 3 && after !== text; i++) {
    const next = planOnce(file, after, scripts, callers, npm);
    if (next.after === after || next.findings.some((f) => f.code === 'patch-failed')) break;
    after = next.after;
  }
  if (process.env.GT_DEBUG && after !== text) process.stderr.write(`===AFTER ${file}
${after}
`);
  if (after !== text && !sameApartFromMigration(text, after)) {
    const findings: Finding[] = [...first.findings, { file, line: 1, level: 'error', code: 'patch-failed', message: 'The automatic edit would have changed more than the migration (for example merging two steps). Nothing was written; make the listed changes by hand.' }];
    return { ...first, findings, after: text };
  }
  return { ...first, after };
}
