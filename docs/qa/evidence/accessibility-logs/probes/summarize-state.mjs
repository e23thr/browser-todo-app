// Summarize state-contrast.json(s) into a compact table for the report.
import fs from 'node:fs';
const file = process.argv[2] ?? 'docs/qa/evidence/accessibility-logs/baseline-b820ad7/state-contrast.json';
const d = JSON.parse(fs.readFileSync(file, 'utf8'));
const rows = d.samples.filter((s) => !s.missing);
const byState = {};
for (const s of rows) {
  const k = `${s.state}`;
  (byState[k] ??= []).push(s);
}
console.log(`file: ${file}`);
for (const [state, list] of Object.entries(byState)) {
  const ratios = list.map((s) => `${s.theme}/${(s.meta?.label ?? s.label ?? '?').slice(0, 34)}=${s.ratio}${s.pass ? '' : s.exempt ? '(ex)' : '!!'}`);
  console.log(` [${state}] x${list.length}: ${ratios.join(' | ')}`);
}
console.log('missing:', d.samples.filter((s) => s.missing).map((s) => `${s.state}/${s.label}`).join(', ') || 'none');
console.log('stageErrors:', JSON.stringify(d.stageErrors ?? []).slice(0, 300));
