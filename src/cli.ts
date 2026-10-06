import { resolve } from 'node:path';
import { applyPlan, buildPlan, type Plan } from './plan.ts';
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
  -h, --help      Show this help
  -v, --version   Show the version

Exit codes: 0 ok, 1 blocked (errors to fix by hand), 2 usage error.
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
    args.splice(i, 2);
    return v;
  };
  if (flag('-h') || flag('--help')) { console.log(HELP); return 0; }
  if (flag('-v') || flag('--version')) { console.log(VERSION); return 0; }
  const json = flag('--json');
  const diff = flag('--diff');
  const offline = flag('--offline');
  const repo = value('--repo');
  const cwd = resolve(value('--cwd') ?? '.');
  const command = args.shift() ?? 'plan';
  if (args.length > 0) { console.error(`Unknown argument: ${args[0]}\n\n${HELP}`); return 2; }
  if (repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(repo)) { console.error('--repo must look like owner/repo'); return 2; }

  if (command === 'mcp') {
    const { serve } = await import('./mcp.ts');
    serve(VERSION);
    return -1; // keep running
  }
  let plan: Plan;
  if (command === 'plan') plan = (await buildPlan(cwd, { repo, offline })).plan;
  else if (command === 'apply') plan = await applyPlan(cwd, { repo, offline });
  else { console.error(`Unknown command: ${command}\n\n${HELP}`); return 2; }

  console.log(json ? JSON.stringify(plan, null, 2) : formatPlan(plan, { diff: diff || command === 'plan' }));
  return plan.status === 'blocked' ? 1 : 0;
}

main(process.argv.slice(2)).then(
  (code) => { if (code >= 0) process.exitCode = code; },
  (err) => { console.error(`go-tokenless: ${err instanceof Error ? err.message : String(err)}`); process.exitCode = 2; },
);
