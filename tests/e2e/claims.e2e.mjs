// Phase 1 Stage 3 browser test: rep and driver expense claims, close guard, manager approvals feeding the float.
//   cd tests && npx vite build --config e2e/vite.config.mjs --configLoader native && node e2e/claims.e2e.mjs
import { serveDist, newBrowser, Results, expect } from './harness.mjs';
import { seedData } from './seed.mjs';

const SHOTS = process.env.FLOAT_SHOTS || '';
const { server, url } = await serveDist();
const { browser, context } = await newBrowser();
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
let promptAnswer = 'No receipt';
page.on('dialog', d => d.accept(d.type() === 'prompt' ? promptAnswer : undefined));
const R = new Results();

const seed = seedData();
seed['config/roles'] = { ...seed['config/roles'], deliverers: ['deliv@naisi.test'] };
seed['users/u_mgr'] = { name: 'Manager', email: 'mgr@naisi.test' };
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
const text = (sel) => page.locator(sel).innerText();
const shot = async (n) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true }); };
const fake = (fn, arg) => page.evaluate(fn, arg);
const period = async (uid) => { const s = await fake((u) => window.__fake.get('floatSettings/' + u), uid); return fake((id) => window.__fake.get('floatPeriods/' + id), s.openPeriodId); };

async function setFloat(uid, target) {
  await nav('navFloatSettingsBtn');
  await page.selectOption('#floatStaffSelect', uid);
  await page.click('#loadFloatSettingsBtn');
  await page.fill('#floatTargetInput', String(target));
  await page.click('#saveFloatSettingsBtn');
  await page.waitForTimeout(400);
  await nav('navFloatPeriodsBtn');
  await page.click(`.fp-manage-btn[data-uid="${uid}"]`);
  await page.waitForSelector('#fpOpenBtn'); await page.fill('#fpOpeningInput', '0'); await page.click('#fpOpenBtn');
  await page.waitForSelector('#fpShowIssueBtn'); await page.click('#fpShowIssueBtn'); await page.click('#fpIssueBtn');
  await page.waitForTimeout(600);
}
async function addClaim({ category, sub, amount, notes, vehicle }) {
  await page.selectOption('#clCategory', category);
  if (sub) await page.selectOption('#clSub', sub);
  if (vehicle) await page.selectOption('#clVehicle', vehicle);
  await page.fill('#clAmount', String(amount));
  await page.fill('#clNotes', notes);
  await page.click('#clSaveLineBtn');
  await page.waitForTimeout(500);
}

// The driver signs in once first (no profile saved): the login itself must make them selectable for a float.
await login('deliv@naisi.test');
await logout();
await login('mgr@naisi.test');
await R.check('C0', 'the float picker lists reps and the driver (by role), not the manager', async () => {
  await nav('navFloatSettingsBtn');
  const labels = await page.$$eval('#floatStaffSelect option', os => os.map(o => o.textContent));
  expect(labels.some(l => l.includes('deliv@naisi.test (Driver)')), JSON.stringify(labels));
  expect(labels.some(l => l.includes('Rep One (Sales rep)')), JSON.stringify(labels));
  expect(!labels.some(l => l.includes('Manager')), JSON.stringify(labels));
});
await R.check('C1', 'manager sets 20,000 floats for a rep and a driver, opens periods, issues the float, adds a vehicle', async () => {
  await setFloat('u_rep1', 20000);
  await setFloat('u_deliv', 20000);
  expect((await period('u_rep1')).totalIssued === 20000 && (await period('u_deliv')).totalIssued === 20000, 'issued');
  await nav('navVehiclesBtn');
  await page.fill('#vehicleRegInput', 'mw 1234 a'); await page.fill('#vehicleDescInput', 'Nissan UD truck'); await page.click('#saveVehicleBtn');
  await page.waitForTimeout(400);
  expect((await text('#vehiclesBody')).includes('MW 1234 A'), 'vehicle listed');
});
await logout();

await login('rep1@naisi.test');
let repReportId;
await R.check('C2', 'rep drafts a report: 3 lines, edits one, removes one; Fuel and driver categories are not offered', async () => {
  await nav('navMyFloatBtn');
  await page.waitForSelector('#clNewBtn');
  await page.click('#clNewBtn');
  await page.waitForSelector('#clCategory');
  const opts = await page.$$eval('#clCategory option', os => os.map(o => o.value));
  expect(JSON.stringify(opts) === '["Transport","Meals","Other","EmergencyCash"]', JSON.stringify(opts));
  await addClaim({ category: 'Transport', sub: 'Minibus', amount: 1500, notes: 'Minibus Area 25 to Kanengo' });
  await addClaim({ category: 'Meals', sub: 'Lunch', amount: 800, notes: 'Lunch on route' });
  await addClaim({ category: 'EmergencyCash', sub: 'Vehicle Breakdown', amount: 3000, notes: 'Push start' });
  await page.locator('.cl-edit-btn').nth(1).click();          // Meals
  await page.waitForSelector('#clCancelEditBtn');
  await page.fill('#clAmount', '900'); await page.click('#clSaveLineBtn'); await page.waitForTimeout(500);
  await page.locator('.cl-remove-btn').nth(2).click(); await page.waitForTimeout(500);
  const reports = await fake(() => window.__fake.list('expenseReports'));
  expect(reports.length === 1 && reports[0].lineCount === 2, JSON.stringify(reports.map(r => r.lineCount)));
  repReportId = reports[0].id;
  const lines = await fake(() => window.__fake.list('expenseLines'));
  expect(JSON.stringify(lines.map(l => l.amount).sort()) === '[1500,900]', JSON.stringify(lines.map(l => l.amount)));
  expect(lines.find(l => l.amount === 900).subcategory === 'Lunch', 'subcategory kept on edit');
});
await R.check('C3', 'rep submits; the report locks', async () => {
  await page.click('#clSubmitBtn'); await page.waitForTimeout(600);
  const r = await fake((id) => window.__fake.get('expenseReports/' + id), repReportId);
  expect(r.status === 'submitted', r.status);
  expect(await page.locator('#clSaveLineBtn').count() === 0 && await page.locator('.cl-edit-btn').count() === 0, 'still editable');
  expect((await text('#myFloatBody')).includes('Waiting for approval'), 'status label');
  await shot('c3-rep-submitted');
});
await logout();

