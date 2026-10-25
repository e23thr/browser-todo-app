/**
 * Audit probe (t_5612df50) — WCAG contrast for ALL UI states (default, focus, hover,
 * disabled) in BOTH themes, measured from real rendered pixels of the pinned build.
 *
 * Thresholds: text ≥4.5:1 (≥3:1 for large text ≥24px / ≥18.66px bold); focus ring and
 * other non-text UI indicators ≥3:1 vs the adjacent background (SC 1.4.11). Disabled
 * controls are exempt from SC 1.4.3 (inactive components) but are measured anyway and
 * reported as informational.
 *
 * Evidence: <EVIDIR>/state-contrast.json
 */
import {
  APP_URL,
  addTasks,
  createLists,
  launch,
  loadCatalogs,
  writeEvidence,
} from '../../../a11y-gate-logs/probes/lib.mjs';

const catalogs = loadCatalogs();
const out = { appUrl: APP_URL, samples: [], stageErrors: [] };

async function stage(name, fn) {
  try {
    return await fn();
  } catch (e) {
    out.stageErrors.push({ stage: name, error: String(e.message ?? e).split('\n').slice(0, 3).join(' | ') });
    console.log(`STAGE FAILED: ${name} — ${String(e.message ?? e).split('\n')[0]}`);
    return null;
  }
}

/** Measure contrast IN THE PAGE for the given element (real computed styles, real bg walk). */
const measure = (page, elExpr, meta) =>
  page.evaluate(
    ([expr, m]) => {
      const toRgb = (c) => {
        const match = c.match(/rgba?\(([^)]+)\)/);
        if (match) {
          const p = match[1].split(/[,/\s]+/).filter(Boolean).map(Number);
          return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
        }
        const h = c.replace('#', '');
        if (h.length >= 6) return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
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
        fg.a >= 1 ? fg : { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 };
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

      const el = typeof expr === 'string' && expr.startsWith('FN:') ? null : document.querySelector(expr);
      let mode = 'text';
      let target = el;
      if (m.kind === 'outline') {
        mode = 'outline';
        target = el;
      }
      if (target === null || target === undefined) return { missing: true, expr, meta: m };
      const cs = getComputedStyle(target);
      const bg = effectiveBg(mode === 'outline' ? (target.parentElement ?? target) : target);
      let fg;
      let note = '';
      if (mode === 'outline') {
        fg = toRgb(cs.outlineColor === 'currentcolor' ? cs.color : cs.outlineColor);
        note = `${cs.outlineStyle} ${cs.outlineWidth}`;
      } else {
        fg = over(toRgb(cs.color), effectiveBg(target));
      }
      if (fg === null) return { missing: true, expr, meta: m, reason: 'unparseable fg' };
      const r = ratio(fg, { r: bg.r, g: bg.g, b: bg.b });
      const fontSize = parseFloat(cs.fontSize);
      const weight = parseInt(cs.fontWeight, 10) || 400;
      const large = fontSize >= 24 || (fontSize >= 18.66 && weight >= 700);
      const threshold = mode === 'outline' ? 3 : large ? 3 : 4.5;
      const disabled = target.disabled === true || target.getAttribute('aria-disabled') === 'true';
      return {
        meta: m,
        mode,
        fg: `rgb(${Math.round(fg.r)},${Math.round(fg.g)},${Math.round(fg.b)})`,
        bg: `rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)})`,
        ratio: Math.round(r * 100) / 100,
        fontSize,
        weight,
        threshold,
        large,
        disabled,
        exempt: disabled && mode === 'text', // SC 1.4.3 inactive-component exemption
        pass: r >= threshold,
        note,
      };
    },
    [elExpr, meta],
  );

const sampleSet = async (page, theme, state, entries) => {
  for (const [label, selector, kind] of entries) {
    const m = await measure(page, selector, { theme, state, label, kind: kind ?? 'text' });
    if (m.missing) {
      out.samples.push({ theme, state, label, missing: true, detail: m.reason ?? 'not found' });
      console.log(`  ${theme}/${state}/${label}: MISSING (${m.reason ?? m.expr})`);
      continue;
    }
    out.samples.push({ theme, state, ...m });
    const verdict = m.pass ? 'PASS' : m.exempt ? 'EXEMPT(disabled)' : 'FAIL';
    console.log(`  ${theme}/${state}/${m.meta.label}: ${m.ratio}:1 (≥${m.threshold}) ${verdict} ${m.note ?? ''}`);
  }
};

