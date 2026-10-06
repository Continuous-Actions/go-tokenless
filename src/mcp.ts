// MCP server: lets coding agents plan and apply the migration with structured results.

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { applyPlan, buildPlan, type Plan } from './plan.ts';
import { formatPlan } from './report.ts';

const input = z.object({
  path: z.string().refine((p) => isAbsolute(p), 'path must be an absolute path to the repository root').describe('Absolute path to the repository root.'),
  repo: z.string().optional().describe('GitHub owner/repo, if the git remote is not "origin".'),
  offline: z.boolean().optional().describe('Skip npm registry lookups.'),
  npmVersion: z.string().optional().describe('npm version range for the inserted upgrade step. Default ^12; other versions may break publishing.'),
  npmArgs: z.string().optional().describe('Extra arguments appended to the npm commands it generates.'),
  readToken: z.string().optional().describe('Secret name (e.g. NPM_READ_TOKEN) of a read-only npm token to give install steps, for private org packages. Publish steps stay tokenless.'),
});

const result = (plan: Plan) => ({
  content: [{ type: 'text' as const, text: formatPlan(plan, { diff: true }) }],
  structuredContent: plan as unknown as Record<string, unknown>,
});

export function serve(version: string) {
  serveStdio(() => {
    const server = new McpServer({ name: 'go-tokenless', version });
    server.registerTool('plan_trusted_publishing', {
      title: 'Plan npm trusted publishing migration',
      description:
        'Read-only. Finds GitHub Actions workflows that publish to npm with a token (NPM_TOKEN / NODE_AUTH_TOKEN) and returns the exact changes needed to switch to npm trusted publishing (OIDC): workflow diff, package.json repository fixes, `npm trust github` commands, and the remaining human steps. Use before apply_trusted_publishing.',
      inputSchema: input,
      annotations: { readOnlyHint: true, openWorldHint: true },
    }, async ({ path, repo, offline, npmVersion, npmArgs, readToken }) => result((await buildPlan(resolve(path), { repo, offline, npmVersion, npmArgs, readToken })).plan));
    server.registerTool('apply_trusted_publishing', {
      title: 'Apply npm trusted publishing migration',
      description:
        'Writes the workflow and package.json changes from plan_trusted_publishing to disk (no git commit, no network writes). Returns the plan with status "applied" and the steps the user must still do with npm 2FA (npm trust commands, deleting the NPM_TOKEN secret).',
      inputSchema: input,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    }, async ({ path, repo, offline, npmVersion, npmArgs, readToken }) => result(await applyPlan(resolve(path), { repo, offline, npmVersion, npmArgs, readToken })));
    return server;
  });
}
