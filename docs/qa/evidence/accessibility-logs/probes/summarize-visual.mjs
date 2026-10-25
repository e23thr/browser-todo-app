// Summarize visual-gate.json findings by kind + stage errors.
import fs from 'node:fs';
const d = JSON.parse(fs.readFileSync('docs/qa/evidence/accessibility-logs/visual-gate.json', 'utf8'));
const f = d.findings ?? [];
const byKind = {};
for (const x of f) (byKind[x.check] ??= []).push(x);
for (const k of Object.keys(byKind)) {
  console.log('==', k, 'x', byKind[k].length);
  for (const x of byKind[k].slice(0, 5)) console.log('  ', JSON.stringify(x).slice(0, 320));
}
console.log('stageErrors:', JSON.stringify(d.stageErrors ?? []).slice(0, 800));
console.log('checks keys:', Object.keys(d.checks ?? {}).join(', '));
const c = d.checks?.contrast ?? [];
let tot = 0, fails = 0;
for (const s of c) {
  tot += s.results?.length ?? s.samples?.length ?? 0;
  fails += (s.fails ?? s.below ?? []).length;
}
console.log(`contrast: ${c.length} scans, ${tot} samples, ${fails} below threshold`);
for (const s of c.slice(0, 2)) console.log('  scan sample keys:', Object.keys(s).join(','), JSON.stringify(s).slice(0, 200));
const ann = d.checks?.announcements;
if (ann) console.log('announcements keys:', JSON.stringify(ann).slice(0, 500));
if (d.checks?.reducedMotion) console.log('reducedMotion:', JSON.stringify(d.checks.reducedMotion).slice(0, 300));
if (d.checks?.lang) console.log('lang:', JSON.stringify(d.checks.lang).slice(0, 300));
