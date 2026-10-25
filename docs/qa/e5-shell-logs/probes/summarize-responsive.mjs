import { readFileSync } from 'node:fs';

const data = JSON.parse(readFileSync(new URL('./responsive-results.json', import.meta.url), 'utf8'));
for (const r of data) {
  if (r.skipLink) {
    console.log('skipLink:', JSON.stringify(r.skipLink));
  } else if (r.route === '#/settings') {
    console.log(r.viewport, 'settings:', JSON.stringify(r.settings));
    const ts = [...r.targets].sort((a, b) => Math.min(a.w, a.h) - Math.min(b.w, b.h)).slice(0, 3);
    for (const t of ts) console.log('   ', JSON.stringify(t));
  } else {
    const ts = [...r.targets].sort((a, b) => Math.min(a.w, a.h) - Math.min(b.w, b.h)).slice(0, 3);
    console.log(r.viewport, 'today smallest:');
    for (const t of ts) console.log('   ', JSON.stringify(t));
  }
}
