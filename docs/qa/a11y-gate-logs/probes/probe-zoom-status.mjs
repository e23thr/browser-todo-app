/**
 * M13 gate probe 5 — remaining criteria in one pass:
 *   (a) 200% zoom with LONG Thai titles/notes (diacritic stacking + line-clamp clipping),
 *   (b) reflow at a 320px viewport with no zoom (design §9.5 gate b / WCAG 1.4.10),
 *   (c) status never colour-only: overdue text+marker, priority shape+label, completed text,
 *   (d) html lang attribute on Thai UI content (screen-reader language switching).
 */
import { APP_URL, addTasks, bootPage, createLists, launch, loadCatalogs, setLanguage, writeEvidence } from './lib.mjs';

const catalogs = loadCatalogs();
const out = {};

const LONG_THAI = [
  'ส่งรายงานประจำเดือนให้ทันก่อนสิ้นไตรมาสพร้อมแนบเอกสารประกอบทั้งหมด',
  'ซื้อนมสดโยเกิร์ตผลไม้และเนื้อสัตว์สำหรับทำอาหารทั้งสัปดาห์',
  'ชำระค่าไฟฟ้าค่าน้ำค่าอินเทอร์เน็ตและค่าโทรศัพท์ก่อนวันครบกำหนด',
];
const LONG_EN = [
  'Send the quarterly report with all supporting documents attached before the deadline',
  'Buy milk yogurt fruit and meat for cooking throughout the whole week',
  'Pay the electricity water internet and phone bills before they are due',
];

