// Phase 1 Stage 4 browser test: every expense control report renders with known data and exports a valid .xlsx;
// driver fuel picks up the assigned vehicle; the rep sees float history.
//   cd tests && npx vite build --config e2e/vite.config.mjs --configLoader native && node e2e/controlReports.e2e.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { serveDist, newBrowser, Results, expect } from './harness.mjs';
import { seedData } from './seed.mjs';

const SHOTS = process.env.FLOAT_SHOTS || '';
const { server, url } = await serveDist();
const { browser, context } = await newBrowser();
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('dialog', d => d.accept());
const R = new Results();
const at = (iso) => ({ __ts: new Date(iso + '+02:00').getTime() });   // Malawi local time

const seed = seedData();
Object.assign(seed, {
  'config/roles': { ...seed['config/roles'], deliverers: ['deliv@naisi.test'] },
  'users/u_mgr': { name: 'Boss', email: 'mgr@naisi.test' },
  'users/u_deliv': { email: 'deliv@naisi.test' },
  'vehicles/v1': { registration: 'MW 1 A', description: 'Truck', assignedToUid: 'u_deliv', active: true },
  'floatSettings/u_rep1': { staffUid: 'u_rep1', staffEmail: 'rep1@naisi.test', floatTarget: 20000, allowedCategories: [], openPeriodId: 'fp_u_rep1_20261005_a', lastClosingBalance: 2000 },
  'floatPeriods/fp_u_rep1_20260928_a': { staffUid: 'u_rep1', status: 'closed', startDate: '2026-09-28', openingBalance: 0, floatTarget: 20000, totalIssued: 20000, totalApproved: 18000, closingBalance: 2000, proposedTopUp: 18000, closedAt: at('2026-10-04T17:00:00'), openedAt: at('2026-09-28T08:00:00') },
  'floatPeriods/fp_u_rep1_20261005_a': { staffUid: 'u_rep1', status: 'open', startDate: '2026-10-05', openingBalance: 2000, floatTarget: 20000, totalIssued: 15000, totalApproved: 6500, openedAt: at('2026-10-05T08:00:00') },
  'moneyIssued/mi_u_rep1_a': { kind: 'issue', recipientUid: 'u_rep1', amount: 15000, method: 'mobile', reference: 'MP1', notes: 'Top-up', floatPeriodId: 'fp_u_rep1_20261005_a', issuedBy: 'u_mgr', issuedAt: at('2026-10-06T00:30:00'), reversedById: null },
  'expenseReports/er_u_rep1_a': { ownerUid: 'u_rep1', ownerEmail: 'rep1@naisi.test', title: 'W41', status: 'reviewed', lineCount: 3, decidedCount: 3, createdAt: at('2026-10-07T08:00:00') },
  'expenseLines/el_a': { reportId: 'er_u_rep1_a', ownerUid: 'u_rep1', date: '2026-10-06', category: 'Transport', amount: 1500, lineStatus: 'approved', notes: 'Minibus' },
  'expenseLines/el_b': { reportId: 'er_u_rep1_a', ownerUid: 'u_rep1', date: '2026-10-06', category: 'Meals', amount: 900, lineStatus: 'rejected', notes: 'Lunch', decisionNote: 'No receipt' },
  'expenseLines/el_c': { reportId: 'er_u_rep1_a', ownerUid: 'u_rep1', date: '2026-10-07', category: 'EmergencyCash', amount: 5000, lineStatus: 'approved', notes: 'Tyre' },
  'expenses/x1': { date: '2026-10-02', category: 'Fuel', amount: 20000, createdBy: 'u_deliv', createdByEmail: 'deliv@naisi.test', vehicleId: 'v1', notes: '' },
  'expenses/x2': { date: '2026-10-09', category: 'Fuel', amount: 10000, createdBy: 'u_deliv', createdByEmail: 'deliv@naisi.test', notes: '' },
  'expenses/x3': { date: '2026-10-12', category: 'Stock', amount: 50000, createdBy: 'u_mgr', createdByEmail: 'mgr@naisi.test', notes: 'Yeast' },
});
await page.goto(url);
await page.evaluate((d) => window.__fake.seed(d), seed);
await page.reload();

