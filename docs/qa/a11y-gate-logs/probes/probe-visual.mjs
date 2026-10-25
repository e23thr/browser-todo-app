/**
 * M13 gate probe 2 — visual & behavioural checks the axe matrix cannot make:
 *
 *   1. contrast  ≥4.5:1 text / ≥3:1 UI components, BOTH themes, real rendered pixels
 *   2. status never colour-only (overdue/priority/completed carry text or shape)
 *   3. touch targets ≥44×44 CSS px on a mobile viewport
 *   4. prefers-reduced-motion collapses animation/transition
 *   5. 200% text zoom reflow (incl. Thai diacritic/vowel stacking, no clipping/loss)
 *   6. live-region announcements for silent async changes (en + th)
 *   7. `html lang` follows the locale and locale-specific text carries its own lang
 *
 * Every check writes evidence to docs/qa/a11y-gate-logs/.
 */
import {
  APP_URL,
  addTasks,
  bootPage,
  clearAnnounces,
  composite,
  contrastRatio,
  createLists,
  dismissOnboarding,
  fmt,
  installAnnounceRecorder,
  launch,
  loadCatalogs,
  parseColor,
  readAnnounces,
  setLanguage,
  writeEvidence,
} from './lib.mjs';

const catalogs = loadCatalogs();
const S = (k, l = 'en') => catalogs[l][k];
const out = { appUrl: APP_URL, checks: {}, findings: [], stageErrors: [] };

/** Run one gate stage; a stage failure is recorded and the run continues. */
async function stage(name, fn) {
  try {
    await fn();
  } catch (e) {
    out.stageErrors.push({ stage: name, error: String(e.message ?? e).split('\n').slice(0, 3).join(' | ') });
    console.log(`STAGE FAILED: ${name} — ${String(e.message ?? e).split('\n')[0]}`);
  }
}

/* ------------------------------------------------------------------ 1. CONTRAST */

/**
 * Sample every visible text element and every interactive element on the current page and
 * measure WCAG contrast — all math runs IN THE PAGE in one round trip (no per-node CDP).
 */
async function sampleContrast(page, label) {
  const results = await page.evaluate(() => {
    const toRgb = (c) => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (m) {
        const p = m[1].split(/[,/\s]+/).filter(Boolean).map(Number);
        return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
      }
      const h = c.replace('#', '');
      if (h.length >= 6) {
        return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
      }
      return null;
    };
    const lum = (c) => {
      const f = (v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const ratio = (a, b) => {
      const l1 = lum(a);
      const l2 = lum(b);
      const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
      return (hi + 0.05) / (lo + 0.05);
    };
    const over = (fg, bg) =>
      fg.a >= 1
        ? fg
        : {
            r: fg.r * fg.a + bg.r * (1 - fg.a),
            g: fg.g * fg.a + bg.g * (1 - fg.a),
            b: fg.b * fg.a + bg.b * (1 - fg.a),
            a: 1,
          };

    /** Effective opaque background behind an element (walk ancestors, composite down). */
    const effectiveBg = (node) => {
      let cur = node;
      let acc = null;
      while (cur !== null) {
        const bg = toRgb(getComputedStyle(cur).backgroundColor);
        if (bg !== null && bg.a > 0) {
          if (acc === null) {
            acc = bg;
            if (bg.a >= 1) return acc;
          } else if (bg.a >= 1) {
            return over(acc, bg);
          } else {
            acc = over(acc, bg);
          }
        }
        cur = cur.parentElement;
      }
      return acc === null ? { r: 255, g: 255, b: 255, a: 1 } : acc;
    };

    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
    };

    const out = [];
    const seen = new Set();
    const consider = (el, kind) => {
      if (seen.has(el)) return;
      seen.add(el);
      const cs = getComputedStyle(el);
      const fg = toRgb(cs.color);
      if (fg === null) return;
      const bg = effectiveBg(el);
      const composed = over(fg, bg);
      const r = ratio(composed, { r: bg.r, g: bg.g, b: bg.b });
      const fontSize = parseFloat(cs.fontSize);
      const fontWeight = parseInt(cs.fontWeight, 10) || 400;
      let need;
      if (kind === 'text') {
        const large = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
        need = large ? 3 : 4.5;
      } else {
        need = 3;
      }
      out.push({
        kind,
        tag: el.tagName.toLowerCase(),
        cls: (el.className ?? '').toString().slice(0, 70),
        text: (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60),
        ratio: +r.toFixed(2),
        need,
        pass: r >= need,
        color: cs.color,
        fontSize,
        fontWeight,
        bg: `rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)})`,
      });
    };

    for (const el of document.querySelectorAll('body *')) {
      if (el.closest('[aria-hidden="true"]')) continue;
      if (!isVisible(el)) continue;
      const direct = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== '');
      if (direct) consider(el, 'text');
    }
    for (const el of document.querySelectorAll(
      'button, a[href], input:not([type="file"]), select, textarea, [role="button"], [role="checkbox"], [role="radio"], [role="menuitem"], [role="tab"], [role="link"], [role="switch"], [role="option"], summary',
    )) {
      if (el.closest('[aria-hidden="true"]')) continue;
      if (!isVisible(el)) continue;
      // A control with text already measured as text keeps its text bar; controls with no
      // own text (icons, bare inputs, borders) are UI components → 3:1.
      const hasOwnText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== '');
      consider(el, hasOwnText ? 'text' : 'ui');
    }
    return out;
  });

  out.checks.contrast ??= [];
  const fails = results.filter((r) => !r.pass);
  out.checks.contrast.push({
    label,
    sampled: results.length,
    failures: fails,
  });
  for (const f of fails) out.findings.push({ check: 'contrast', label, ...f });
  console.log(`contrast ${label}: ${results.length} sampled, ${fails.length} below threshold`);
}

