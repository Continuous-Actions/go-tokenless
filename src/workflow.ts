// Finds jobs that publish to npm in a GitHub Actions workflow and works out the
// text edits that move them from a stored token to trusted publishing (OIDC).

import { parseDocument, isMap, isSeq, type Node, type Pair, type YAMLMap, type YAMLSeq } from 'yaml';
import {
  Source, addPair, applyEdits, deletePair, get, getPair, indentUnit, insertStepBefore, str, type TextEdit,
} from './edits.ts';
import type { Finding } from './types.ts';

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
  /** Patched file text; equal to the input when nothing changes. */
  after: string;
};

export type ScriptLookup = (name: string) => string | undefined;

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

const RUN_PATTERNS: Array<[RegExp, PublishTool]> = [
  [/\bnpm\s+(?:[\w-]+\s+)*?publish\b/, 'npm'],
  [/\bpnpm\s+(?:-r\s+|--recursive\s+|--filter\s+\S+\s+)*publish\b/, 'pnpm'],
  [/\byarn\s+(?:workspaces\s+foreach\s+[^\n]*?)?npm\s+publish\b|\byarn\s+publish\b/, 'yarn'],
  [/\bbun\s+publish\b/, 'bun'],
  [/\bchangeset\s+publish\b/, 'changesets'],
  [/\bsemantic-release\b/, 'semantic-release'],
  [/\blerna\s+publish\b/, 'lerna'],
  [/\brelease-it\b/, 'release-it'],
  [/\bnpx\s+np\b|(?:^|\s)np\s+(?:--yolo|--no-|patch|minor|major|\d)/, 'np'],
  [/\bnx\s+release(?:\s+publish)?\b/, 'nx'],
];

/** Publishing tools a shell snippet invokes, following `npm run x` / `yarn x` one level into package.json scripts. */
export function toolsInRun(run: string, scripts: ScriptLookup, depth = 0): PublishTool[] {
  const out = new Set<PublishTool>();
  for (const [re, tool] of RUN_PATTERNS) if (re.test(run)) out.add(tool);
  if (depth < 2) {
    for (const m of run.matchAll(/\b(?:npm\s+run|pnpm(?:\s+run)?|yarn(?:\s+run)?|bun\s+run)\s+([\w:.-]+)/g)) {
      const body = scripts(m[1]!);
      if (body) for (const t of toolsInRun(body, scripts, depth + 1)) out.add(t);
    }
  }
  return [...out];
}

function stepTools(step: YAMLMap, scripts: ScriptLookup): PublishTool[] {
  const uses = str(get(step, 'uses'))?.toLowerCase() ?? '';
  const out = new Set<PublishTool>();
  if (uses.startsWith('changesets/action')) {
    const publish = str(get(get(step, 'with'), 'publish'));
    if (publish) { out.add('changesets'); for (const t of toolsInRun(publish, scripts)) out.add(t); }
  }
  if (uses.startsWith('js-devtools/npm-publish')) out.add('npm-publish-action');
  if (uses.startsWith('cycjimmy/semantic-release-action')) out.add('semantic-release');
  const run = str(get(step, 'run'));
  if (run) for (const t of toolsInRun(run, scripts)) out.add(t);
  return [...out];
}

