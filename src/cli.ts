import { resolve } from 'node:path';
import { applyPlan, buildPlan, checkNpmOptions, UsageError, type Plan } from './plan.ts';
import { formatPlan } from './report.ts';

const VERSION = process.env.GO_TOKENLESS_VERSION ?? '0.0.0-dev';

const HELP = `go-tokenless: switch npm publishing in GitHub Actions to trusted publishing (no NPM_TOKEN).

Usage:
  npx go-tokenless [plan]     Show what would change (default; writes nothing)
  npx go-tokenless apply      Rewrite the workflows and package.json files
  npx go-tokenless mcp        Run as an MCP server over stdio (for AI agents)

Options:
  --json          Machine-readable output (the full plan)
  --diff          Include a unified diff in text output
  --repo o/r      GitHub owner/repo (default: from git remote "origin")
  --cwd <dir>     Repository root (default: current directory)
  --offline       Skip npm registry lookups
  --npm-version <range>
                  npm version for the inserted upgrade step (default ^12).
                  Other versions may break publishing; a warning is shown.
  --read-token <SECRET>
                  Give install steps (npm ci, pnpm install, ...) a read-only npm token
                  from this secret, for private packages. Publish steps stay tokenless.
  --npm-args "<args>"
                  Extra arguments added to every npm command it generates
                  (the upgrade step and the npm trust commands), e.g. "--registry=https://registry.npmjs.org"
  -h, --help      Show this help
  -v, --version   Show the version

Exit codes: 0 ok, 1 blocked (errors to fix by hand), 2 usage error, 3 unexpected error.
Docs: https://github.com/Continuous-Actions/go-tokenless`;

export async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  const flag = (name: string) => {
    const i = args.indexOf(name);
    if (i < 0) return false;
    args.splice(i, 1);
    return true;
  };
  const value = (name: string) => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    if (v === undefined || (v.startsWith('--') && name !== '--npm-args')) throw new UsageError(`${name} needs a value`);
    args.splice(i, 2);
    return v;
  };
  if (flag('-h') || flag('--help')) { console.log(HELP); return 0; }
  if (flag('-v') || flag('--version')) { console.log(VERSION); return 0; }
  const json = flag('--json');
  const diff = flag('--diff');
  const offline = flag('--offline');
  const repo = value('--repo');
  const npmVersion = value('--npm-version');
  const npmArgs = value('--npm-args');
  const readToken = value('--read-token');
  const cwd = resolve(value('--cwd') ?? '.');
  const command = args.shift() ?? 'plan';
  if (args.length > 0) { console.error(`Unknown argument: ${args[0]}\n\n${HELP}`); return 2; }
  if (repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(repo)) { console.error('--repo must look like owner/repo'); return 2; }

  try {
    checkNpmOptions({ npmVersion, npmArgs, readToken });
  } catch (e) {
    console.error(String((e as Error).message));
    return 2;
  }
  if (command === 'mcp') {
    const { serve } = await import('./mcp.ts');
    serve(VERSION);
    return -1; // keep running
  }
  let plan: Plan;
  if (command === 'plan') plan = (await buildPlan(cwd, { repo, offline, npmVersion, npmArgs, readToken })).plan;
  else if (command === 'apply') plan = await applyPlan(cwd, { repo, offline, npmVersion, npmArgs, readToken });
  else { console.error(`Unknown command: ${command}\n\n${HELP}`); return 2; }

  console.log(json ? JSON.stringify(plan, null, 2) : formatPlan(plan, { diff: diff || command === 'plan' }));
  return plan.status === 'blocked' ? 1 : 0;
}

main(process.argv.slice(2)).then(
  (code) => { if (code >= 0) process.exitCode = code; },
  (err) => { console.error(`go-tokenless: ${err instanceof Error ? err.message : String(err)}`); process.exitCode = err instanceof UsageError ? 2 : 3; },
);