await login('mgr@naisi.test');
await R.check('C4', 'closing the rep\'s period is blocked while the report waits', async () => {
  await nav('navFloatPeriodsBtn');
  await page.click('.fp-manage-btn[data-uid="u_rep1"]');
  await page.waitForSelector('#fpShowCloseBtn'); await page.click('#fpShowCloseBtn'); await page.click('#fpCloseBtn');
  await page.waitForTimeout(600);
  expect((await period('u_rep1')).status === 'open', 'period was closed');
});
await R.check('C5', 'approvals queue: approve Transport, reject Meals with a reason; float falls by 1,500 only', async () => {
  await nav('navApprovalsBtn');
  expect((await text('#approvalsBody')).includes('1 report(s) waiting'), 'queue count');
  await page.click('.ap-open-btn');
  await page.waitForSelector('.ap-approve-btn');
  expect((await text('#approvalsDetail')).includes('Float balance now'), 'float context shown');
  await shot('c5-review');
  const rows = page.locator('#approvalsDetail tbody tr');
  const idx = (await rows.allInnerTexts()).findIndex(t => t.includes('Minibus'));
  await rows.nth(idx).locator('.ap-approve-btn').click(); await page.waitForTimeout(600);
  promptAnswer = 'No receipt for lunch';
  await page.locator('.ap-reject-btn').first().click(); await page.waitForTimeout(800);
  const r = await fake((id) => window.__fake.get('expenseReports/' + id), repReportId);
  expect(r.status === 'reviewed' && r.approvedTotal === 1500 && r.rejectedTotal === 900, JSON.stringify(r));
  const p = await period('u_rep1');
  expect(p.totalApproved === 1500, 'totalApproved ' + p.totalApproved);
  expect((await text('#approvalsBody')).includes('Nothing waiting'), 'queue empty');
});
await R.check('C6', 'Float Periods shows the rep at 18,500 (20,000 issued − 1,500 approved)', async () => {
  await nav('navFloatPeriodsBtn');
  const b = await text('#fpBoard');
  expect(b.includes('18,500'), b.slice(0, 300));
});
await logout();

await login('rep1@naisi.test');
await R.check('C7', 'rep sees balance 18,500 and the manager\'s rejection reason', async () => {
  await nav('navMyFloatBtn');
  await page.waitForSelector('.cl-open-btn');
  expect((await text('#myFloatBody')).includes('18,500'), 'balance');
  await page.click('.cl-open-btn'); await page.waitForTimeout(500);
  const t = await text('#myFloatBody');
  expect(t.includes('No receipt for lunch') && t.includes('Rejected') && t.includes('Approved'), t.slice(0, 400));
  await shot('c7-rep-reviewed');
});
await logout();

await login('deliv@naisi.test');
await R.check('C8', 'driver claims Vehicle/Maintenance with the vehicle from the delivery screen', async () => {
  await page.click('#deliveryFloatToggleBtn');
  await page.waitForSelector('#clNewBtn'); await page.click('#clNewBtn'); await page.waitForSelector('#clCategory');
  const opts = await page.$$eval('#clCategory option', os => os.map(o => o.value));
  expect(JSON.stringify(opts) === '["Transport","Meals","Other","VehicleMaintenance"]', JSON.stringify(opts));
  const vehicleId = (await fake(() => window.__fake.list('vehicles')))[0].id;
  await addClaim({ category: 'VehicleMaintenance', sub: 'Tyre Repair', amount: 6000, notes: 'Puncture repair Lumbadzi', vehicle: vehicleId });
  const line = (await fake(() => window.__fake.list('expenseLines'))).find(l => l.ownerUid === 'u_deliv');
  expect(line && line.vehicleId === vehicleId && line.subcategory === 'Tyre Repair', JSON.stringify(line));
  await page.click('#clSubmitBtn'); await page.waitForTimeout(600);
  await shot('c8-driver-claim');
});
await logout();

await login('mgr@naisi.test');
await R.check('C9', 'manager approves the driver report; driver float 14,000', async () => {
  await nav('navApprovalsBtn');
  await page.click('.ap-open-btn'); await page.waitForSelector('.ap-approve-btn');
  expect((await text('#approvalsDetail')).includes('Driver') || (await text('#approvalsBody')).includes('Driver'), 'role shown');
  await page.click('.ap-approve-btn'); await page.waitForTimeout(800);
  expect((await period('u_deliv')).totalApproved === 6000, 'driver approved');
});
await R.check('C10', 'no page errors', async () => { expect(errors.length === 0, errors.join(' | ')); });

await browser.close(); server.close();
const failed = R.rows.filter(r => r.status !== 'PASS');
console.log(`\n${R.rows.length - failed.length}/${R.rows.length} passed`);
process.exit(failed.length ? 1 : 0);