/** A token value: a secret reference, or a blank string (which also breaks OIDC). */
const usesSecret = (v: unknown) => /\$\{\{\s*secrets\./.test(str(v) ?? '') || (str(v) ?? 'x').trim() === '';
const isAuthTokenWriter = (run: string) => /_authToken|npm\s+config\s+set\s+[^\n]*:_auth/.test(run);

function majorOf(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const m = v.match(/^\s*v?(\d+)/);
  if (m) return Number(m[1]);
  if (/^lts\/\*|^latest$|^current$|^node$/.test(v.trim())) return 24;
  return undefined;
}

function planOnce(file: string, text: string, scripts: ScriptLookup, callers: string[], npm: NpmOptions): WorkflowPlan {
  const findings: Finding[] = [];
  const changes: string[] = [];
  const name = file.split('/').pop()!;
  const secrets = new Set<string>();
  const empty: WorkflowPlan = { file, trustFile: name, reusable: false, jobs: [], findings, changes, secrets: [], after: text };
  let doc;
  try {
    doc = parseDocument(text);
  } catch {
    return empty;
  }
  if (doc.errors.length > 0 || !isMap(doc.contents)) return empty;
  const src = new Source(text);
  const unit = indentUnit(doc, src);
  const root = doc.contents as YAMLMap;
  const on = get(root, 'on') ?? get(root, true as any);
  const reusable = isMap(on) ? getPair(on, 'workflow_call') !== undefined : str(on) === 'workflow_call' || (isSeq(on) && on.items.some((i) => str(i) === 'workflow_call'));
  const jobsMap = get(root, 'jobs');
  if (!isMap(jobsMap)) return { ...empty, reusable };
  const edits: TextEdit[] = [];
  const lineOf = (n: Node) => src.lineOf(n.range![0]) + 1;
  const jobs: JobPlan[] = [];
  const add = (f: Omit<Finding, 'file'>) => findings.push({ file, ...f });
  const noteSecret = (v: unknown) => { for (const m of (str(v) ?? '').matchAll(/secrets\.([\w-]+)/g)) secrets.add(m[1]!); };

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
    const publishSteps = stepMaps.map((s) => ({ s, tools: stepTools(s, scripts) })).filter((x) => x.tools.length > 0);
    if (publishSteps.length === 0) continue;
    const tools = [...new Set(publishSteps.flatMap((x) => x.tools))];
    const jobLine = lineOf(jobPair.key);

    // Registry: skip jobs that publish somewhere other than npmjs.org.
    const setupNode = stepMaps.find((s) => (str(get(s, 'uses')) ?? '').toLowerCase().startsWith('actions/setup-node'));
    const registry = str(get(get(setupNode, 'with'), 'registry-url'));
    if (registry && !registry.replace(/\/+$/, '').startsWith(NPM_REGISTRY)) {
      add({ level: 'info', line: lineOf(jobPair.key), code: 'other-registry', message: `Job \`${jobId}\` publishes to ${registry}, not npmjs.org. Trusted publishing only applies to the npm registry, so it is left alone.` });
      continue;
    }

    const plan: JobPlan = { job: jobId, line: jobLine, tools, alreadyTokenless: false, blocked: false };
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
    const removeTokens = (envMap: unknown, where: string, parent?: Pair<any, any>) => {
      if (!isMap(envMap)) return 0;
      const hits = (envMap.items as Pair<any, any>[]).filter((p) => TOKEN_KEYS.has(str(p.key) ?? '') && usesSecret(p.value));
      if (hits.length === 0) return 0;
      if (envMap.flow) {
        const keep = (envMap.items as Pair<any, any>[]).filter((p) => !hits.includes(p));
        if (keep.length === 0 && parent) tokenEdits.push(deletePair(src, parent));
        else tokenEdits.push({ start: envMap.range![0], end: envMap.range![1], text: `{ ${keep.map((p) => src.text.slice((p.key as Node).range![0], (p.value as Node).range![1])).join(', ')} }` });
      } else if (hits.length === envMap.items.length && parent) {
        tokenEdits.push(deletePair(src, parent));
      } else {
        for (const h of hits) tokenEdits.push(deletePair(src, h));
      }
      for (const h of hits) noteSecret(h.value);
      for (const h of hits) changes.push(`${jobId}: remove \`${str(h.key)}\` from ${where}`);
      return hits.length;
    };
    let tokenRefs = 0;
    for (const { s } of publishSteps) {
      tokenRefs += removeTokens(get(s, 'env'), `step "${str(get(s, 'name')) ?? str(get(s, 'uses')) ?? 'run'}" env`, getPair(s, 'env'));
      const withMap = get(s, 'with');
      const tokenInput = getPair(withMap, 'token');
      if ((str(get(s, 'uses')) ?? '').toLowerCase().startsWith('js-devtools/npm-publish') && tokenInput && usesSecret(tokenInput.value)) {
        tokenEdits.push(isMap(withMap) && withMap.items.length === 1 ? deletePair(src, getPair(s, 'with')!) : deletePair(src, tokenInput));
        noteSecret(tokenInput.value);
        changes.push(`${jobId}: remove the \`token\` input from JS-DevTools/npm-publish`);
        tokenRefs++;
      }
    }
    const jobEnvRemoved = removeTokens(get(job, 'env'), 'job env', getPair(job, 'env'));
    tokenRefs += jobEnvRemoved;

    // Installs of private packages still need a (read-only) token; publishing must not have one.
    const installEdits: TextEdit[] = [];
    const publishSet = new Set(publishSteps.map((x) => x.s));
    const installSteps = stepMaps.filter((s) => isInstallRun(str(get(s, 'run')) ?? '') && !publishSet.has(s));
    for (const s of npm.readTokenSecret ? publishSteps.map((x) => x.s).filter((s) => isInstallRun(str(get(s, 'run')) ?? '')) : []) {
      add({ level: 'warning', line: lineOf(s), code: 'install-and-publish-in-one-step', message: `Job \`${jobId}\` installs and publishes in the same step. If the install needs private packages, split it into its own step so it can get a read-only token without blocking OIDC on publish.` });
    }
    if (npm.readTokenSecret) {
      const value = `\${{ secrets.${npm.readTokenSecret} }}`;
      for (const s of installSteps) {
        const env = get(s, 'env');
        if (getPair(env, 'NODE_AUTH_TOKEN')) continue; // already has one
        installEdits.push(isMap(env) ? addPair(src, env, 'NODE_AUTH_TOKEN', value, { unit }) : addPair(src, s, 'env', { NODE_AUTH_TOKEN: value }, { unit }));
        changes.push(`${jobId}: give step "${str(get(s, 'name')) ?? str(get(s, 'run'))?.split('\n')[0]}" the read-only token \`${npm.readTokenSecret}\` for private packages`);
      }
    }
    // Steps that only write a token into .npmrc are deleted; mixed scripts are flagged.
    for (const s of stepMaps) {
      const run = str(get(s, 'run'));
      if (!run || !isAuthTokenWriter(run)) continue;
      const lines = run.split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.every((l) => isAuthTokenWriter(l) || /^(echo|cat|npm config|printf)\b.*registry/.test(l))) {
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
        add({ level: 'warning', line: lineOf(permPair.key), code: 'read-all-permissions', message: `Job \`${jobId}\` uses \`permissions: read-all\`. Replace it with an explicit map that includes \`id-token: write\`.` });
      } else {
        // No job permissions: inherit the workflow's (or the repo default) and add id-token.
        const base: Record<string, string> = {};
        if (isMap(rootPerms)) for (const p of rootPerms.items as Pair<any, any>[]) base[str(p.key)!] = str(p.value)!;
        else Object.assign(base, defaultPermissions(tools));
        base['id-token'] = 'write';
        permEdits.push(addPair(src, job, 'permissions', base, { before: 'steps', unit }));
        if (!isMap(rootPerms)) add({ level: 'info', line: jobLine, code: 'permissions-added', message: `Job \`${jobId}\` had no permissions block, so one was added with ${Object.keys(base).filter((k) => k !== 'id-token').join(', ')} for ${tools.join('/')} plus \`id-token: write\`. Check it covers anything else the job does.` });
      }
      changes.push(`${jobId}: grant \`id-token: write\``);
    }

    // npm CLI version and registry-url.
    const setupEdits: TextEdit[] = [];
    const firstPublish = publishSteps[0]!.s;
    const npmBased = tools.some((t) => t !== 'yarn' && t !== 'bun');
    if (!setupNode) {
      setupEdits.push(insertStepBefore(src, firstPublish, [['uses', 'actions/setup-node@v7'], ['with', { 'node-version': '24', 'registry-url': NPM_REGISTRY }]], unit));
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
    for (const t of tools) {
      const note = TOOL_NOTES[t];
      if (note) add({ level: note.level, line: jobLine, code: `tool-${t}`, message: `Job \`${jobId}\`: ${note.message}` });
    }

    plan.alreadyTokenless = jobHasId && tokenRefs === 0 && setupEdits.length === 0 && installEdits.length === 0;
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

  // Workflow-level env tokens.
  if (jobs.length > 0 && isMap(rootEnv)) {
    const hits = (rootEnv.items as Pair<any, any>[]).filter((p) => TOKEN_KEYS.has(str(p.key) ?? '') && usesSecret(p.value));
    for (const h of hits) {
      edits.push(rootEnv.items.length === hits.length ? deletePair(src, getPair(root, 'env')!) : deletePair(src, h));
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
      return { file, trustFile, reusable, jobs, findings, changes, secrets: [...secrets], after: text };
    }
  }
  return { file, trustFile, reusable, jobs, findings, changes, secrets: [...secrets], after };
}

const ACTION_FLOORS = [
  { action: 'changesets/action', major: 2, min: 'v2', why: 'write an .npmrc from NPM_TOKEN, which blocks OIDC' },
  { action: 'js-devtools/npm-publish', major: 4, min: 'v4.1.0', why: 'require the token input' },
];

/** Tool-specific caveats reported next to the rewrite. */
const TOOL_NOTES: Partial<Record<PublishTool, { level: Finding['level']; message: string }>> = {
  yarn: { level: 'info', message: 'Yarn Berry (`yarn npm publish`) supports trusted publishing from 4.10.3. Yarn 1 `yarn publish` does not; switch that command to `npm publish`.' },
  bun: { level: 'warning', message: '`bun publish` does not support trusted publishing yet. Switch the publish command to `npm publish`.' },
  'semantic-release': { level: 'info', message: 'semantic-release needs @semantic-release/npm 13.1.0 or later (semantic-release 25+) for trusted publishing.' },
  lerna: { level: 'info', message: 'Lerna supports trusted publishing from v9; older versions fail with a 404.' },
  'release-it': { level: 'warning', message: 'release-it needs `npm.skipChecks: true` in its config, because its pre-publish auth check expects a token.' },
  np: { level: 'warning', message: '`np` is interactive and normally runs locally. Trusted publishing only applies to CI publishes.' },
};

/** A run script that installs dependencies (not a global npm upgrade). */
export function isInstallRun(run: string): boolean {
  return run.split('\n').some((l) => /^\s*(npm\s+(ci|i|install)|pnpm\s+(i|install)|yarn(\s+install)?|bun\s+install)(\s|$)/.test(l) && !/\s(-g|--global)(\s|$)/.test(l));
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
function defaultPermissions(tools: PublishTool[]): Record<string, string> {
  if (tools.includes('semantic-release')) return { contents: 'write', issues: 'write', 'pull-requests': 'write' };
  if (tools.includes('changesets') || tools.includes('release-it') || tools.includes('lerna') || tools.includes('nx')) return { contents: 'write', 'pull-requests': 'write' };
  return { contents: 'read' };
}

/**
 * Plan one workflow file. Edits that touch the same node (e.g. two keys in a
 * one-line `{ ... }` map) can't be applied together, so the file is re-planned
 * until it settles; the first pass's change list and findings describe it all.
 */
export function planWorkflow(file: string, text: string, scripts: ScriptLookup, callers: string[] = [], npm: NpmOptions = DEFAULT_NPM): WorkflowPlan {
  const first = planOnce(file, text, scripts, callers, npm);
  let after = first.after;
  for (let i = 0; i < 3 && after !== text; i++) {
    const next = planOnce(file, after, scripts, callers, npm);
    if (next.after === after || next.findings.some((f) => f.code === 'patch-failed')) break;
    after = next.after;
  }
  return { ...first, after };
}
