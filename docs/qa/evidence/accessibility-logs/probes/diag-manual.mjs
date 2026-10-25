// Print the SR flow details + the flagged keyboard steps for diagnosis.
import fs from 'node:fs';
const sr = JSON.parse(fs.readFileSync('docs/qa/evidence/accessibility-logs/sr-spotcheck.json', 'utf8'));
for (const f of sr.flows) {
  console.log(`\n── ${f.name}: hit=${f.hit} expect=${JSON.stringify(f.expect).slice(0, 80)}`);
  console.log('   polite:', JSON.stringify(f.polite));
  console.log('   notes :', JSON.stringify(f.notes).slice(0, 600));
  if (f.error) console.log('   error :', f.error);
}
const kb = JSON.parse(fs.readFileSync('docs/qa/evidence/accessibility-logs/keyboard-manual.json', 'utf8'));
console.log('\n══ keyboard flagged/voted steps:');
for (const s of kb.steps) {
  if (/P1\.(2|3|5|6|8|9|11|12|13|14|15)|P2\.(1|3|4)/.test(s.step)) {
    console.log(` ${s.step} :: focus=<${s.focus.tag} ${s.focus.cls}> "${String(s.focus.name).slice(0, 40)}" | ${JSON.stringify(s.note ?? s.targetReached ?? s.skipVisible ?? s.trapOk ?? s.confirmOpen ?? s.reachedH1 ?? s.returnedToRow ?? '')}`);
  }
}
console.log('\n══ phases:', JSON.stringify(kb.phases));
console.log('══ stageErrors:', JSON.stringify(kb.stageErrors));