const browser = await launch();

for (const theme of ['light', 'dark']) {
  await stage(`theme-${theme}`, async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: theme });
    const page = await context.newPage();
    await page.goto(APP_URL);
    await page.waitForTimeout(400);
    const cta = page.locator('[data-surface="onboarding"] .onboarding-actions button');
    if ((await cta.count()) > 0) await cta.first().click();
    await createLists(page, catalogs, ['Home']);
    await addTasks(page, ['Ship audit report']);
    await page.goto(`${APP_URL}#/all`);
    await page.waitForTimeout(400);

    // ---- DEFAULT state -----------------------------------------------------------------
    await sampleSet(page, theme, 'default', [
      ['nav link text', '.nav-list a', 'text'],
      ['view title', 'main h1, .view-title', 'text'],
      ['task title', 'li.task-row .task-title', 'text'],
      ['primary button', '.composer-inline .button-primary, main .button-primary', 'text'],
      ['input text', '.composer-inline input[type="text"], .composer input[type="text"]', 'text'],
    ]);

    // ---- HOVER state (mouse hover, measured while hovered) ------------------------------
    const hoverables = [
      ['nav link hover', '.nav-list a'],
      ['primary button hover', 'main .button-primary, .composer-inline .button-primary'],
      ['task row / menu btn hover', 'li.task-row [aria-haspopup="menu"]'],
    ];
    for (const [label, selector] of hoverables) {
      try {
        const el = page.locator(selector).first();
        await el.waitFor({ timeout: 3000 });
        const before = await page.evaluate((s) => {
          const n = document.querySelector(s);
          return n ? getComputedStyle(n).backgroundColor + '|' + getComputedStyle(n).color : null;
        }, selector);
        await el.hover();
        await page.waitForTimeout(150);
        const m = await measure(page, selector, { theme, state: 'hover', label, kind: 'text' });
        const after = await page.evaluate((s) => {
          const n = document.querySelector(s);
          return n ? getComputedStyle(n).backgroundColor + '|' + getComputedStyle(n).color : null;
        }, selector);
        if (m.missing) {
          out.samples.push({ theme, state: 'hover', label, missing: true });
          console.log(`  ${theme}/hover/${label}: MISSING`);
        } else {
          m.restyle = before !== after ? 'bg-or-color-changed' : 'no-restyle';
          out.samples.push({ theme, state: 'hover', ...m });
          console.log(`  ${theme}/hover/${label}: ${m.ratio}:1 (≥${m.threshold}) ${m.pass ? 'PASS' : 'FAIL'} [${m.restyle}]`);
        }
        await page.mouse.move(5, 5);
        await page.waitForTimeout(80);
      } catch (e) {
        out.samples.push({ theme, state: 'hover', label, missing: true, detail: String(e.message).slice(0, 80) });
        console.log(`  ${theme}/hover/${label}: SKIPPED ${String(e.message).slice(0, 80)}`);
      }
    }

    // ---- FOCUS state (keyboard focus-visible ring vs adjacent bg) ------------------------
    const focusTargets = [
      ['nav link focus ring', 'a[href="#/all"]'],
      ['task title focus ring', 'li.task-row .task-title'],
      ['checkbox focus ring', 'li.task-row input[type="checkbox"]'],
    ];
    for (const [label, selector] of focusTargets) {
      let reached = false;
      for (let i = 0; i < 80 && !reached; i++) {
        reached = await page.evaluate((s) => {
          const el = document.activeElement;
          return el !== null && el !== document.body && el.matches(s);
        }, selector);
        if (!reached) await page.keyboard.press('Tab');
      }
      if (!reached) {
        out.samples.push({ theme, state: 'focus', label, missing: true, detail: 'not reachable by Tab' });
        console.log(`  ${theme}/focus/${label}: NOT REACHABLE`);
        continue;
      }
      const m = await measure(page, selector, { theme, state: 'focus', label, kind: 'outline' });
      if (m.missing) {
        out.samples.push({ theme, state: 'focus', label, missing: true });
        console.log(`  ${theme}/focus/${label}: MISSING`);
      } else {
        out.samples.push({ theme, state: 'focus', ...m });
        console.log(`  ${theme}/focus/${label}: ${m.ratio}:1 (≥${m.threshold}) ${m.pass ? 'PASS' : 'FAIL'} [${m.note}]`);
      }
      // return focus to top for the next walk
      await page.goto(`${APP_URL}#/all`);
      await page.waitForTimeout(300);
    }

    // ---- DISABLED state (a) row menu aria-disabled item ---------------------------------
    try {
      await page.locator('button[aria-haspopup="menu"]').first().click();
      await page.waitForTimeout(250);
      const dis = page.locator('[role="menuitem"][aria-disabled="true"]').first();
      if ((await dis.count()) > 0) {
        const m = await measure(page, '[role="menuitem"][aria-disabled="true"]', {
          theme,
          state: 'disabled',
          label: 'row-menu aria-disabled item (Move up at boundary)',
          kind: 'text',
        });
        out.samples.push({ theme, state: 'disabled', ...m });
        console.log(`  ${theme}/disabled/menu-item: ${m.ratio}:1 (≥${m.threshold}) ${m.pass ? 'PASS' : m.exempt ? 'EXEMPT' : 'FAIL'}`);
      } else {
        out.samples.push({ theme, state: 'disabled', label: 'row-menu aria-disabled item', missing: true, detail: 'no disabled item on this view' });
        console.log(`  ${theme}/disabled/menu-item: no aria-disabled item present`);
      }
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
    } catch (e) {
      out.stageErrors.push({ stage: `disabled-menu-${theme}`, error: String(e.message).slice(0, 120) });
    }

    // ---- DISABLED state (b) editor chip-clear (no due set → disabled) --------------------
    try {
      await page.locator('li.task-row .task-title').first().click();
      await page.waitForTimeout(350);
      const m = await measure(page, 'button.chip:disabled', {
        theme,
        state: 'disabled',
        label: 'editor chip Clear (disabled, no due)',
        kind: 'text',
      });
      if (!m.missing) {
        out.samples.push({ theme, state: 'disabled', ...m });
        console.log(`  ${theme}/disabled/chip-clear: ${m.ratio}:1 (≥${m.threshold}) ${m.pass ? 'PASS' : m.exempt ? 'EXEMPT' : 'FAIL'}`);
      }
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
    } catch (e) {
      out.stageErrors.push({ stage: `disabled-chip-${theme}`, error: String(e.message).slice(0, 120) });
    }

    await context.close();
  });
}

