// Real-browser (Chromium) checks for the RC3 owner decisions (E26+). Same backend as visits.e2e.mjs:
// in-memory Firestore stand-in + fake sign-in. NOT the emulator and NOT the real rules (see docs/WINDOWS-TESTING.md).
import fs from 'node:fs';
import { serveDist, newBrowser, Results, expect, eq } from './harness.mjs';
import { seedData, THU } from './seed.mjs';

const OUT = process.env.E2E_OUT || '/tmp';
const R = new Results();
const { server, url } = await serveDist();
const { browser, context } = await newBrowser();
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('dialog', d => d.accept());
const fake = (fn, arg) => page.evaluate(fn, arg);
const store = (prefix) => fake((p) => window.__fake.list(p), prefix);
const doc = (path) => fake((p) => window.__fake.get(p), path);
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });
const login = async (email) => { await page.fill('#loginEmail', email); await page.fill('#loginPassword', 'pw'); await page.click('#loginBtn'); };
const logout = async () => { await page.evaluate(() => document.getElementById('logoutBtn')?.click()); await page.waitForSelector('#loginBtn', { state: 'visible' }); };
const bodyText = () => page.evaluate(() => document.body.innerText);
const toast = (re) => page.waitForFunction((s) => new RegExp(s, 'i').test(document.body.innerText), re.source, { timeout: 8000 });

const seed = ({ history = true, extra = {} } = {}) => {
  const d = seedData({ history });
  d['customers/c7'] = { name: 'Golf Duplicate', phone: '0999', location: 'Area 3', active: true, assignedDay: 'Mon', lat: -13.98, lng: 33.78 };
  d['orders/oA'] = { orderNo: 'ORD-2026-0030', status: 'Approved', stockApplied: true, customerId: 'c1', customerName: 'Alpha Shop', customerPhone: '1', customerLocation: 'Area 25', items: [{ qty: 2, desc: 'Amanda 100g', price: 1000, total: 2000, productId: 'p1' }], grandTotal: 2000, createdBy: 'u_rep1', createdByEmail: 'rep1@naisi.test', createdAt: { __ts: Date.parse('2026-10-14T08:00:00Z') }, invoiceId: null, invoiceNo: null };
  d['products/p1'] = { ...d['products/p1'], stockOnHand: 498 };
  d['orders/oInvg'] = { orderNo: 'ORD-2026-0031', status: 'Invoicing', invoicingAttempt: 'tok', invoicingLeaseStartedAt: { __ts: Date.parse('2026-10-15T07:50:00Z') }, customerId: 'c7', customerName: 'Golf Duplicate', items: [], grandTotal: 500, createdBy: 'u_rep1', createdAt: { __ts: Date.parse('2026-10-14T09:00:00Z') } };
  return { ...d, ...extra };
};
async function fresh(opts) {
  await page.clock.setFixedTime(new Date(THU));
  await page.goto(url);
  await fake((d) => window.__fake.seed(d), seed(opts));
  await page.reload();
}
async function nav(id) { await page.waitForSelector(`#${id}`, { state: 'visible' }); await page.click(`#${id}`); }

