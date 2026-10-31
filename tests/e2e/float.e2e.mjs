// Phase 1 Stage 2 browser test: float settings -> open period -> issue -> reverse -> issue -> close -> rep's My Float.
// Runs the built app against the in-memory Firestore fake (no network). Build first:
//   cd tests && npx vite build --config e2e/vite.config.mjs --configLoader native && node e2e/float.e2e.mjs
import { serveDist, newBrowser, Results, expect } from './harness.mjs';
import { seedData } from './seed.mjs';

const SHOTS = process.env.FLOAT_SHOTS || '';
const { server, url } = await serveDist();
const { browser, context } = await newBrowser();
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('dialog', d => d.accept(d.type() === 'prompt' ? 'Wrong amount typed' : undefined));
const R = new Results();

const seed = seedData();
seed['users/u_mgr'] = { name: 'Manager', email: 'mgr@naisi.test' };
await page.goto(url);
await page.evaluate((d) => window.__fake.seed(d), seed);
await page.reload();

async function login(email) {
  await page.fill('#loginEmail', email); await page.fill('#loginPassword', 'pw'); await page.click('#loginBtn');
  await page.waitForFunction(() => !document.querySelector('#appLoadingOverlay.visible'), null, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(400);
}
const nav = async (id) => { await page.evaluate((i) => document.getElementById(i).click(), id); await page.waitForTimeout(500); };
const text = (sel) => page.locator(sel).innerText();
const shot = async (n) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true }); };

await login('mgr@naisi.test');

await R.check('F1', 'manager sees the Phase 1 tabs; Float Periods is empty before settings', async () => {
  for (const id of ['navFloatPeriodsBtn', 'navFloatSettingsBtn', 'navVehiclesBtn', 'navProductCostsBtn']) {
    expect(await page.locator('#' + id).isVisible(), id + ' hidden');
  }
  expect(!(await page.locator('#navMyFloatBtn').isVisible()), 'My Float should be hidden for a manager');
  await nav('navFloatPeriodsBtn');
  expect((await text('#fpBoard')).includes('No floats yet'), 'expected empty-state');
});

await R.check('F2', 'set a 20,000 float for Rep One with two categories', async () => {
  await nav('navFloatSettingsBtn');
  await page.selectOption('#floatStaffSelect', 'u_rep1');
  await page.click('#loadFloatSettingsBtn');
  await page.fill('#floatTargetInput', '20000');
  await page.check('#floatCategoryCheckboxes input[value="Transport"]');
  await page.check('#floatCategoryCheckboxes input[value="EmergencyCash"]');
  await page.click('#saveFloatSettingsBtn');
  await page.waitForTimeout(400);
  const s = await page.evaluate(() => window.__fake.get('floatSettings/u_rep1'));
  expect(s && s.floatTarget === 20000, 'target not saved: ' + JSON.stringify(s));
  expect(JSON.stringify(s.allowedCategories) === '["Transport","EmergencyCash"]', 'categories ' + JSON.stringify(s.allowedCategories));
  expect((await text('#floatSettingsBody')).includes('Emergency Cash'), 'list should show labels');
});

await R.check('F3', 'open a period with opening balance 2,000', async () => {
  await nav('navFloatPeriodsBtn');
  await page.click('.fp-manage-btn[data-uid="u_rep1"]');
  await page.waitForSelector('#fpOpeningInput');
  await page.fill('#fpOpeningInput', '2000');
  await page.click('#fpOpenBtn');
  await page.waitForSelector('#fpShowIssueBtn', { timeout: 5000 });
  const s = await page.evaluate(() => window.__fake.get('floatSettings/u_rep1'));
  expect(s.openPeriodId && s.openPeriodId.startsWith('fp_u_rep1_'), 'pointer ' + s.openPeriodId);
  const d = await text('#fpDetail');
  expect(d.includes('18,000') || d.includes('18000'), 'top-up to target should be 18,000: ' + d.slice(0, 300));
});

await R.check('F4', 'issue is pre-filled with the top-up; issue 5,000; double click writes one record', async () => {
  await page.click('#fpShowIssueBtn');
  const pre = await page.inputValue('#fpIssueAmount');
  expect(pre === '18000', 'prefill ' + pre);
  await page.fill('#fpIssueAmount', '5000');
  await page.evaluate(() => { const b = document.getElementById('fpIssueBtn'); b.click(); b.click(); });
  await page.waitForTimeout(800);
  const recs = await page.evaluate(() => window.__fake.list('moneyIssued'));
  expect(recs.length === 1, 'records: ' + recs.length);
  const s = await page.evaluate(() => window.__fake.get('floatSettings/u_rep1'));
  const p = await page.evaluate((id) => window.__fake.get('floatPeriods/' + id), s.openPeriodId);
  expect(p.totalIssued === 5000, 'totalIssued ' + p.totalIssued);
  await page.waitForSelector('#fpVerifyMsg:has-text("matches")', { timeout: 3000 });
  await shot('f4-open-period');
});