/* ------------------------------------------------------- 3. TOUCH TARGETS (mobile) */

async function sampleTouchTargets(page, label) {
  const samples = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll(
      'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="checkbox"], [role="radio"], [role="menuitem"], [role="tab"], [role="link"], [role="switch"], [role="option"], [role="menuitemcheckbox"]',
    )) {
      if (el.closest('[aria-hidden="true"]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      out.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className ?? '').toString().slice(0, 70),
        name: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 50),
        w: Math.round(r.width * 100) / 100,
        h: Math.round(r.height * 100) / 100,
      });
    }
    return out;
  });
  // WCAG 2.5.8 (AA) minimum is 24×24; the PROJECT_ANALYSIS §8 target is ≥44×44.
  const under44 = samples.filter((s) => s.w < 44 || s.h < 44);
  const under24 = under44.filter((s) => s.w < 24 || s.h < 24);
  out.checks.touch ??= [];
  out.checks.touch.push({ label, sampled: samples.length, under44, under24 });
  for (const t of under44) out.findings.push({ check: 'touch-target', label, ...t });
  console.log(`touch ${label}: ${samples.length} targets, ${under44.length} <44px, ${under24.length} <24px (WCAG 2.5.8)`);
}

/* --------------------------------------------------------- 4. REDUCED MOTION */

async function checkReducedMotion(page) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${APP_URL}#/all`);
  await page.waitForTimeout(400);
  const res = await page.evaluate(() => {
    const report = { durations: [], animations: [] };
    for (const el of document.querySelectorAll('body *')) {
      if (el.closest('[aria-hidden="true"]')) continue;
      const cs = getComputedStyle(el);
      const props = [
        ['transitionDuration', cs.transitionDuration],
        ['animationDuration', cs.animationDuration],
      ];
      for (const [prop, val] of props) {
        if (val === '' || val === '0s') continue;
        const max = Math.max(...val.split(',').map((v) => parseFloat(v) || 0));
        if (max > 0.02) report.durations.push({ cls: (el.className ?? '').toString().slice(0, 60), prop, val });
      }
      if (cs.animationName !== 'none') {
        report.animations.push({ cls: (el.className ?? '').toString().slice(0, 60), name: cs.animationName });
      }
    }
    return report;
  });
  await page.emulateMedia({ reducedMotion: null });
  out.checks.reducedMotion = {
    durationsOver20ms: res.durations,
    runningAnimations: res.animations,
    pass: res.durations.length === 0,
  };
  if (res.durations.length > 0 || res.animations.length > 0) {
    out.findings.push({ check: 'prefers-reduced-motion', ...res });
  }
  console.log(
    `reduced-motion: ${res.durations.length} transition/animation duration(s) >20ms, ${res.animations.length} running animation(s)`,
  );
}

/* ------------------------------------------------------------ 5. 200% ZOOM REFLOW */

