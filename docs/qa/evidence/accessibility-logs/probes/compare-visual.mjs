// Compare prior committed visual-gate.json with the new one: findings + totals.
import fs from 'node:fs';
const load = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const summarize = (d, name) => {
  const f = d.findings ?? [];
  const byKind = {};
  for (const x of f) byKind[x.check] = (byKind[x.check] ?? 0) + 1;
  const c = d.checks?.contrast ?? [];
  let sampled = 0, failures = 0;
  for (const s of c) {
    sampled += s.sampled ?? s.results?.length ?? 0;
    failures += (s.failures ?? s.fails ?? []).length;
  }
  console.log(`\n[${name}] findings:`, JSON.stringify(byKind), `| contrast: ${c.length} scans, ${sampled} sampled, ${failures} failures`);
  const ann = d.checks?.announcements;
  if (ann) {
    for (const loc of Object.keys(ann)) {
      console.log(`  announcements[${loc}]:`, ann[loc].map((s) => `${s.scenario}=${s.hit ? 'HIT' : 'MISS'}`).join(' '));
    }
  }
  return { byKind, f };
};
const prior = load('docs/qa/a11y-gate-logs/visual-gate.json');
const mine = load('docs/qa/evidence/accessibility-logs/visual-gate.json');
const P = summarize(prior, 'PRIOR (committed M13 gate)');
const M = summarize(mine, 'NEW (this audit, pinned b820ad7)');
// Per-kind label diff for touch-target (the largest delta question)
const tt = (d) => (d.findings ?? []).filter((x) => x.check === 'touch-target').map((x) => `${x.cls}|${x.w}x${x.h}`);
const pt = new Set(tt(prior));
const mt = tt(mine);
console.log('\ntouch-target NEW-only entries:');
for (const e of mt) if (!pt.has(e)) console.log('  +', e);
console.log('touch-target in PRIOR:', [...pt].join(' , '));