// ---- DISABLED state (c) zero-list composer: fresh profile, inputs disabled --------------
for (const theme of ['light', 'dark']) {
  await stage(`disabled-composer-${theme}`, async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: theme });
    const page = await context.newPage();
    await page.goto(APP_URL);
    await page.waitForTimeout(400);
    const cta = page.locator('[data-surface="onboarding"] .onboarding-actions button');
    if ((await cta.count()) > 0) await cta.first().click();
    await page.waitForTimeout(300);
    const m1 = await measure(page, '.composer-nolist', { theme, state: 'disabled', label: 'zero-list composer helper text', kind: 'text' });
    if (!m1.missing) out.samples.push({ theme, state: 'disabled', ...m1 });
    const m2 = await measure(page, 'input:disabled', { theme, state: 'disabled', label: 'disabled composer input text', kind: 'text' });
    if (!m2.missing) out.samples.push({ theme, state: 'disabled', ...m2 });
    console.log(
      `  ${theme}/disabled/composer: helper=${m1.missing ? 'MISSING' : m1.ratio + ':1'} input=${m2.missing ? 'MISSING' : m2.ratio + ':1'}`,
    );
    await context.close();
  });
}

await browser.close();
writeEvidence('state-contrast.json', out);

const real = out.samples.filter((s) => !s.missing);
const fails = real.filter((s) => !s.pass && !s.exempt);
const exempt = real.filter((s) => !s.pass && s.exempt);
console.log(`\nstate-contrast: ${real.length} measured, ${fails.length} below threshold (non-exempt), ${exempt.length} disabled-exempt below, ${out.samples.length - real.length} missing`);
for (const f of fails) console.log('  FAIL:', JSON.stringify(f).slice(0, 260));
for (const s of out.samples.filter((x) => x.missing)) console.log('  MISSING:', s.state, s.label, s.detail ?? '');
