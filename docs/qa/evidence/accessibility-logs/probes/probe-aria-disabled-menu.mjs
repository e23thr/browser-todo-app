/**
 * Addendum (t_5612df50): contrast of the aria-disabled row-menu item — the only disabled
 * component class the main state probe could not reach on #/all (Move up/down are disabled
 * at a LIST view's boundaries). Measured light + dark.
 */
import { APP_URL, addTasks, createLists, launch, loadCatalogs, writeEvidence } from '../../../a11y-gate-logs/probes/lib.mjs';

const catalogs = loadCatalogs();
const out = { appUrl: APP_URL, samples: [], errors: [] };

const math = `
  const toRgb=(c)=>{const m=c.match(/rgba?\\(([^)]+)\\)/);if(m){const p=m[1].split(/[,\\/\\s]+/).filter(Boolean).map(Number);return{r:p[0],g:p[1],b:p[2],a:p.length>3?p[3]:1};}const h=c.replace('#','');if(h.length>=6)return{r:parseInt(h.slice(0,2),16),g:parseInt(h.slice(2,4),16),b:parseInt(h.slice(4,6),16),a:1};return null;};
  const lum=(c)=>{const f=(v)=>{const s=v/255;return s<=0.03928?s/12.92:((s+0.055)/1.055)**2.4;};return 0.2126*f(c.r)+0.7152*f(c.g)+0.0722*f(c.b);};
  const ratio=(a,b)=>{const l1=lum(a),l2=lum(b);const[hi,lo]=l1>l2?[l1,l2]:[l2,l1];return(hi+0.05)/(lo+0.05);};
  const over=(fg,bg)=>fg.a>=1?fg:{r:fg.r*fg.a+bg.r*(1-fg.a),g:fg.g*fg.a+bg.g*(1-fg.a),b:fg.b*fg.a+bg.b*(1-fg.a),a:1};
  const effectiveBg=(node)=>{let cur=node,acc=null;while(cur!==null){const bg=toRgb(getComputedStyle(cur).backgroundColor);if(bg!==null&&bg.a>0){if(acc===null){acc=bg;if(bg.a>=1)return acc;}else if(bg.a>=1){return over(acc,bg);}else{acc=over(acc,bg);}}cur=cur.parentElement;}return acc===null?{r:255,g:255,b:255,a:1}:acc;};
`;

const browser = await launch();
for (const theme of ['light', 'dark']) {
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: theme });
    const page = await context.newPage();
    await page.goto(APP_URL);
    await page.waitForTimeout(400);
    const cta = page.locator('[data-surface="onboarding"] .onboarding-actions button');
    if ((await cta.count()) > 0) await cta.first().click();
    const ids = await createLists(page, catalogs, ['Home']);
    await addTasks(page, ['Ship audit report', 'Buy oat milk']);
    await page.goto(`${APP_URL}#/list/${ids['Home']}`);
    await page.waitForTimeout(500);
    await page.locator('button[aria-haspopup="menu"]').first().click();
    await page.waitForTimeout(300);
    const disabled = page.locator('[role="menuitem"][aria-disabled="true"]').first();
    const present = (await disabled.count()) > 0;
    if (!present) {
      out.samples.push({ theme, missing: true, note: 'no aria-disabled item at list top boundary' });
      console.log(`[${theme}] no aria-disabled menu item found`);
    } else {
      const label = (await disabled.textContent()) ?? '';
      const res = await page.evaluate(
        `(() => { ${math}
          const el = document.querySelector('[role="menuitem"][aria-disabled="true"]');
          const cs = getComputedStyle(el);
          const bg = effectiveBg(el);
          const fg = over(toRgb(cs.color), bg);
          const r = ratio(fg, bg);
          return { label: (el.textContent||'').trim(), fg: cs.color, bg: 'rgb('+bg.r+','+bg.g+','+bg.b+')', ratio: Math.round(r*100)/100, fontSize: parseFloat(cs.fontSize), opacity: cs.opacity };
        })()`,
      );
      out.samples.push({ theme, state: 'disabled', component: 'row-menu item aria-disabled', expectedLabel: label.trim(), ...res, threshold: 4.5, exemptNote: 'inactive component (SC 1.4.3 exempt) but measured', pass: res.ratio >= 4.5 });
      console.log(`[${theme}] aria-disabled menu item "${res.label}": ${res.ratio}:1 (≥4.5) ${res.ratio >= 4.5 ? 'PASS' : 'FAIL'}`);
    }
    await context.close();
  } catch (e) {
    out.errors.push({ theme, error: String(e.message ?? e).split('\n')[0] });
    console.log(`[${theme}] ERROR ${String(e.message ?? e).split('\n')[0]}`);
  }
}
await browser.close();
writeEvidence('state-contrast-aria-disabled.json', out);
const fails = out.samples.filter((s) => !s.missing && !s.pass);
console.log(`aria-disabled addendum: ${out.samples.filter((s) => !s.missing).length} measured, ${fails.length} below 4.5`);
