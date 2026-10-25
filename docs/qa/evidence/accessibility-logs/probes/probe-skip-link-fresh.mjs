/**
 * Audit (t_5612df50) — keyboard-script F7.1 on a TRULY fresh load:
 * "Fresh load, first Tab → Skip to main content is the first focusable element;
 *  Enter moves to <main>".
 * Onboarding pre-seeded (localStorage marker, black-box) so NO interaction precedes Tab.
 */
import { APP_URL, launch, loadCatalogs } from '../../../a11y-gate-logs/probes/lib.mjs';

loadCatalogs();
const browser = await launch();
const results = [];
for (const scheme of ['light', 'dark']) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: scheme });
  const page = await context.newPage();
  // Black-box first-run seed (same literal contract as tests/e2e/helpers.seedOnboardingDone)
  await page.addInitScript(() => {
    try {
      localStorage.setItem('todo:prefs:v1:onboardingStep', 'done');
    } catch {
      /* hardened mode: degrade to the real first-run journey */
    }
  });
  await page.goto(APP_URL);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(600);

  const pre = await page.evaluate(() => ({
    active: document.activeElement === document.body ? 'body' : (document.activeElement?.tagName ?? 'null'),
    onboarding: document.querySelector('[data-surface="onboarding"]') !== null,
    dialogs: document.querySelectorAll('.dialog').length,
  }));
  await page.keyboard.press('Tab');
  const first = await page.evaluate(() => {
    const el = document.activeElement;
    if (el === null || el === document.body) return { tag: 'body', cls: '', name: '', rect: null, visible: false };
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      tag: el.tagName,
      cls: String(el.className).slice(0, 60),
      name: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 50),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && r.y >= 0 && r.y < 900,
      outline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`,
    };
  });
  const isFirst = first.cls.includes('skip-link');
  await page.screenshot({ path: `docs/qa/evidence/accessibility-logs/screenshots/f71-first-tab-${scheme}.png` });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  const afterEnter = await page.evaluate(() => ({
    id: document.activeElement?.id ?? '',
    tag: document.activeElement?.tagName ?? 'null',
    cls: String(document.activeElement?.className ?? '').slice(0, 50),
  }));
  const row = { scheme, pre, first, isFirstSkipLink: isFirst, afterEnter, mainFocused: afterEnter.id === 'main' };
  results.push(row);
  console.log(`[${scheme}] pre=${JSON.stringify(pre)}`);
  console.log(`  first Tab → <${first.tag} class="${first.cls}"> "${first.name}" visible=${first.visible} outline=${first.outline}`);
  console.log(`  IS skip link: ${isFirst} | Enter → ${afterEnter.tag}#${afterEnter.id} "${afterEnter.cls}" → main focused: ${row.mainFocused}`);
  await context.close();
}
await browser.close();

const allPass = results.every((r) => r.isFirstSkipLink && r.mainFocused);
console.log(`\nF7.1 verdict: ${allPass ? 'PASS' : 'FAIL'} — ${results.filter((r) => r.isFirstSkipLink && r.mainFocused).length}/${results.length} themes green`);
const fs = await import('node:fs');
fs.writeFileSync('docs/qa/evidence/accessibility-logs/skip-link-fresh-load.json', JSON.stringify({ results, verdict: allPass ? 'PASS' : 'FAIL' }, null, 2));
console.log('[evidence] docs/qa/evidence/accessibility-logs/skip-link-fresh-load.json');
