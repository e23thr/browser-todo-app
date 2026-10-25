/** Axe + keyboard on the FIRST-RUN ONBOARDING and RECOVERY screens (surfaces CI never scans). */
import AxeBuilder from '@axe-core/playwright';

import { APP_URL, launch, loadCatalogs, writeEvidence } from './lib.mjs';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const out = { scans: [], focusWalks: [] };

async function scan(page, label) {
  const res = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const v = res.violations.map((x) => ({ id: x.id, impact: x.impact, nodes: x.nodes.length, summary: x.nodes[0]?.failureSummary ?? '' }));
  out.scans.push({ label, violations: v, passes: res.passes.length });
  console.log(`scan ${label}: ${v.map((x) => `${x.impact}:${x.id}`).join(', ') || 'clean'} (${res.passes.length} passes)`);
}

async function focusWalk(page, label) {
  const stops = [];
  for (let i = 0; i < 15; i += 1) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      if (el === null || el === document.body) return 'BODY';
      const cs = getComputedStyle(el);
      const hasRing = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
      return `${el.tagName}.${(el.className ?? '').toString().slice(0, 30)} ring=${hasRing} name=${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}`;
    });
    stops.push(info);
  }
  out.focusWalks.push({ label, stops });
  console.log(`focus ${label}: ${stops.join(' | ')}`);
}

const browser = await launch();
try {
  for (const scheme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: scheme });
    const page = await context.newPage();
    await page.goto(APP_URL);
    await page.waitForTimeout(600);
    await scan(page, `onboarding[${scheme}]`);
    if (scheme === 'light') await focusWalk(page, 'onboarding');
    await context.close();
  }

  // Recovery surface: onboarding → reload (no data) per the repro
  for (const scheme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: scheme });
    const page = await context.newPage();
    await page.goto(APP_URL);
    await page.waitForTimeout(500);
    const cta = page.locator('[data-surface="onboarding"] .onboarding-actions button');
    if ((await cta.count()) > 0) {
      await cta.first().click();
      await page.waitForTimeout(500);
    }
    await page.reload();
    await page.waitForTimeout(900);
    const isRecovery = (await page.locator('.recovery').count()) > 0;
    if (isRecovery) {
      await scan(page, `recovery[${scheme}]`);
      if (scheme === 'light') await focusWalk(page, 'recovery');
      // keyboard operability: can a keyboard user get past it?
      const buttons = await page.locator('.recovery button').allTextContents();
      console.log(`recovery buttons: ${JSON.stringify(buttons)}`);
      // activate "Start fresh" from the keyboard only
      const startFresh = page.getByRole('button', { name: /Start fresh/ }).first();
      if ((await startFresh.count()) > 0) {
        await startFresh.focus();
        await page.keyboard.press('Enter');
        await page.waitForTimeout(400);
        const confirming = await page.locator('.recovery-confirm button').count();
        if (confirming > 0) {
          await page.locator('.recovery-confirm button').first().focus();
          await page.keyboard.press('Enter');
          await page.waitForTimeout(700);
        }
        const h1 = await page.locator('h1').allTextContents();
        console.log(`after start-fresh (keyboard): h1=${JSON.stringify(h1)}`);
        out.focusWalks.push({ label: 'recovery-start-fresh-keyboard', finalH1: h1 });
      }
    } else {
      console.log(`recovery surface did NOT appear on ${scheme} (unexpected)`);
      out.scans.push({ label: `recovery[${scheme}]`, violations: ['NOT PRESENT'], passes: 0 });
    }
    await context.close();
  }
} finally {
  await browser.close();
}
writeEvidence('onboarding-recovery-axe.json', out);
console.log('evidence written');
process.exit(0);