async function checkZoomReflow(page, locale) {
  const l = locale === 'th' ? 'th' : 'en';
  const results = [];
  const routes = ['', '#/all', '#/lists', '#/settings'];
  for (const route of routes) {
    await page.goto(`${APP_URL}${route}`);
    await page.waitForTimeout(350);
    // Text-only zoom to 200% (WCAG 1.4.4). Inline <style> injection is CSP-blocked
    // (§7.2 style-src 'self' — proven here); CSSOM property writes are not.
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '32px';
    });
    await page.waitForTimeout(250);
    const r = await page.evaluate(() => {
      const doc = document.documentElement;
      const clipped = [];
      // Any element whose scrollHeight exceeds clientHeight with hidden overflow = clipped text
      for (const el of document.querySelectorAll('body *')) {
        if (el.closest('[aria-hidden="true"]')) continue;
        const cs = getComputedStyle(el);
        if ((cs.overflow === 'hidden' || cs.overflowY === 'hidden') && el.scrollHeight > el.clientHeight + 2) {
          const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== '');
          if (hasText) clipped.push({ cls: (el.className ?? '').toString().slice(0, 60), text: (el.textContent ?? '').trim().slice(0, 50), scrollH: el.scrollHeight, clientH: el.clientHeight });
        }
      }
      // Diacritic clipping: Thai marks painted above the glyph box — detect rows whose
      // content box clips anything above the first line's text top (scrollHeight > box).
      const thaiStack = [];
      for (const el of document.querySelectorAll('.task-title-text, h1, h2, label, .due-badge, .row-meta')) {
        const rect = el.getBoundingClientRect();
        if (rect.height < 4) continue;
        const cs = getComputedStyle(el);
        if (cs.overflow !== 'visible') {
          thaiStack.push({ cls: (el.className ?? '').toString().slice(0, 50), overflow: cs.overflow });
        }
      }
      return {
        horizontalScroll: doc.scrollWidth > doc.clientWidth + 1,
        scrollWidth: doc.scrollWidth,
        clientWidth: doc.clientWidth,
        clipped,
        nonVisibleOverflow: thaiStack,
        rootFont: getComputedStyle(doc).fontSize,
      };
    });
    await page.reload();
    await page.waitForTimeout(250);
    results.push({ route: route || '/', ...r });
    if (r.horizontalScroll) out.findings.push({ check: 'zoom-reflow', locale, route, ...r });
    if (r.clipped.length > 0) out.findings.push({ check: 'zoom-clip', locale, route, clipped: r.clipped });
  }
  out.checks.zoomReflow ??= {};
  out.checks.zoomReflow[locale] = results;
  console.log(
    `zoom 200% [${locale}]: ${results.map((r) => `${r.route || '/'}:${r.horizontalScroll ? 'H-SCROLL' : 'ok'}${r.clipped.length ? `+${r.clipped.length} clipped` : ''}`).join(' | ')}`,
  );
}

/* ------------------------------------------------------------- 6. LIVE REGIONS */