try {
  // ---------------- decision 1: customers ----------------
  await fresh();
  await login('rep1@naisi.test');
  await page.waitForSelector('#todaysRouteCard', { state: 'visible' });
  await R.check('E26', 'A rep adds a customer: saved active and UNSCHEDULED (no automatic weekday), no schedule history entry', async () => {
    await nav('navCustomersBtn');
    await page.fill('#newCustName', 'Hotel Newshop');
    await page.fill('#newCustLocation', 'Area 47');
    await fake(() => { document.getElementById('newCustLat').value = '-13.97'; document.getElementById('newCustLng').value = '33.79'; });
    await page.click('#addCustomerBtn');
    await page.waitForFunction(() => /Customer added|added/i.test(document.body.innerText), null, { timeout: 8000 });
    const c = (await store('customers')).find(x => x.name === 'Hotel Newshop');
    expect(c, 'customer not saved; page says: ' + (await bodyText()).slice(0, 300));
    eq([c.active, c.assignedDay, 'lastScheduleChangeId' in c], [true, null, false], 'new customer state');
    eq((await store('scheduleChanges')).filter(x => x.customerId === c.id).length, 0, 'history entries for a new customer');
    return c.name;
  });
  await R.check('E27', 'Unscheduled customer is not on any rep list and does not change the rep\'s Scheduled/Still-due', async () => {
    await nav('navLogVisitBtn'); await page.waitForTimeout(300);
    const names = await page.$$eval('#todaysRouteList .todays-route-item', els => els.map(e => e.innerText));
    expect(!names.some(t => /Hotel Newshop/.test(t)), 'unscheduled customer appears in the rep list');
    eq(Number(await page.locator('#vpScheduled').innerText()), 4, 'scheduled count');
    return 'scheduled 4';
  });
  await R.check('E28', 'A rep has no Deactivate/Reactivate and no visit-day control on the customer list', async () => {
    await nav('navCustomersBtn'); await page.waitForTimeout(300);
    const html = await page.evaluate(() => document.getElementById('customersView').innerHTML);
    expect(!/customer-day-select|data-action="deactivate"|data-action="reactivate"/.test(html), 'a rep sees a schedule/deactivate control');
    return 'no controls';
  });
  await logout();
  await login('mgr@naisi.test');
  await R.check('E29', 'Manager sees the new customer under "Awaiting scheduling" and schedules it; it gets a dated history entry', async () => {
    await nav('navCustomersBtn'); await page.waitForSelector('#awaitingSchedulingBox', { state: 'visible', timeout: 8000 });
    const t = await page.locator('#awaitingSchedulingList').innerText();
    expect(/Hotel Newshop/.test(t), 'awaiting list: ' + t);
    await shot('26-awaiting-scheduling');
    await page.selectOption('#awaitingSchedulingList .customer-day-select >> nth=0', 'Thu');
    await toast(/Visit day set/);
    const c = (await store('customers')).find(x => x.name === 'Hotel Newshop');
    eq(c.assignedDay, 'Thu', 'day saved');
    const e = await doc('scheduleChanges/' + c.lastScheduleChangeId);
    eq([e.kind, e.assignedDay, e.customerId], ['schedule', 'Thu', c.id], 'history entry');
    return 'scheduled Thursday';
  });
  await logout(); await login('rep2@naisi.test'); await page.waitForSelector('#todaysRouteCard', { state: 'visible' }); await page.waitForTimeout(300);
  await R.check('E30', 'After scheduling, every rep sees the customer in the shared daily list', async () => {
    const names = await page.$$eval('#todaysRouteList .todays-route-item', els => els.map(e => e.innerText));
    expect(names.some(t => /Hotel Newshop/.test(t)), 'new scheduled customer missing for rep2');
    eq(Number(await page.locator('#vpScheduled').innerText()), 5, 'scheduled count');
    return 'scheduled 5';
  });

  // ---------------- decision 2: cancellation ----------------
  await logout(); await login('mgr@naisi.test');
  await R.check('E31', 'Cancel an Approved order: reason required, order KEPT as Cancelled with actor/time/reason, stock restored once, ledger entry, no second cancel', async () => {
    await nav('navOrdersBtn'); await page.selectOption('#orderStatusFilter', 'Approved'); await page.waitForSelector('#orderListBody tr[data-id="oA"]');
    await page.click('#orderListBody tr[data-id="oA"] [data-action="cancel"]');
    await page.waitForSelector('#cancelOrderModal', { state: 'visible' });
    await page.click('#cancelOrderConfirmBtn');                                   // no reason
    expect(await page.locator('#cancelOrderError').isVisible(), 'reason should be required');
    eq((await doc('orders/oA')).status, 'Approved', 'nothing may change without a reason');
    await shot('27-cancel-modal');
    await page.fill('#cancelOrderReason', 'Customer changed their mind');
    await page.dblclick('#cancelOrderConfirmBtn');                                // repeated click
    await page.waitForFunction(() => document.getElementById('cancelOrderModal').style.display === 'none', null, { timeout: 8000 });
    const o = await doc('orders/oA');
    eq([o.status, o.cancelReason, o.cancelledByEmail, o.stockApplied], ['Cancelled', 'Customer changed their mind', 'mgr@naisi.test', false], 'order');
    expect(o.cancelledAt, 'server time missing');
    eq((await doc('products/p1')).stockOnHand, 500, 'stock 498 + 2');
    eq((await store('stockMovements')).filter(m => m.orderId === 'oA').length, 1, 'ledger entries');
    eq((await doc('orderCancellations/oA')).stockRestored, true, 'cancellation record');
    await page.selectOption('#orderStatusFilter', 'Cancelled'); await page.waitForSelector('#orderListBody tr[data-id="oA"]');
    const row = await page.locator('#orderListBody tr[data-id="oA"]').innerText();
    expect(/Cancelled/.test(row) && /changed their mind/.test(row) && !(await page.locator('#orderListBody tr[data-id="oA"] [data-action="cancel"]').count()), 'row: ' + row);
    return 'stock 498 -> 500, one ledger entry';
  });

  // ---------------- decision 3: manager-entered orders ----------------
  await R.check('E32', 'Manager enters an order for a rep: controlled number, credited to the rep, entered by the manager, NO visit created', async () => {
    const visitsBefore = (await store('visits')).length, counter0 = (await doc('orderCounters/naisiOrder')).counter;
    await nav('navOrdersBtn'); await page.click('#enterOrderForRepBtn');
    await page.waitForSelector('#managerOrderModal', { state: 'visible' });
    await page.selectOption('#moRep', 'rep1@naisi.test');
    await page.fill('#moCustSearch', 'Alpha'); await page.waitForSelector('#moCustSuggestions div, #moCustSuggestions .suggestion-item, #moCustSuggestions > *');
    await page.click('#moCustSuggestions > * >> nth=0');
    await page.click('#moQuickAddGrid button >> nth=0'); await page.waitForSelector('#moItemsBody tr');
    await page.fill('#moItemsBody tr .qty-input', '4');
    await shot('28-manager-order');
    await page.dblclick('#moSaveBtn');
    await page.waitForFunction(() => document.getElementById('managerOrderModal').style.display === 'none', null, { timeout: 8000 });
    const orders = (await store('orders')).filter(o => o.source === 'manager-entered');
    eq(orders.length, 1, 'double click must create one order');
    const o = orders[0];
    eq([o.attributedRepEmail, o.enteredByEmail, o.createdByEmail, o.visitId, o.status], ['rep1@naisi.test', 'mgr@naisi.test', 'mgr@naisi.test', null, 'Submitted'], 'ownership');
    expect(/^ORD-2026-0041$/.test(o.orderNo), 'number ' + o.orderNo);
    eq((await doc('orderCounters/naisiOrder')).counter, counter0 + 1, 'counter');
    eq((await store('visits')).length, visitsBefore, 'a visit was created');
    return o.orderNo;
  });
  await R.check('E33', 'Rep Performance counts the manager-entered order in its own column, never as a visit', async () => {
    await nav('navPerformanceBtn'); await page.fill('#perfFrom', '2026-10-15'); await page.fill('#perfTo', '2026-10-15'); await page.click('#perfRunBtn'); await page.waitForTimeout(400);
    const rows = await page.$$eval('#repSummaryBody tr', trs => trs.map(tr => [...tr.children].map(td => td.innerText.replace(/\s+/g, ' ').trim())));
    const r1 = rows.find(r => r[0].startsWith('Rep One'));
    expect(/1 order/.test(r1[8]), 'attributed column: ' + JSON.stringify(r1));
    eq(r1.slice(4, 6), ['0', '0'], 'visit-based counters must not include it, got ' + JSON.stringify(r1));
    await shot('29-performance-attributed');
    return r1.join(' | ');
  });

  // ---------------- decision 6: number control ----------------
  await R.check('E34', 'Invoice numbering: automatic, adjusted by a manager with a required reason; audit shows previous/new/actor/reason', async () => {
    await nav('navFormBtn'); await page.waitForSelector('#adjustNumberingBtn', { state: 'visible' });
    await page.click('#adjustNumberingBtn'); await page.waitForSelector('#adjustNumberModal', { state: 'visible' });
    await page.fill('#adjustCounter', '500'); await page.click('#adjustNumberSaveBtn');
    expect(await page.locator('#adjustNumberError').isVisible(), 'reason should be required');
    eq((await doc('counters/naisiInvoice')).counter, 370, 'counter must not change without a reason');
    await page.fill('#adjustReason', 'Paper book used up to 0499');
    await page.click('#adjustNumberSaveBtn');
    await page.waitForFunction(() => document.getElementById('adjustNumberModal').style.display === 'none', null, { timeout: 8000 });
    eq((await doc('counters/naisiInvoice')).counter, 500, 'counter');
    const a = (await store('counterAdjustments'))[0];
    eq([a.previousCounter, a.newCounter, a.reason, a.adjustedByEmail], [370, 500, 'Paper book used up to 0499', 'mgr@naisi.test'], 'audit');
    expect(a.adjustedAt, 'server time');
    await page.click('#numberingAuditWrap summary');
    expect(/Paper book used up/.test(await page.locator('#numberingAuditBody').innerText()), 'audit table');
    await shot('30-number-adjust');
    return 'next invoice 500';
  });
  await R.check('E35', 'The numbering box is read-only (no free typing of the counter or prefix on the page)', async () => {
    const editable = await page.evaluate(() => [...document.querySelectorAll('#numberingBox input, #numberingBox textarea')].filter(e => !e.readOnly && !e.disabled && e.type !== 'hidden').length);
    eq(editable, 0, 'editable inputs inside the numbering box');
    return 'no inputs';
  });

  // ---------------- decision 8: merge blocked while invoicing ----------------
  await R.check('E36', 'Merge is blocked while an affected order is Invoicing: clear message, nothing moved or deleted (the retry after invoicing is covered by unit + emulator tests)', async () => {
    await nav('navCustomersBtn'); await page.waitForSelector('#mergeKeepSearch');
    const pickCustomer = async (inputId, sugId, text) => { await page.fill(inputId, text); await page.waitForSelector(`${sugId} > *`); await page.click(`${sugId} > * >> nth=0`); };
    await pickCustomer('#mergeKeepSearch', '#mergeKeepSuggestions', 'Alpha');
    await pickCustomer('#mergeAwaySearch', '#mergeAwaySuggestions', 'Golf');
    await page.waitForSelector('#mergeConfirmBtn', { state: 'visible' });
    await page.click('#mergeConfirmBtn');
    await page.waitForFunction(() => /invoic/i.test(document.body.innerText) && /(blocked|cannot|can't|wait)/i.test(document.body.innerText), null, { timeout: 8000 });
    expect(await doc('customers/c7'), 'customer deleted despite the block');
    eq((await doc('orders/oInvg')).customerId, 'c7', 'order moved');
    eq((await store('customerMerges')).length, 0, 'merge record');
    expect(!(await doc('customers/c7')).mergeLock, 'lock should be released after a blocked merge');
    await shot('31-merge-blocked');
    // invoicing finishes (simulated by the data change a finished invoice would make), then the manager retries
    await fake(() => { const o = window.__fake.get('orders/oInvg'); window.__fake.seed(Object.fromEntries([['orders/oInvg', { ...o, status: 'Invoiced', invoiceNo: 'NF-INV-2026-0369', invoiceId: 'ord_oInvg', invoicingAttempt: null }]])); });
    return 'blocked (retry covered by unit + emulator tests)';
  });

  // ---------------- decision 5: depot removal ----------------
  await R.check('E37', 'Depot screen removed: no depot text/navigation for a manager or a rep, and every navigation tab opens without errors', async () => {
    const tabs = await page.$$eval('.nav-tab', els => els.filter(e => e.offsetParent !== null).map(e => e.id));
    for (const id of tabs) { await page.click('#' + id); await page.waitForTimeout(150); }
    const found = await page.evaluate(() => ({ text: /depot|warehouse/i.test(document.body.innerText), ids: [...document.querySelectorAll('[id],[data-view]')].filter(e => /depot|warehouse/i.test(e.id + ' ' + (e.dataset.view || ''))).map(e => e.id) }));
    expect(!found.text && found.ids.length === 0, 'depot/warehouse is still on the page: ' + JSON.stringify(found));
    return tabs.length + ' tabs opened';
  });

  // ---------------- decision 7: history not started ----------------
  await fresh({ history: false });
  await login('mgr@naisi.test');
  await R.check('E38', 'No schedule history yet: the report says so, calculates NO targets or percentages, and offers to start the history', async () => {
    await nav('navPerformanceBtn'); await page.fill('#perfFrom', '2026-10-15'); await page.fill('#perfTo', '2026-10-15'); await page.click('#perfRunBtn'); await page.waitForTimeout(400);
    expect(await page.locator('#scheduleHistoryStartBox').isVisible(), 'start box not shown');
    const cells = await page.$$eval('#repSummaryBody tr', trs => trs.map(tr => [...tr.children].map(td => td.innerText.replace(/\s+/g, ' ').trim())));
    expect(cells.every(r => /not calculated/i.test(r[1]) && !/%/.test(r[6]) ), 'targets/percentages were calculated: ' + JSON.stringify(cells[0]));
    await shot('32-history-not-started');
    return cells[0].join(' | ');
  });
  await R.check('E39', 'Starting the history records today\'s schedule as the baseline; earlier dates stay "no reliable history"', async () => {
    await page.click('#startScheduleHistoryBtn');
    await page.waitForFunction(() => !!window.__fake.get('config/scheduleHistory'), null, { timeout: 8000 });
    eq((await store('scheduleChanges')).filter(c => c.kind === 'baseline').length, 7, 'baselines (7 customers)');
    await page.fill('#perfFrom', '2026-10-15'); await page.fill('#perfTo', '2026-10-15'); await page.click('#perfRunBtn'); await page.waitForTimeout(400);
    const today = await page.$$eval('#repSummaryBody tr', trs => Number(trs[0].children[1].innerText));
    eq(today, 4, 'today has a reliable schedule');
    await page.fill('#perfFrom', '2026-10-08'); await page.fill('#perfTo', '2026-10-08'); await page.click('#perfRunBtn'); await page.waitForTimeout(400);
    const old = await page.$$eval('#repSummaryBody tr', trs => trs[0].children[1].innerText);
    expect(/not calculated/i.test(old), 'older date: ' + old);
    return 'baseline 7; today 4; 8 Oct not calculated';
  });
  // ---------------- decision 4: stand-alone (walk-in) invoices ----------------
  await fresh();
  await login('mgr@naisi.test');
  await R.check('E40', 'Walk-in invoice: the manager has a visible entry; it uses the shared number sequence, explicit identity; a lost acknowledgement + retry and a double click create ONE invoice', async () => {
    await nav('navFormBtn');
    await page.fill('#custName', 'Walk-in Trader');
    await page.click('#quickAddGrid button >> nth=0'); await page.waitForSelector('#itemsBody tr');
    await page.fill('#itemsBody tr .qty-input', '2');
    await fake(() => window.__fake.failNextAcks(1));
    await page.click('#generateBtn');
    await page.waitForFunction(() => /Could not save/i.test(document.body.innerText) || window.__fake.list('invoices').length > 0, null, { timeout: 8000 });
    await page.waitForTimeout(300);
    await page.dblclick('#generateBtn');                                    // retry (and a double click)
    await page.waitForTimeout(800);
    const invs = (await store('invoices')).filter(i => i.kind === 'standalone');
    eq(invs.length, 1, 'one stand-alone invoice expected, got ' + invs.length);
    const inv = invs[0];
    expect(/^sa_u_mgr_/.test(inv.id) || /^sa_/.test(inv.id), 'identity ' + inv.id);
    eq([inv.orderId, inv.kind, /-0370$/.test(inv.invoiceNo)], [null, 'standalone', true], 'fields ' + JSON.stringify(inv).slice(0, 200));
    eq((await doc('counters/naisiInvoice')).counter, 371, 'counter moved once');
    expect((await doc('invoiceNumbers/' + inv.invoiceNo)), 'registry entry missing');
    await shot('33-walkin-invoice');
    return inv.invoiceNo;
  });
  await logout(); await login('rep1@naisi.test'); await page.waitForSelector('#todaysRouteCard', { state: 'visible' });
  await R.check('E41', 'A rep does not see the Walk-in Invoice tab or any manager-only tab', async () => {
    const tabs = await page.$$eval('.nav-tab', els => els.filter(e => e.offsetParent !== null).map(e => e.id));
    expect(!tabs.includes('navFormBtn') && !tabs.includes('navInvoicesBtn') && !tabs.includes('navPerformanceBtn'), 'tabs: ' + tabs);
    return tabs.join(', ');
  });
  // ---------------- distance-based schedule suggestions ----------------
  const geo = (name, lat, lng, day) => ({ name, phone: '0999', location: 'Lilongwe', active: true, assignedDay: day, lat, lng });
  const planData = {
    'customers/p1': geo('North Mon Shop', -13.930, 33.780, 'Mon'), 'customers/p2': geo('South Tue Shop', -14.070, 33.760, 'Tue'),
    'customers/p3': geo('North New Shop', -13.932, 33.781, null), 'customers/p4': geo('South New Shop', -14.071, 33.762, null),
    'customers/p5': geo('Pinless New Shop', null, null, null),
  };
  await logout();
  await fresh({ extra: planData });
  await login('mgr@naisi.test');
  await nav('navCustomersBtn');
  const openPlanner = async () => { await page.click('#suggestScheduleToggleBtn'); await page.click('#suggestCalcBtn'); await page.waitForSelector('#suggestTotals', { timeout: 8000 }); };
  await R.check('E43', 'Suggest schedule: new shops are placed next to the nearby shops\' day; shops without a pin are listed (not guessed); NOTHING is saved yet', async () => {
    await openPlanner();
    const rows = await page.$$eval('#suggestResult label', ls => ls.map(l => l.innerText.replace(/\s+/g, ' ').trim()));
    expect(rows.some(r => /North New Shop.*Monday/i.test(r)), 'north shop not suggested for Monday: ' + rows.join(' / '));
    expect(rows.some(r => /South New Shop.*Tuesday/i.test(r)), 'south shop not suggested for Tuesday: ' + rows.join(' / '));
    expect(/Pinless New Shop/.test(await page.innerText('#suggestSkipped')), 'pinless shop not listed as skipped');
    expect(/straight-line/i.test(await page.innerText('#suggestTotals')), 'estimate not labelled straight-line');
    const c3 = await doc('customers/p3');
    eq([c3.assignedDay, (await store('scheduleChanges')).filter(x => x.customerId === 'p3').length], [null, 0], 'a suggestion must not save anything');
    await shot('34-suggest-schedule');
    return rows.join(' | ');
  });
  await R.check('E44', 'Applying only the ticked shops: they get the day and one dated history entry each; the unticked shop is untouched', async () => {
    await page.uncheck('.suggest-move >> nth=1');
    await page.click('#suggestApplyBtn');
    await page.waitForSelector('#suggestSummary', { timeout: 8000 });
    const [a, b] = [await doc('customers/p3'), await doc('customers/p4')];
    eq([a.assignedDay, b.assignedDay], ['Mon', null], 'days after apply');
    const h = (await store('scheduleChanges')).filter(x => x.customerId === 'p3');
    eq([h.length, h[0].kind, h[0].assignedDay, h[0].changedByEmail], [1, 'schedule', 'Mon', 'mgr@naisi.test'], 'history entry');
    expect(/1 changed/.test(await page.innerText('#suggestSummary')), 'summary: ' + await page.innerText('#suggestSummary'));
    return 'p3 -> Mon with history; p4 untouched';
  });
  await R.check('E45', 'A shop that another manager scheduled after the suggestion was made is SKIPPED, not overwritten', async () => {
    await page.click('#suggestCalcBtn'); await page.waitForSelector('#suggestApplyBtn', { timeout: 8000 });
    await fake(() => window.__fake.put('customers/p4', { name: 'South New Shop', phone: '0999', location: 'Lilongwe', active: true, assignedDay: 'Fri', lat: -14.071, lng: 33.762 }));
    await page.click('#suggestApplyBtn');
    await page.waitForSelector('#suggestSummary', { timeout: 8000 });
    const t = await page.innerText('#suggestSummary');
    eq((await doc('customers/p4')).assignedDay, 'Fri', 'the other manager\'s choice must stay');
    expect(/skipped/i.test(t) && /South New Shop/.test(t), 'summary: ' + t);
    eq((await store('scheduleChanges')).filter(x => x.customerId === 'p4').length, 0, 'no history written for a skipped shop');
    await shot('35-suggest-skipped');
    return t;
  });
  await R.check('E46', 'Re-plan all: shows who would move (now -> suggested) and day counts; nothing changes until Apply; unticking everything refuses', async () => {
    await page.check('input[name="suggestScope"][value="all"]');
    const before = JSON.stringify((await store('customers')).map(c => [c.id, c.assignedDay]));
    await page.click('#suggestCalcBtn'); await page.waitForSelector('#suggestTotals', { timeout: 8000 });
    expect(/Day.*Shops \(now/.test(await page.innerText('#suggestResult')), 'day table missing');
    eq(JSON.stringify((await store('customers')).map(c => [c.id, c.assignedDay])), before, 'calculating changed data');
    if (await page.locator('#suggestApplyBtn').count()) {
      for (const cb of await page.locator('.suggest-move').all()) await cb.uncheck();
      await page.click('#suggestApplyBtn');
      await toast(/Nothing is ticked/);
    }
    eq(JSON.stringify((await store('customers')).map(c => [c.id, c.assignedDay])), before, 'nothing ticked must change nothing');
    return 'no change without Apply';
  });
  await logout(); await login('rep1@naisi.test'); await page.waitForSelector('#todaysRouteCard', { state: 'visible' });
  await R.check('E47', 'A rep cannot see the schedule planner (manager only)', async () => {
    expect(!(await page.locator('#suggestScheduleToggleBtn').isVisible()), 'planner visible to a rep');
    return 'hidden';
  });
  await R.check('E48', 'No JavaScript errors during the whole run', async () => { eq(errors, [], 'page errors'); });
} finally {
  fs.writeFileSync(`${OUT}/e2e-decisions-results.json`, JSON.stringify(R.rows, null, 2));
  await browser.close(); server.close();
}
console.log('\n' + R.rows.map(r => `${r.status}\t${r.id}\t${r.name}`).join('\n'));
process.exit(R.rows.some(r => r.status === 'FAIL') ? 1 : 0);
