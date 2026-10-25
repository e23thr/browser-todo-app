// Discriminator probe: when CSP blocks a GENUINE page-authored style attribute, what do we see
// at securitypolicyviolation time? (design input for the page-vs-UA attribution rule)
import { webkit, chromium } from 'playwright-core';

const HTML = (extra) => `<!doctype html>
<html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'">
</head><body>
<div id="probe-target">hi</div>
${extra}
</body></html>`;

const INIT = () => {
  window.__v = [];
  document.addEventListener('securitypolicyviolation', (e) => {
    const t = e.target;
    window.__v.push({
      directive: e.violatedDirective,
      blockedURI: e.blockedURI,
      sample: JSON.stringify(e.sample),
      sourceFile: e.sourceFile,
      line: e.lineNumber,
      targetTag: t ? t.tagName || String(t) : 'null',
      targetHasStyle: t && t.hasAttribute ? t.hasAttribute('style') : 'n/a',
      targetStyleAttr: t && t.getAttribute ? JSON.stringify(t.getAttribute('style')) : 'n/a',
      isSelect: t instanceof HTMLSelectElement,
    });
  });
};

async function probePage(browser, body, after) {
  const page = await browser.newPage();
  await page.addInitScript(INIT);
  await page.route('http://probe.local/p', (route) =>
    route.fulfill({ body: HTML(body), contentType: 'text/html' }),
  );
  await page.goto('http://probe.local/p');
  if (after) await after(page);
  const v = await page.evaluate(() => window.__v);
  await page.close();
  return v;
}

for (const [name, engine] of [
  ['webkit', webkit],
  ['chromium', chromium],
]) {
  const browser = await engine.launch();

  const fromMarkup = await probePage(browser, '<div id="genuine" style="color: red">styled</div>');

  const fromSetAttribute = await probePage(browser, '', (p) =>
    p.evaluate(() => {
      const d = document.createElement('div');
      d.setAttribute('style', 'color: blue');
      document.body.append(d);
    }),
  );

  const fromSelect = await probePage(browser, '', (p) =>
    p.evaluate(() => {
      const s = document.createElement('select');
      s.id = 'settings-default-list';
      document.body.append(s);
      s.remove();
    }),
  );

  console.log(`== ${name} ==`);
  console.log('A markup style=      :', JSON.stringify(fromMarkup));
  console.log('B setAttribute style :', JSON.stringify(fromSetAttribute));
  console.log('C bare select        :', JSON.stringify(fromSelect));
  await browser.close();
}
