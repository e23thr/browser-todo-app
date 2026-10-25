/**
 * QA probe (h_reviewer, t_46150118) — responsive behaviour + measured touch targets.
 *
 * For each design-spec breakpoint (base 320, md 768, lg 1024, xl 1440):
 *  - screenshot /today and /settings for the report,
 *  - verify the chrome pattern (compact: appbar+tabbar+FAB+drawer; wide: sidebar, no tabbar/FAB),
 *  - measure every visible interactive element's hit box and flag anything < 44x44 CSS px
 *    (PROJECT_ANALYSIS M8 / design §3.6 --touch-min / §11.1),
 *  - measure spec'd chrome dimensions (appbar 56, tabbar 56, FAB 56, sidebar 256, app max 1440),
 *  - settings section columns (1 col compact, 2 cols >= 768).
 */
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:4273/browser-todo-app/';
const SHOTS = new URL('./shots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const VIEWPORTS = [
  { name: 'base-320', width: 320, height: 568, pattern: 'compact' },
  { name: 'md-768', width: 768, height: 1024, pattern: 'compact' },
  { name: 'lg-1024', width: 1024, height: 768, pattern: 'wide' },
  { name: 'xl-1440', width: 1440, height: 900, pattern: 'wide' },
];

const MEASURE = `
  (() => {
    const out = { targets: [], chrome: {}, settings: {} };
    const sel = 'a[href], button, input, select, textarea, [role="button"], [role="radio"], [role="link"], [role="dialog"] [tabindex]';
    for (const el of document.querySelectorAll(sel)) {
      let target = el;
      // Form controls restyled inside a label: the label is the effective hit area.
      if (el.tagName === 'INPUT' || el.tagName === 'SELECT') {
        const label = el.closest('label');
        if (label) target = label;
      }
      const r = target.getBoundingClientRect();
      const style = getComputedStyle(target);
      const visible =
        style.display !== 'none' && style.visibility !== 'hidden' && (r.width > 0 || r.height > 0);
      if (!visible) continue;
      if (target.classList.contains('skip-link')) continue; // measured separately while focused
      out.targets.push({
        tag: el.tagName.toLowerCase(),
        cls: target.className && typeof target.className === 'string' ? target.className : '',
        label: (el.getAttribute('aria-label') || target.textContent || '').trim().slice(0, 40),
        w: +r.width.toFixed(1),
        h: +r.height.toFixed(1),
        tooSmall: r.width < 44 || r.height < 44,
      });
    }
    const box = (s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return cs.display === 'none'
        ? { hidden: true }
        : { w: +r.width.toFixed(1), h: +r.height.toFixed(1), x: +r.x.toFixed(1) };
    };
    out.chrome = {
      appbar: box('.appbar'),
      tabbar: box('.tabbar'),
      fab: box('.fab'),
      sidebar: box('.sidebar'),
      drawerButton: box('.appbar button'),
      shell: box('.shell'),
      appMain: box('.app-main'),
    };
    const sections = [...document.querySelectorAll('.settings-section')];
    if (sections.length) {
      const cols = getComputedStyle(sections[0].parentElement).gridTemplateColumns;
      out.settings = {
        sectionCount: sections.length,
        gridColumns: cols,
        selectDisabled: (document.querySelector('#settings-default-list') || {}).disabled,
      };
    }
    return out;
  })()
`;

const browser = await chromium.launch();
const results = [];

for (const vp of VIEWPORTS) {
  for (const route of ['#/today', '#/settings']) {
    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await context.newPage();
    await page.goto(BASE + route, { waitUntil: 'load' });
    await page.waitForTimeout(350);
    const shot = `${SHOTS}${vp.name}-${route.slice(2)}.png`;
    await page.screenshot({ path: shot, fullPage: false });
    const measured = await page.evaluate(MEASURE);
    results.push({ viewport: vp.name, pattern: vp.pattern, route, shot, ...measured });
    await context.close();
  }
}

// Skip-link hit area while focused (it is visually hidden at rest by design).
{
  const context = await browser.newContext({ viewport: { width: 320, height: 568 } });
  const page = await context.newPage();
  await page.goto(`${BASE}#/today`, { waitUntil: 'load' });
  await page.waitForSelector('.shell'); // Preact hydration done before keyboard probing
  await page.keyboard.press('Tab');
  const skip = await page.evaluate(() => {
    const el = document.activeElement;
    const r = el.getBoundingClientRect();
    return {
      text: el.textContent.trim(),
      isSkipLink: el.classList.contains('skip-link'),
      w: +r.width.toFixed(1),
      h: +r.height.toFixed(1),
      outlineWidth: getComputedStyle(el).outlineWidth,
    };
  });
  await page.screenshot({ path: `${SHOTS}skip-link-focused.png` });
  results.push({ viewport: 'base-320', route: 'skip-link-focused', skipLink: skip });
  await context.close();
}

await browser.close();
writeFileSync(new URL('./responsive-results.json', import.meta.url), JSON.stringify(results, null, 2));

for (const r of results) {
  if (r.skipLink) {
    console.log('skip-link while focused:', JSON.stringify(r.skipLink));
    continue;
  }
  const bad = r.targets.filter((t) => t.tooSmall);
  console.log(
    `${r.viewport} ${r.route} [${r.pattern}]: ${r.targets.length} targets, ${bad.length} under 44px; chrome=${JSON.stringify(r.chrome)}`,
  );
  for (const t of bad) console.log('   TOO SMALL:', JSON.stringify(t));
}