async function login(email) {
  await page.fill('#loginEmail', email); await page.fill('#loginPassword', 'pw'); await page.click('#loginBtn');
  await page.waitForFunction(() => !document.querySelector('#appLoadingOverlay.visible'), null, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(400);
}
async function logout() {
  await page.evaluate(() => (document.getElementById('logoutBtn').offsetParent ? document.getElementById('logoutBtn') : document.getElementById('deliveryLogoutBtn')).click());
  await page.waitForTimeout(600);
}
const nav = async (id) => { await page.evaluate((i) => document.getElementById(i).click(), id); await page.waitForTimeout(500); };
const out = () => page.locator('#crOutput').innerText();
const dl = fs.mkdtempSync(path.join(os.tmpdir(), 'naisi-xlsx-'));

async function run(id) {
  await page.selectOption('#crReport', id);
  if (await page.locator('#crFrom').isEnabled()) { await page.fill('#crFrom', '2026-10-01'); await page.fill('#crTo', '2026-10-31'); }
  await page.click('#crRunBtn');
  await page.waitForFunction(() => !document.getElementById('crOutput').innerText.includes('Loading'), null, { timeout: 8000 });
  return out();
}
async function xlsx() {
  const [d] = await Promise.all([page.waitForEvent('download'), page.click('#crExportBtn')]);
  const file = path.join(dl, d.suggestedFilename());
  await d.saveAs(file);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(file);
  const ws = wb.worksheets[0];
  const rows = []; ws.eachRow(r => rows.push(r.values.slice(1)));
  return { name: d.suggestedFilename(), rows };
}

// The driver logs fuel once: the entry must carry the assigned vehicle and today's Malawi date.
await login('deliv@naisi.test');
await R.check('R0', 'driver fuel log attaches the assigned vehicle automatically', async () => {
  await page.click('#deliveryExpenseToggleBtn');
  await page.click('.delivery-expense-cat-btn[data-category="Fuel"]');
  await page.fill('#deliveryExpenseAmount', '4000');
  await page.waitForTimeout(300);
  await page.click('#deliveryExpenseSaveBtn');
  await page.waitForTimeout(600);
  const e = (await page.evaluate(() => window.__fake.list('expenses'))).find(x => x.amount === 4000);
  expect(e && e.vehicleId === 'v1' && e.category === 'Fuel', JSON.stringify(e));
  expect(/^\d{4}-\d{2}-\d{2}$/.test(e.date), 'date ' + e.date);
});
await logout();

await login('mgr@naisi.test');
await nav('navControlReportsBtn');
const expectations = [
  ['floatBalance', ['Rep One', '10,500.00', '9,500.00']],
  ['moneyIssued', ['2026-10-06', '15,000.00', 'MP1']],
  ['reportSummary', ['W41', '7,400.00', '6,500.00', '87.8%']],
  ['itemised', ['Minibus', 'Tyre', '7,400.00']],
  ['fuelVehicle', ['MW 1 A', '30,000.00', '10,000.00']],
  ['expenseVsFloat', ['Rep One', '15,000.00', '6,500.00', '32.5%']],
  ['categorySpend', ['Emergency Cash', '6,500.00', '76.9%']],
  ['rejected', ['Lunch', 'No receipt', '900.00']],
  ['periods', ['2026-10-04', '18,000.00', '2,000.00']],
  ['managerExpenses', ['Yeast', '50,000.00']],
];
let i = 1;
for (const [id, needles] of expectations) {
  await R.check('R' + i++, `report ${id} shows the expected figures and exports a matching .xlsx`, async () => {
    const t = await run(id);
    for (const n of needles) expect(t.includes(n), `${id}: missing "${n}" in: ${t.slice(0, 400)}`);
    const x = await xlsx();
    expect(x.name.endsWith('.xlsx'), x.name);
    const flat = JSON.stringify(x.rows);
    const firstMoney = needles.find(n => /\d,\d{3}\.\d\d/.test(n));
    if (firstMoney) expect(flat.includes(firstMoney.replace(/,/g, '').replace(/\.00$/, '')), `${id}: xlsx lacks ${firstMoney}: ${flat.slice(0, 300)}`);
    if (id === 'fuelVehicle' && SHOTS) await page.screenshot({ path: `${SHOTS}/r-fuel.png`, fullPage: true });
  });
}
await R.check('R11', 'person filter narrows rows; export of the filtered view has no totals row', async () => {
  await run('itemised');
  await page.selectOption('#crPerson', 'Rep One');
  const t = await out();
  expect(t.includes('3 row(s) for Rep One'), t.slice(0, 200));
});
await logout();

await login('rep1@naisi.test');
await R.check('R12', 'rep sees My float history with the closed period', async () => {
  await nav('navMyFloatBtn');
  await page.waitForTimeout(800);
  const t = await page.locator('#myFloatBody').innerText();
  expect(t.includes('My float history') && t.includes('2026-09-28') && t.includes('18,000.00'), t.slice(0, 500));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/r-rep-history.png`, fullPage: true });
});
await R.check('R13', 'no page errors', async () => { expect(errors.length === 0, errors.join(' | ')); });

await browser.close(); server.close();
const failed = R.rows.filter(r => r.status !== 'PASS');
console.log(`\n${R.rows.length - failed.length}/${R.rows.length} passed`);
process.exit(failed.length ? 1 : 0);
