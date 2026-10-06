const fs = require('fs');
let s = fs.readFileSync('src/plan.ts', 'utf8');
const rep = (a, b) => { if (!s.includes(a)) throw new Error('missing ' + a.slice(0, 70)); s = s.replace(a, b); };
rep(String.raw`  if (opts.npmVersion !== undefined && !/^[\w.^~<>=*| -]+$/.test(opts.npmVersion.trim())) {
    throw new UsageError(` + '`--npm-version must be an npm version or range (e.g. ^12, 11.6.2), got "${opts.npmVersion}"`' + `);
  }
  if (opts.npmArgs !== undefined && (/[\r\n]/.test(opts.npmArgs) || /\$\{\{/.test(opts.npmArgs))) {
    throw new UsageError('--npm-args must be a single line without \${{ }} expressions');
  }`, String.raw`  // A single version or caret/tilde range: it goes into a shell command unquoted.
  if (opts.npmVersion !== undefined && !/^[\^~]?\d+(\.(\d+|x))?(\.(\d+|x))?(-[\w.]+)?$/.test(opts.npmVersion.trim())) {
    throw new UsageError(` + '`--npm-version must be a version or a ^/~ range (e.g. ^12, ~11.6.0, 12.2.0), got "${opts.npmVersion}"`' + String.raw`);
  }
  // Flags only (e.g. --registry=https://… --loglevel=warn): no shell syntax, no expressions.
  if (opts.npmArgs !== undefined && !/^(\s*--?[\w-]+(=[\w@%+:,./~-]+)?)*\s*$/.test(opts.npmArgs)) {
    throw new UsageError('--npm-args must be npm flags such as "--registry=https://registry.npmjs.org --loglevel=warn" (no shell characters or ${{ }})');
  }
  if (opts.repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(opts.repo)) {
    throw new UsageError(` + '`repo must look like owner/repo, got "${opts.repo}"`' + `);
  }`);
rep(`        const parts = ['npm trust github', p.name, '--repo', slug ?? '<owner>/<repo>', '--file', w.trustFile];
        if (env) parts.push('--env', env);
        parts.push('--allow-publish', '--yes');
        trust.push({ package: p.name, workflow: w.trustFile, environment: env, command: parts.join(' ') + extraArgs });`,
`        if (!isValidNpmName(p.name)) {
          findings.push({ level: 'error', file: p.file, code: 'invalid-package-name', message: \`"\${p.name}" is not a valid npm package name, so no trust command was generated for it.\` });
          continue;
        }
        const parts = ['npm', 'trust', 'github', p.name, '--repo', slug ?? '<owner>/<repo>', '--file', w.trustFile];
        if (env) parts.push('--env', env);
        parts.push('--allow-publish', '--yes');
        trust.push({ package: p.name, workflow: w.trustFile, environment: env, command: parts.map((x) => (x === '<owner>/<repo>' ? x : shellQuote(x))).join(' ') + extraArgs });`);
rep(`  const old = secrets.filter((s) => s !== readToken);
  if (old.length > 0) steps.push(`, `  const old = secrets.filter((s) => s !== readToken);
  if (readToken && secrets.includes(readToken)) {
    steps.push(\`\\`\${readToken}\\` holds your current publish token. Replace its value with a read-only token before merging (\\`gh secret set \${readToken}\\`), then revoke the old token on npmjs.com → Access Tokens.\`);
  }
  if (old.length > 0) steps.push(`);
s += `
/** npm package name rules (lowercase, URL-safe, optional @scope/). */
export function isValidNpmName(name: string): boolean {
  return name.length <= 214 && /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(name);
}

/** Quote a word for POSIX shells and PowerShell alike when it has anything but safe characters. */
export function shellQuote(word: string): string {
  return /^[\w@%+=:,./~-]+$/.test(word) ? word : \`'\${word.replace(/'/g, \`'\\''\`)}'\`;
}
`;
fs.writeFileSync('src/plan.ts', s);