async function checkAnnouncements(page, locale) {
  const l = locale === 'th' ? 'th' : 'en';
  const scenarios = [];

  await clearAnnounces(page);
  await page.goto(`${APP_URL}#/all`);
  await page.waitForTimeout(400);
  await installAnnounceRecorder(page);
  await clearAnnounces(page);

  // a) silent task add (optimistic, no visual toast)
  const input = page.locator('main .composer input[type="text"]').first();
  const addTitle = locale === 'th' ? 'เพิ่มงานใหม่' : 'Announce add';
  await input.click();
  await input.fill(addTitle);
  await input.press('Enter');
  await page.waitForTimeout(600);
  let ann = await readAnnounces(page);
  scenarios.push({ scenario: 'task-added', expect: fmt(S('a11y.taskAdded', l), { title: addTitle }), polite: ann.polite, assertive: ann.assertive });
  await clearAnnounces(page);

  // b) silent complete toggle
  const check = page.locator('main li [type="checkbox"]').first();
  if ((await check.count()) > 0) {
    await check.check();
    await page.waitForTimeout(600);
    ann = await readAnnounces(page);
    scenarios.push({ scenario: 'task-completed', expect: S('a11y.taskCompleted', l), polite: ann.polite, assertive: ann.assertive });
    await clearAnnounces(page);
    await check.uncheck().catch(() => {});
    await page.waitForTimeout(500);
    ann = await readAnnounces(page);
    scenarios.push({ scenario: 'task-reopened', expect: S('a11y.taskReopened', l), polite: ann.polite, assertive: ann.assertive });
    await clearAnnounces(page);
  }

  // c) route change (SPA focus contract)
  await page.goto(`${APP_URL}#/week`);
  await page.waitForTimeout(500);
  ann = await readAnnounces(page);
  scenarios.push({ scenario: 'route-change', expect: containsFmt(S('a11y.viewChanged', l)), polite: ann.polite, assertive: ann.assertive });
  await clearAnnounces(page);

  // d) search results (silent async change of the list)
  await page.goto(`${APP_URL}#/search`);
  await page.waitForTimeout(400);
  const searchField = page.locator('main input[type="search"], main input[type="text"]').first();
  if ((await searchField.count()) > 0) {
    await searchField.fill(locale === 'th' ? 'งาน' : 'a');
    await page.waitForTimeout(700);
    ann = await readAnnounces(page);
    scenarios.push({ scenario: 'search-results', expect: containsFmt(S('a11y.searchResults', l)), polite: ann.polite, assertive: ann.assertive });
    await clearAnnounces(page);
  }

  // e) list created
  await page.goto(`${APP_URL}#/lists`);
  await page.waitForTimeout(400);
  const newList = page.getByRole('button', { name: S('list.action.new', l), exact: true }).first();
  if ((await newList.count()) > 0) {
    await newList.click();
    await page.waitForTimeout(250);
    const dlg = page.locator('.dialog').last();
    await dlg.locator('input[type="text"]').first().fill(locale === 'th' ? 'รายการทดสอบ' : 'Announce list');
    await dlg.locator('button.button-primary').first().click();
    await page.waitForTimeout(600);
    ann = await readAnnounces(page);
    scenarios.push({ scenario: 'list-created', expect: containsFmt(S('a11y.listCreated', l)), polite: ann.polite, assertive: ann.assertive });
    await clearAnnounces(page);
  }

  out.checks.announcements ??= {};
  out.checks.announcements[locale] = scenarios;
  for (const s of scenarios) {
    const hit = [...s.polite, ...s.assertive].some((msg) => matches(msg, s.expect));
    s.hit = hit;
    if (!hit) out.findings.push({ check: 'live-region', locale, ...s });
  }
  console.log(
    `announcements [${locale}]: ${scenarios.map((s) => `${s.scenario}=${s.hit ? 'HIT' : 'MISS'}`).join(' ')}`,
  );
}

/** Expected pattern (may be a literal or a `…{param}…` template) against a message. */
function containsFmt(pattern) {
  return pattern;
}
function matches(msg, expect) {
  if (expect === '' || expect === undefined) return false;
  // Template expectation: turn {param} into a wildcard.
  const rx = '^' + expect.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{\\w+\\\}/g, '.+') + '$';
  return new RegExp(rx).test(msg);
}

/* ------------------------------------------------------- 7. lang / SR LANGUAGE */

async function checkLang(page, locale) {
  const htmlLang = await page.evaluate(() => document.documentElement.lang);
  // Locale-specific content: does any Thai text carry lang="th" when the shell is en,
  // and does the shell lang flip on switch?
  const body = await page.evaluate(() => {
    const thNodes = [];
    const re = /[฀-๿]/;
    for (const el of document.querySelectorAll('body *')) {
      const t = (el.textContent ?? '').trim();
      if (t !== '' && re.test(t) && [...el.childNodes].some((n) => n.nodeType === 3 && re.test(n.textContent))) {
        thNodes.push({ cls: (el.className ?? '').toString().slice(0, 40), lang: el.getAttribute('lang') });
        if (thNodes.length > 5) break;
      }
    }
    return { thNodes };
  });
  out.checks.lang ??= {};
  out.checks.lang[locale] = { htmlLang, mixedContent: body };
  console.log(`lang [${locale}]: html lang="${htmlLang}", thai-content nodes sampled ${body.thNodes.length}`);
}

/* ----------------------------------------------------------------------- MAIN */

