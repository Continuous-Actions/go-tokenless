// Turns a `go-tokenless --json` plan into a CI result: annotations, a job summary,
// and a non-zero exit when npm publishing still depends on a stored token.
// Plain Node (no dependencies) so the composite action can run it directly.
import { appendFileSync, readFileSync } from 'node:fs';

const [planFile, mode = 'check'] = process.argv.slice(2);
const plan = JSON.parse(readFileSync(planFile, 'utf8'));

const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const prop = (s) => esc(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

for (const f of plan.findings ?? []) {
  if (f.level === 'ok' || f.level === 'info') continue;
  const kind = f.level === 'error' ? 'error' : 'warning';
  const loc = f.file && !f.file.endsWith('/') && f.file !== '.' ? ` file=${prop(f.file)}${f.line ? `,line=${f.line}` : ''},` : ' ';
  console.log(`::${kind}${loc}title=${prop(`go-tokenless: ${f.code}`)}::${esc(f.message)}`);
}
for (const c of plan.changes ?? []) {
  console.log(`::warning file=${prop(c.file)},title=${prop('go-tokenless: still token-based')}::${esc(c.description)}`);
}

const headline = {
  'already-tokenless': '✅ npm publishing uses trusted publishing (no stored token).',
  'no-publish-workflow': 'ℹ️ No workflow in this repository publishes to npm.',
  ready: '❌ npm publishing still depends on a stored token. Run `npx go-tokenless apply` to fix it.',
  blocked: '❌ go-tokenless found a problem that needs a human decision.',
}[plan.status] ?? `go-tokenless status: ${plan.status}`;

const summary = [
  '## go-tokenless',
  '',
  headline,
  '',
  ...(plan.changes?.length ? ['### Changes needed', '', ...plan.changes.map((c) => `- \`${c.file}\`: ${c.description}`), ''] : []),
  ...((plan.findings ?? []).filter((f) => f.level === 'error' || f.level === 'warning').length
    ? ['### Notes', '', ...plan.findings.filter((f) => f.level === 'error' || f.level === 'warning').map((f) => `- **${f.level}** \`${f.file}${f.line ? `:${f.line}` : ''}\`: ${f.message}`), '']
    : []),
  ...(plan.trust?.length && plan.status !== 'already-tokenless' ? ['### npm side (needs your npm login)', '', '```', ...plan.trust.map((t) => t.command), '```', ''] : []),
  `<sub>Checked by [go-tokenless](https://github.com/continuous-actions/go-tokenless). Fix guides: [ENEEDAUTH](https://continuous-actions.github.io/go-tokenless/errors/eneedauth.html) · [E404 PUT](https://continuous-actions.github.io/go-tokenless/errors/e404-put.html) · [E422](https://continuous-actions.github.io/go-tokenless/errors/e422-repository-url.html)</sub>`,
].join('\n');

if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `status=${plan.status}\n`);
console.log(headline);

const failing = plan.status === 'ready' || plan.status === 'blocked';
process.exitCode = mode === 'check' && failing ? 1 : 0;
