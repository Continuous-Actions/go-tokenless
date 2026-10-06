import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const json = (f: string) => JSON.parse(readFileSync(f, 'utf8'));

describe('release manifests', () => {
  it('all carry the package.json version', () => {
    const { version } = json('package.json');
    const server = json('server.json');
    expect(server.version).toBe(version);
    expect(server.packages.map((p: any) => p.version)).toEqual([version]);
    expect(json('claude-plugin/.claude-plugin/plugin.json').version).toBe(version);
    expect(json('gemini-extension.json').version).toBe(version);
    // Plugin directories require the npx launcher to be pinned to an exact version.
    for (const f of ['claude-plugin/.claude-plugin/plugin.json', 'gemini-extension.json']) {
      expect(json(f).mcpServers['go-tokenless'].args).toEqual(['-y', `go-tokenless@${version}`, 'mcp']);
    }
    expect(json('claude-plugin/.claude-plugin/plugin.json').author.name).toBe('Continuous-Actions');
  });

  it('use the npm mcpName as the registry name', () => {
    expect(json('server.json').name).toBe(json('package.json').mcpName);
  });
});

describe('Claude plugin folder', () => {
  it('ships the same skill and license as the package', () => {
    expect(readFileSync('claude-plugin/skills/go-tokenless/SKILL.md', 'utf8')).toBe(readFileSync('skills/go-tokenless/SKILL.md', 'utf8'));
    expect(readFileSync('claude-plugin/LICENSE', 'utf8')).toBe(readFileSync('LICENSE', 'utf8'));
    expect(json('.claude-plugin/marketplace.json').plugins[0].source).toBe('./claude-plugin');
  });
});

describe('GitHub Action', () => {
  it('pins the CLI to the package version', () => {
    const { version } = json('package.json');
    expect(readFileSync('action.yml', 'utf8')).toContain(`npx --yes go-tokenless@${version} `);
  });
});
