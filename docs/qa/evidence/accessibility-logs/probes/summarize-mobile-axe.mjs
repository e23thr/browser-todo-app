// Summarize the mobile axe evidence JSON: total scans, violations, blocking.
import fs from 'node:fs';
const d = JSON.parse(fs.readFileSync('docs/qa/evidence/accessibility-logs/axe-mobile-list.json', 'utf8'));
if (Array.isArray(d)) {
  let v = 0;
  for (const s of d) v += (s.violations?.length ?? 0);
  console.log(`scans: ${d.length}, violations: ${v}`);
  for (const s of d) if (s.violations?.length) console.log(s.label ?? s.route, JSON.stringify(s.violations));
} else {
  console.log('keys:', Object.keys(d).join(', '));
  const scans = d.scans ?? d.mobileScans ?? [];
  let v = 0;
  for (const s of scans) v += (s.violations?.length ?? 0);
  console.log(`scans: ${scans.length}, violations: ${v}, blocking: ${(d.blocking ?? []).length}`);
  for (const s of scans) if (s.violations?.length) console.log(s.label, JSON.stringify(s.violations));
}
