/** Does a11y.taskAdded survive on the SECOND add (first-write persistence notice is one-shot)? */
import { APP_URL, addTasks, bootPage, clearAnnounces, createLists, installAnnounceRecorder, launch, loadCatalogs, readAnnounces, writeEvidence } from './lib.mjs';

const catalogs = loadCatalogs();
const browser = await launch();
const out = { steps: [] };
try {
  const { context, page } = await bootPage(browser, catalogs, { colorScheme: 'light' });
  await createLists(page, catalogs, ['Home']);
  await installAnnounceRecorder(page);
  await page.goto(`${APP_URL}#/all`);
  await page.waitForTimeout(500);

  const add = async (title) => {
    const input = page.locator('main .composer input[type="text"]').first();
    await input.click();
    await input.fill(title);
    await input.press('Enter');
    await page.waitForTimeout(900);
    const ann = await readAnnounces(page);
    out.steps.push({ title, polite: ann.polite, assertive: ann.assertive });
    await clearAnnounces(page);
  };

  await add('First task');
  await add('Second task');
  await add('Third task');
  await context.close();
} finally {
  await browser.close();
}
writeEvidence('task-added-followup.json', out);
console.log(JSON.stringify(out, null, 2));
process.exit(0);
