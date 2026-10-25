/**
 * M13 gate probe 3 — pin down the exact node/HTML/failureSummary for each blocking
 * axe rule found by probe-axe (list, target-size, label), and prove the CI a11y spec's
 * blind spot (it scans without dismissing first-run onboarding).
 */
import AxeBuilder from '@axe-core/playwright';

import { APP_URL, addTasks, bootPage, createLists, launch, loadCatalogs, writeEvidence } from './lib.mjs';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const catalogs = loadCatalogs();
const out = { detail: [], ciBlindSpot: null };

async function detail(page, label, ids) {
  const res = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  for (const v of res.violations) {
    if (!ids.includes(v.id)) continue;
    out.detail.push({
      label,
      id: v.id,
      impact: v.impact,
      help: v.help,
      description: v.description,
      helpUrl: v.helpUrl,
      nodes: v.nodes.map((n) => ({
        target: n.target,
        html: n.html,
        failureSummary: n.failureSummary,
        any: n.any.map((c) => c.message),
        all: n.all.map((c) => c.message),
        none: n.none.map((c) => c.message),
      })),
    });
  }
}

const browser = await launch();
try {
  const { context, page } = await bootPage(browser, catalogs, { colorScheme: 'light' });
  await createLists(page, catalogs, ['Home']);
  await addTasks(page, ['Buy milk', 'Pay electricity bill', 'Send monthly report']);
  // give one task notes so the notes badge exists; leave rest open

  await page.goto(`${APP_URL}#/all`);
  await page.waitForTimeout(400);
  await detail(page, 'route:#/all', ['list', 'target-size']);

  // Geometry of the checkbox: computed box vs overlap with neighbours.
  const geo = await page.evaluate(() => {
    const cb = document.querySelector('.task-check');
    if (cb === null) return null;
    const r = cb.getBoundingClientRect();
    const cs = getComputedStyle(cb);
    const title = cb.parentElement.querySelector('.task-title, .task-title-text');
    const tr = title?.getBoundingClientRect() ?? null;
    return {
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      boxSizing: cs.boxSizing,
      width: cs.width,
      height: cs.height,
      padding: cs.padding,
      margin: cs.margin,
      titleRect: tr === null ? null : { x: tr.x, y: tr.y, w: tr.width, h: tr.height },
      overlapsTitle:
        tr !== null && !(r.right <= tr.left || r.left >= tr.right || r.bottom <= tr.top || r.top >= tr.bottom),
      hitTarget: (() => {
        // what element receives the pointer at the centre of the visual box?
        const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return el === null ? null : `${el.tagName}.${(el.className ?? '').toString()}`;
      })(),
      hitOutside: (() => {
        // probe 30px to the left of the visual centre (outside the 24px glyph)
        const el = document.elementFromPoint(r.x + r.width / 2 - 20, r.y + r.height / 2);
        return el === null ? null : `${el.tagName}.${(el.className ?? '').toString()}`;
      })(),
    };
  });
  out.checkboxGeometry = geo;

  await page.goto(`${APP_URL}#/settings`);
  await page.waitForTimeout(400);
  await detail(page, 'route:#/settings', ['label']);

  // Where does the file input live in the a11y tree / is it visually hidden?
  const fileGeo = await page.evaluate(() => {
    const inp = document.querySelector('input[type="file"]');
    if (inp === null) return null;
    const cs = getComputedStyle(inp);
    const r = inp.getBoundingClientRect();
    return {
      ariaLabel: inp.getAttribute('aria-label'),
      ariaLabelledby: inp.getAttribute('aria-labelledby'),
      labels: inp.labels === null ? null : inp.labels.length,
      id: inp.id,
      display: cs.display,
      visibility: cs.visibility,
      opacity: cs.opacity,
      clip: cs.clip,
      rect: { w: r.width, h: r.height },
      className: inp.className,
    };
  });
  out.fileInput = fileGeo;

  // CI blind spot: what does the a11y spec actually scan on a fresh profile?
  const fresh = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const fpage = await fresh.newPage();
  await fpage.goto(APP_URL);
  await fpage.waitForTimeout(600);
  const onboardingPresent = (await fpage.locator('[data-surface="onboarding"]').count()) > 0;
  const freshRes = await new AxeBuilder({ page: fpage }).withTags(TAGS).analyze();
  out.ciBlindSpot = {
    onboardingPresentOnFreshProfile: onboardingPresent,
    h1s: await fpage.locator('h1').allTextContents(),
    violations: freshRes.violations.map((v) => `${v.impact}:${v.id} (${v.nodes.length})`),
    passes: freshRes.passes.length,
    doesCiSpecDismissOnboarding: false,
  };
  await fresh.close();
  await context.close();
} finally {
  await browser.close();
}

writeEvidence('axe-detail.json', out);
for (const d of out.detail) {
  console.log(`\n[${d.label}] ${d.impact}:${d.id} — ${d.help}`);
  for (const n of d.nodes) console.log(`  target=${n.target.join(' ')}\n  html=${n.html}\n  summary=${n.failureSummary}`);
}
console.log('\ncheckbox geometry:', JSON.stringify(out.checkboxGeometry));
console.log('file input:', JSON.stringify(out.fileInput));
console.log('CI blind spot:', JSON.stringify(out.ciBlindSpot));
process.exit(0);