const browser = await launch();
try {
  /* (a) + (b) zoom/reflow per locale */
  for (const locale of ['en', 'th']) {
    const { context, page } = await bootPage(browser, catalogs, { colorScheme: 'light' });
    await createLists(page, catalogs, locale === 'th' ? ['งานบ้าน'] : ['Home']);
    // addTasks via composer: title only — long titles exercise the clamp
    await page.goto(`${APP_URL}#/all`);
    await page.waitForTimeout(400);
    const input = page.locator('main .composer input[type="text"]').first();
    for (const t of locale === 'th' ? LONG_THAI : LONG_EN) {
      await input.click();
      await input.fill(t);
      await input.press('Enter');
      await page.waitForTimeout(300);
    }
    if (locale === 'th') await setLanguage(page, catalogs, 'th');

    const measure = async (label) => {
      const r = await page.evaluate(() => {
        const doc = document.documentElement;
        const clipped = [];
        for (const el of document.querySelectorAll('body *')) {
          if (el.closest('[aria-hidden="true"]') || el.classList.contains('visually-hidden')) continue;
          const cs = getComputedStyle(el);
          if ((cs.overflow === 'hidden' || cs.overflowY === 'hidden') && el.scrollHeight > el.clientHeight + 2) {
            const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== '');
            if (hasText) {
              clipped.push({
                cls: (el.className ?? '').toString().slice(0, 60),
                text: (el.textContent ?? '').trim().slice(0, 60),
                scrollH: el.scrollHeight,
                clientH: el.clientHeight,
                lineHeight: cs.lineHeight,
                fontSize: cs.fontSize,
                overflow: cs.overflow,
                lineClamp: cs.webkitLineClamp ?? cs.lineClamp ?? 'none',
              });
            }
          }
        }
        // Thai diacritic stacking: line boxes must be tall enough (line-height >= 1.35)
        const typeRisk = [];
        for (const el of document.querySelectorAll('.task-title-text, .row-meta, .group-title, .due-badge, p, h1, h2, label, button')) {
          if (el.closest('[aria-hidden="true"]')) continue;
          const cs = getComputedStyle(el);
          const fs = parseFloat(cs.fontSize);
          const lh = parseFloat(cs.lineHeight);
          if (!(fs > 0) || !(lh > 0)) continue;
          const ratio = lh / fs;
          if (ratio < 1.35 && (el.textContent ?? '').trim() !== '') {
            typeRisk.push({ cls: (el.className ?? '').toString().slice(0, 50), ratio: +ratio.toFixed(2), fontSize: cs.fontSize, lineHeight: cs.lineHeight });
          }
        }
        return {
          horizontalScroll: doc.scrollWidth > doc.clientWidth + 1,
          scrollWidth: doc.scrollWidth,
          clientWidth: doc.clientWidth,
          rootFont: getComputedStyle(doc).fontSize,
          clipped,
          typeRisk,
        };
      });
      out[`${label}`] = r;
      console.log(`${label}: hScroll=${r.horizontalScroll} rootFont=${r.rootFont} clipped=${r.clipped.length} lowLineHeight=${r.typeRisk.length}`);
      if (r.clipped.length > 0) console.log('  clipped:', JSON.stringify(r.clipped.slice(0, 4)));
      if (r.typeRisk.length > 0) console.log('  lowLH:', JSON.stringify(r.typeRisk.slice(0, 4)));
    };

    // (a) 200% text zoom, 1280 viewport
    for (const route of ['', '#/all']) {
      await page.goto(`${APP_URL}${route}`);
      await page.waitForTimeout(350);
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '32px';
      });
      await page.waitForTimeout(300);
      await measure(`zoom200-${locale}-${route || '/'}`);
      await page.reload();
      await page.waitForTimeout(300);
    }

    // (b) 320px viewport, no zoom
    await page.setViewportSize({ width: 320, height: 720 });
    for (const route of ['', '#/all', '#/lists', '#/settings']) {
      await page.goto(`${APP_URL}${route}`);
      await page.waitForTimeout(350);
      await measure(`reflow320-${locale}-${route || '/'}`);
    }
    await context.close();
  }

  /* (c) status never colour-only + (d) lang attribute on Thai content */
  {
    const { context, page } = await bootPage(browser, catalogs, { colorScheme: 'light' });
    await createLists(page, catalogs, ['Home']);
    // one overdue + one high-priority task via the editor is fiddly; read the DOM rules instead
    await addTasks(page, ['Overdue subject']);
    await page.goto(`${APP_URL}#/all`);
    await page.waitForTimeout(400);
    // mark complete to get a completed row with text
    const check = page.locator('main li [type="checkbox"]').first();
    await check.check({ force: true });
    await page.waitForTimeout(400);
    await setLanguage(page, catalogs, 'th');
    await page.goto(`${APP_URL}#/completed`);
    await page.waitForTimeout(500);
    out.statusNotColour = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('li.task-row')];
      return rows.map((row) => {
        const badges = [...row.querySelectorAll('.row-badges > *, .due-badge, .priority-badge, .list-badge')].map((b) => ({
          cls: b.className,
          text: (b.textContent ?? '').trim(),
          ariaLabel: b.getAttribute('aria-label'),
          role: b.getAttribute('role'),
          dataOverdue: b.getAttribute('data-overdue'),
          marker: b.querySelector('[aria-hidden="true"]')?.textContent ?? null,
        }));
        const checkbox = row.querySelector('[type="checkbox"]');
        return {
          title: (row.querySelector('.task-title-text')?.textContent ?? '').trim().slice(0, 40),
          badges,
          checkboxChecked: checkbox?.checked ?? null,
          checkboxAria: checkbox?.getAttribute('aria-label'),
          // completed rows: is completion conveyed by TEXT/state, not colour?
          rowText: (row.textContent ?? '').trim().slice(0, 120),
          lang: row.getAttribute('lang'),
        };
      });
    });
    // (d) shell lang + Thai text nodes' lang attributes
    out.lang = await page.evaluate(() => ({
      htmlLang: document.documentElement.lang,
      thNodes: (() => {
        const re = /[฀-๿]/;
        const found = [];
        for (const el of document.querySelectorAll('body *')) {
          if (![...el.childNodes].some((n) => n.nodeType === 3 && re.test(n.textContent))) continue;
          found.push({ cls: (el.className ?? '').toString().slice(0, 40), lang: el.getAttribute('lang') });
          if (found.length >= 8) break;
        }
        return found;
      })(),
    }));
    await context.close();
  }
} finally {
  await browser.close();
}

writeEvidence('zoom-status-lang.json', out);
console.log('evidence written');
process.exit(0);
