import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { CLI, makeRepo, pkg } from './helpers.ts';

/** Minimal JSON-RPC client over the server's stdio. */
function client() {
  const child = spawn(process.execPath, [CLI, 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const waiting = new Map<number, (v: any) => void>();
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      waiting.get(msg.id)?.(msg);
    }
  });
  let id = 0;
  const request = (method: string, params: unknown) =>
    new Promise<any>((res) => {
      const n = ++id;
      waiting.set(n, res);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
    });
  const notify = (method: string) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  return { request, notify, close: () => child.kill() };
}

describe('mcp server', () => {
  it('lists tools and returns a structured plan', async () => {
    const root = makeRepo({
      '.github/workflows/release.yml': 'on: push\njobs:\n  p:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm publish\n        env:\n          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n',
      'package.json': pkg({ name: 'w', version: '1.0.0' }),
    });
    const c = client();
    try {
      const init = await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
      expect(init.result.serverInfo.name).toBe('go-tokenless');
      c.notify('notifications/initialized');
      const tools = await c.request('tools/list', {});
      expect(tools.result.tools.map((t: any) => t.name).sort()).toEqual(['apply_trusted_publishing', 'plan_trusted_publishing']);
      const call = await c.request('tools/call', { name: 'plan_trusted_publishing', arguments: { path: root, offline: true } });
      expect(call.result.structuredContent.status).toBe('ready');
      expect(call.result.structuredContent.repository).toBe('acme/widgets');
      expect(call.result.content[0].text).toContain('Ready to go tokenless');
    } finally {
      c.close();
    }
  });
});
