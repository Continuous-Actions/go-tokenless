import type { Plan } from './plan.ts';

const ICON = { error: '✖', warning: '!', info: 'i', ok: '✓' } as const;

const HEADLINE: Record<Plan['status'], string> = {
  'no-publish-workflow': 'No workflow here publishes to npm.',
  'already-tokenless': 'Already tokenless: publishing uses npm trusted publishing.',
  ready: 'Ready to go tokenless.',
  applied: 'Workflow changes written.',
  blocked: 'Blocked: fix the errors below first.',
};

export function formatPlan(plan: Plan, opts: { diff?: boolean } = {}): string {
  const out: string[] = [];
  out.push(`go-tokenless: ${HEADLINE[plan.status]}${plan.repository ? ` (${plan.repository})` : ''}`, '');
  if (plan.changes.length > 0) {
    out.push(plan.status === 'applied' ? 'Changed:' : 'Changes:');
    const byFile = new Map<string, string[]>();
    for (const c of plan.changes) (byFile.get(c.file) ?? byFile.set(c.file, []).get(c.file)!).push(c.description);
    for (const [f, ds] of byFile) {
      out.push(`  ${f}`);
      for (const d of ds) out.push(`    - ${d}`);
    }
    out.push('');
  }
  const notable = plan.findings.filter((f) => f.level !== 'ok' || plan.status === 'already-tokenless');
  if (notable.length > 0) {
    out.push('Notes:');
    for (const f of notable) out.push(`  ${ICON[f.level]} ${f.file}${f.line ? `:${f.line}` : ''} ${f.message}`);
    out.push('');
  }
  if (opts.diff && plan.diff) out.push(plan.diff);
  if (plan.nextSteps.length > 0) {
    out.push('Next:');
    plan.nextSteps.forEach((s, i) => out.push(`  ${i + 1}. ${s}`));
  }
  // Repo content (package names, file names) must not move the cursor or recolour the terminal.
  return out.join('\n').replace(/[\x00-\x08\x0b-\x1f\x7f\x9b]/g, '?');
}