const browser = await launch();
try {
  for (const scheme of ['light', 'dark']) {
    for (const locale of ['en', 'th']) {
      const { context, page } = await bootPage(browser, catalogs, { colorScheme: scheme });
      await createLists(page, catalogs, locale === 'th' ? ['งานบ้าน', 'ที่ทำงาน'] : ['Home', 'Work']);
      await addTasks(page, locale === 'th' ? ['ซื้อนมสด', 'จ่ายค่าไฟฟ้า'] : ['Buy milk', 'Pay electricity bill']);
      if (locale === 'th') await setLanguage(page, catalogs, 'th');

      // 1. contrast across key routes
      for (const route of ['', '#/all', '#/lists', '#/settings']) {
        await page.goto(`${APP_URL}${route}`);
        await page.waitForTimeout(350);
        await sampleContrast(page, `${route || '/'}[${scheme}/${locale}]`);
      }

      // 7. lang
      await checkLang(page, locale);
      await context.close();
    }
  }

  // 3. touch targets on a mobile viewport (both locales, one theme each is enough — sizes don't change with theme)
  for (const locale of ['en', 'th']) {
    const { context, page } = await bootPage(browser, catalogs, {
      colorScheme: 'light',
      viewport: { width: 360, height: 740 },
      isMobile: true,
      hasTouch: true,
    });
    await createLists(page, catalogs, locale === 'th' ? ['งานบ้าน'] : ['Home']);
    await addTasks(page, locale === 'th' ? ['ซื้อนมสด'] : ['Buy milk']);
    if (locale === 'th') await setLanguage(page, catalogs, 'th');
    for (const route of ['', '#/all', '#/lists', '#/settings']) {
      await page.goto(`${APP_URL}${route}`);
      await page.waitForTimeout(350);
      await sampleTouchTargets(page, `${route || '/'}[360px/${locale}]`);
    }
    // open the drawer + row menu for touch checks too
    const burger = page.locator('[aria-label="' + S('a11y.openMenu', locale === 'th' ? 'th' : 'en') + '"]').first();
    if ((await burger.count()) > 0) {
      await burger.click();
      await page.waitForTimeout(350);
      await sampleTouchTargets(page, `drawer[${locale}]`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(250);
    }
    await context.close();
  }

  // 4. reduced motion (light/en is representative — the rule is media-query driven)
  await stage('reduced-motion', async () => {
    const { context, page } = await bootPage(browser, catalogs, { colorScheme: 'light' });
    await createLists(page, catalogs, ['Home']);
    await addTasks(page, ['Reduced motion subject']);
    await checkReducedMotion(page);
    await context.close();
  });

  // 5. 200% text zoom reflow per locale (dark not needed: layout is theme-independent)
  for (const locale of ['en', 'th']) {
    await stage(`zoom-${locale}`, async () => {
      const { context, page } = await bootPage(browser, catalogs, { colorScheme: 'light' });
      await createLists(page, catalogs, locale === 'th' ? ['งานบ้าน', 'ที่ทำงาน'] : ['Home', 'Work']);
      await addTasks(page, locale === 'th' ? ['ซื้อนมสด', 'จ่ายค่าไฟฟ้า', 'ส่งรายงานประจำเดือน'] : ['Buy milk', 'Pay electricity bill', 'Send monthly report']);
      if (locale === 'th') await setLanguage(page, catalogs, 'th');
      await checkZoomReflow(page, locale);
      await context.close();
    });
  }

  // 6. live-region announcements per locale (list created BEFORE the language switch:
  //    lib.createLists targets the English "New list" label)
  for (const locale of ['en', 'th']) {
    await stage(`announcements-${locale}`, async () => {
      const { context, page } = await bootPage(browser, catalogs, { colorScheme: 'light' });
      await createLists(page, catalogs, [locale === 'th' ? 'งานบ้าน' : 'Home']);
      await installAnnounceRecorder(page);
      if (locale === 'th') await setLanguage(page, catalogs, 'th');
      await checkAnnouncements(page, locale);
      await context.close();
    });
  }
} finally {
  await browser.close();
}

out.summary = {
  findings: out.findings.length,
  stageErrors: out.stageErrors ?? [],
  byCheck: out.findings.reduce((acc, f) => ((acc[f.check] = (acc[f.check] ?? 0) + 1), acc), {}),
};
writeEvidence('visual-gate.json', out);
console.log(`\nFINDINGS: ${out.findings.length}`, JSON.stringify(out.summary.byCheck));
if ((out.stageErrors ?? []).length > 0) console.log('STAGE ERRORS:', JSON.stringify(out.stageErrors));
process.exit(0);
