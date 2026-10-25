/** Mobile settings: geometry/visibility of the locale radios — why does .check() time out? */
import { APP_URL, bootPage, createLists, launch, loadCatalogs, setLanguage, writeEvidence } from './lib.mjs';

const catalogs = loadCatalogs();
const browser = await launch();
const out = {};
try {
  const { context, page } = await bootPage(browser, catalogs, {
    colorScheme: 'light',
    viewport: { width: 360, height: 740 },
    isMobile: true,
    hasTouch: true,
  });
  await createLists(page, catalogs, ['Home']);
  await page.goto(`${APP_URL}#/settings`);
  await page.waitForTimeout(500);
  out.geometry = await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('input[name="settings-locale"]')];
    return inputs.map((i) => {
      const r = i.getBoundingClientRect();
      const cs = getComputedStyle(i);
      const lab = i.labels?.[0] ?? null;
      const lr = lab?.getBoundingClientRect() ?? null;
      const atCentre = (() => {
        const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return el === null ? null : `${el.tagName}.${el.className}`;
      })();
      return {
        value: i.value,
        checked: i.checked,
        rect: { x: r.x, y: r.y, w: r.width, h: r.height },
        display: cs.display,
        visibility: cs.visibility,
        opacity: cs.opacity,
        clip: cs.clip,
        clipPath: cs.clipPath,
        position: cs.position,
        labelRect: lr === null ? null : { x: lr.x, y: lr.y, w: lr.width, h: lr.height },
        labelText: lab?.textContent?.trim(),
        elementAtCentre: atCentre,
        inViewport: r.top >= 0 && r.bottom <= innerHeight,
      };
    });
  });
  // Try the label-click path (what a human does) and then the programmatic check.
  const th = catalogs.th['settings.language.thai'];
  const labelEl = page.locator('label', { hasText: th }).first();
  out.labelCount = await labelEl.count();
  if (out.labelCount > 0) {
    await labelEl.click({ timeout: 10000 }).then(() => (out.labelClick = 'ok')).catch((e) => (out.labelClick = e.message.split('\n')[0]));
    await page.waitForTimeout(600);
    out.langAfterLabelClick = await page.evaluate(() => document.documentElement.lang);
  }
  if (out.langAfterLabelClick !== 'th') {
    await page
      .getByRole('radio', { name: th, exact: true })
      .first()
      .check({ force: true, timeout: 8000 })
      .then(() => (out.forceCheck = 'ok'))
      .catch((e) => (out.forceCheck = e.message.split('\n')[0]));
    await page.waitForTimeout(600);
    out.langAfterForceCheck = await page.evaluate(() => document.documentElement.lang);
  }
  out.finalLang = await page.evaluate(() => document.documentElement.lang);
  await context.close();
} finally {
  await browser.close();
}
writeEvidence('mobile-locale-radio.json', out);
console.log(JSON.stringify(out, null, 2));
process.exit(0);