await R.check('F5', 'reverse the issue: total back to 0, both records kept', async () => {
  await page.click('.fp-reverse-btn');
  await page.waitForTimeout(800);
  const recs = await page.evaluate(() => window.__fake.list('moneyIssued'));
  expect(recs.length === 2, 'records: ' + recs.length);
  const s = await page.evaluate(() => window.__fake.get('floatSettings/u_rep1'));
  const p = await page.evaluate((id) => window.__fake.get('floatPeriods/' + id), s.openPeriodId);
  expect(p.totalIssued === 0, 'totalIssued ' + p.totalIssued);
  expect((await text('#fpDetail')).includes('Issue (reversed)'), 'reversed row label');
  expect(await page.locator('.fp-reverse-btn').count() === 0, 'no reverse button left');
});

await R.check('F6', 'issue 8,000 by mobile money with a reference', async () => {
  await page.click('#fpShowIssueBtn');
  await page.fill('#fpIssueAmount', '8000');
  await page.selectOption('#fpIssueMethod', 'mobile');
  await page.fill('#fpIssueRef', 'MP241031.1234');
  await page.click('#fpIssueBtn');
  await page.waitForTimeout(800);
  const d = await text('#fpDetail');
  expect(d.includes('MP241031.1234') && d.includes('Mobile money'), 'row not shown');
  expect((await text('#fpBoard')).includes('10,000') || (await text('#fpBoard')).includes('10000'), 'board balance 10,000');
});

await R.check('F7', 'close: closing 10,000, proposed top-up 10,000; pointer cleared; next period pre-fills 10,000', async () => {
  const s0 = await page.evaluate(() => window.__fake.get('floatSettings/u_rep1'));
  await page.click('#fpShowCloseBtn');
  await page.fill('#fpCloseNotes', 'Cash counted with rep');
  await page.click('#fpCloseBtn');
  await page.waitForSelector('#fpOpeningInput', { timeout: 5000 });
  const p = await page.evaluate((id) => window.__fake.get('floatPeriods/' + id), s0.openPeriodId);
  expect(p.status === 'closed' && p.closingBalance === 10000 && p.proposedTopUp === 10000, JSON.stringify(p));
  const s = await page.evaluate(() => window.__fake.get('floatSettings/u_rep1'));
  expect(s.openPeriodId === null && s.lastClosingBalance === 10000, JSON.stringify(s));
  expect(await page.inputValue('#fpOpeningInput') === '10000', 'next opening prefill');
  expect((await text('#fpDetail')).includes('Closed periods'), 'history shown');
  await shot('f7-closed');
});

await R.check('F8', 'open the next period, then rep sees My Float with balance and no other tabs leaking', async () => {
  await page.click('#fpOpenBtn');
  await page.waitForSelector('#fpShowIssueBtn', { timeout: 5000 });
  await page.click('#logoutBtn');
  await page.waitForTimeout(600);
  await login('rep1@naisi.test');
  expect(await page.locator('#navMyFloatBtn').isVisible(), 'My Float tab hidden for rep');
  expect(!(await page.locator('#navFloatPeriodsBtn').isVisible()), 'Float Periods visible to rep');
  await nav('navMyFloatBtn');
  const b = await text('#myFloatBody');
  expect(b.includes('10,000') || b.includes('10000'), 'balance: ' + b.slice(0, 300));
  expect(b.includes('No money issued'), 'new period has no movements');
  await shot('f8-rep-my-float');
});

await R.check('F9', 'the live expense form for a rep still offers only Transport, Meals, Other', async () => {
  await nav('navExpensesBtn');
  const opts = await page.$$eval('#expCategory option', os => os.map(o => o.value));
  expect(JSON.stringify(opts) === '["Transport","Meals","Other"]', JSON.stringify(opts));
});

await R.check('F10', 'no page errors', async () => { expect(errors.length === 0, errors.join(' | ')); });

await browser.close(); server.close();
const failed = R.rows.filter(r => r.status !== 'PASS');
console.log(`\n${R.rows.length - failed.length}/${R.rows.length} passed`);
process.exit(failed.length ? 1 : 0);
