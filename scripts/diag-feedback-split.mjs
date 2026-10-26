// Split probe for offline-robustness:102's feedbackMs: how much of it is APP feedback
// (real click -> data-theme mutation) vs PLAYWRIGHT overhead (.check() actionability)?
import { webkit, chromium } from 'playwright-core';

const APP = 'http://127.0.0.1:4173/browser-todo-app/';

async function measure(engine, name) {
  const browser = await engine.launch();
  const page = await browser.newPage();
  await page.addInitScript(() => {
    try {
      localStorage.setItem('todo:prefs:v1:onboardingStep', 'done');
    } catch {
      /* ignore */
    }
  });
  await page.goto(`${APP}#/settings`);
  await page.getByRole('heading', { level: 1, name: 'Settings', exact: true }).waitFor();

  // capture-phase dispatch timestamp (event.timeStamp is the page-clock dispatch moment)
  await page.evaluate(() => {
    const w = window;
    w.__dispatchAt = null;
    w.__mutatedAt = null;
    document.addEventListener(
      'click',
      (e) => {
        const t = e.target;
        if (t instanceof HTMLElement && t.closest('[role="radiogroup"]') !== null) {
          if (w.__dispatchAt === null) w.__dispatchAt = e.timeStamp;
        }
      },
      true,
    );
    new MutationObserver(() => {
      if (w.__mutatedAt === null && document.documentElement.dataset['theme'] === 'dark') {
        w.__mutatedAt = performance.now();
      }
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  });

  const beforeCheck = await page.evaluate(() => performance.now());
  const checkStart = Date.now();
  await page.getByRole('radio', { name: 'Dark', exact: true }).check();
  const checkEnd = Date.now();
  await page.waitForFunction(() => document.documentElement.dataset['theme'] === 'dark');
  const afterVisible = await page.evaluate(() => performance.now());

  const r = await page.evaluate(() => ({
    dispatchAt: window.__dispatchAt,
    mutatedAt: window.__mutatedAt,
  }));

  console.log(
    `${name}: current-test semantics (mutation-before-check-start) = ${((r.mutatedAt ?? afterVisible) - beforeCheck).toFixed(1)} ms | ` +
      `TRUE app feedback (dispatch->mutation) = ${((r.mutatedAt ?? 0) - (r.dispatchAt ?? 0)).toFixed(1)} ms | ` +
      `playwright .check() wall = ${checkEnd - checkStart} ms`,
  );
  await browser.close();
}

await measure(webkit, 'webkit');
await measure(chromium, 'chromium');
