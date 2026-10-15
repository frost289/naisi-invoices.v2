// Real-browser (Chromium) tests of the daily-visit workflow.
// Backend = in-memory Firestore stand-in + fake sign-in (see vite.config.mjs). NOT the Firebase emulator
// (it cannot be downloaded in the environment that wrote these tests) and NOT the real rules.
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
const when = (iso) => page.clock.setFixedTime(new Date(iso));

async function login(email) {
  await page.fill('#loginEmail', email); await page.fill('#loginPassword', 'pw'); await page.click('#loginBtn');
}
async function logout() {
  // the app's own sign-out button
  await page.evaluate(() => document.getElementById('logoutBtn')?.click());
  await page.waitForSelector('#loginBtn', { state: 'visible' });
}
async function openApp(email) {
  await page.goto(url);
  await login(email);
}
async function repReady() { await page.waitForSelector('#todaysRouteCard', { state: 'visible', timeout: 8000 }); await page.waitForFunction(() => document.getElementById('vpScheduled')); await page.waitForTimeout(150); }
const progress = () => page.evaluate(() => ['vpScheduled', 'vpVisited', 'vpDue', 'vpOrders', 'vpNoOrder'].map(id => Number(document.getElementById(id).textContent)));
const shops = () => page.$$eval('#todaysRouteList .todays-route-item', els => els.map(e => ({ id: e.dataset.id, text: e.innerText.replace(/\s+/g, ' ').trim() })));
const pick = (id) => page.click(`#todaysRouteList .todays-route-item[data-id="${id}"]`);
const toastText = () => page.evaluate(() => [...document.querySelectorAll('.toast, [class*="toast"]')].map(e => e.innerText).join(' | '));

async function logNoOrder(id, reason, notes) {
  await pick(id); await page.click('#lvOutcomeNo');
  if (reason) await page.selectOption('#lvReason', reason);
  if (notes !== undefined) await page.fill('#lvReasonNotes', notes);
  await page.click('#lvSubmitNoOrderBtn');
}
async function placeOrder(id, { dbl = false } = {}) {
  await pick(id); await page.click('#lvOutcomeYes');
  await page.waitForSelector('#lvOrderFormWrap', { state: 'visible' });
  await page.click('#lvQuickAddGrid button >> nth=0');
  await page.waitForSelector('#lvOrderItemsBody tr');
  await page.fill('#lvOrderItemsBody tr .qty-input', '3');
  await (dbl ? page.dblclick('#lvSubmitOrderBtn') : page.click('#lvSubmitOrderBtn'));
}

try {
  await when(THU);
  await page.goto(url);
  await fake((d) => window.__fake.seed(d), seedData());
  await page.reload();

  // ---------- rep 1 ----------
  await login('rep1@naisi.test');
  await R.check('E1', 'Rep login opens Today\'s Visits automatically, Thursday list, Malawi date', async () => {
    await repReady();
    const label = await page.locator('#todaysRouteCard h2').innerText();
    expect(/Thursday/.test(label) && /15-10-2026/.test(label) && /Malawi time/.test(label), label);
    const visible = await page.locator('#logvisitView').isVisible();
    expect(visible, 'Today\'s Visits view not shown');
    return label.replace(/\s+/g, ' ');
  });
  await R.check('E2', 'Only active customers scheduled for Thursday are listed (inactive and Friday shops excluded)', async () => {
    const names = (await shops()).map(s => s.text.split(' To visit')[0]);
    eq(names, ['Alpha Shop', 'Bravo Shop', 'Charlie Shop', 'Foxtrot No Pin'], 'shops');
    eq(await progress(), [4, 0, 4, 0, 0], 'progress');
    return names.join(', ');
  });
  await shot('01-rep-today');

  await R.check('E3', 'No Order with no reason chosen is refused (nothing saved)', async () => {
    await pick('c1'); await page.click('#lvOutcomeNo');
    eq(await page.inputValue('#lvReason'), '', 'a reason is pre-selected');
    await page.click('#lvSubmitNoOrderBtn');
    const msg = await page.locator('#lvNoOrderError').innerText();
    expect(/Choose a reason/i.test(msg), msg);
    eq((await store('visits')).length, 0, 'visits saved');
    return msg;
  });
  await R.check('E4', '"Other" without an explanation is refused; with one it saves', async () => {
    await page.selectOption('#lvReason', 'Other');
    await page.click('#lvSubmitNoOrderBtn');
    expect(/explain/i.test(await page.locator('#lvNoOrderError').innerText()), 'no explanation error');
    eq((await store('visits')).length, 0, 'visits saved');
    expect(/required/i.test(await page.locator('#lvReasonNotesLabel').innerText()), 'label should say required');
    await page.fill('#lvReasonNotes', 'Owner is at a funeral');
    await page.click('#lvSubmitNoOrderBtn');
    await page.waitForFunction(() => document.getElementById('vpNoOrder').textContent === '1');
    const [v] = await store('visits');
    eq([v.outcome, v.reasonNoOrder, v.reasonNotes, v.customerId, v.repEmail, v.date], ['No Order', 'Other', 'Owner is at a funeral', 'c1', 'rep1@naisi.test', '2026-10-15'], 'saved visit');
    expect(v.createdAt && v.createdAt.ms > 0, 'createdAt (server timestamp) missing');
    return JSON.stringify({ reason: v.reasonNoOrder, notes: v.reasonNotes });
  });
  await R.check('E5', 'Reason list offers all eight reasons, none selected by default', async () => {
    await pick('c2'); await page.click('#lvOutcomeNo');
    const opts = await page.$$eval('#lvReason option', os => os.map(o => o.textContent.trim()));
    eq(opts, ['Select a reason…', 'Shop still has stock', 'Price too high', 'Stock unavailable', 'Shop owner unavailable', 'Shop closed', 'No money today', 'Not interested', 'Other']);
    return opts.slice(1).join(' / ');
  });
  await R.check('E6', 'No Order with optional detail saves; progress and list update', async () => {
    await page.selectOption('#lvReason', 'Price too high');
    await page.click('#lvSubmitNoOrderBtn');
    await page.waitForFunction(() => document.getElementById('vpNoOrder').textContent === '2');
    eq(await progress(), [4, 2, 2, 0, 2], 'progress');
    const bravo = (await shops()).find(s => s.id === 'c2').text;
    expect(/No order: Price too high/.test(bravo), bravo);
    return bravo;
  });
  await R.check('E7', 'Order Placed: order + visit saved together, linked, order number used once', async () => {
    await placeOrder('c3');
    await page.waitForFunction(() => document.getElementById('vpOrders').textContent === '1');
    const orders = await store('orders'), visits = (await store('visits')).filter(v => v.customerId === 'c3');
    eq(orders.length, 1, 'orders'); eq(visits.length, 1, 'visits');
    eq(orders[0].status, 'Submitted', 'status');
    eq([visits[0].orderId, visits[0].orderNo, visits[0].orderValue], [orders[0].id, orders[0].orderNo, 3000], 'link');
    eq(orders[0].visitId, visits[0].id, 'order->visit link');
    eq((await doc('orderCounters/naisiOrder')).counter, 42, 'counter');
    eq(orders[0].items[0].productId, 'p1', 'productId'); eq(orders[0].createdByEmail, 'rep1@naisi.test', 'createdBy');
    return `${orders[0].orderNo} value ${visits[0].orderValue}`;
  });
  await shot('02-rep-progress');

  await R.check('E8', 'Progress survives a page refresh (reloaded from saved visits)', async () => {
    const before = await progress();
    await page.reload(); await login('rep1@naisi.test'); await repReady();
    await page.waitForFunction(() => document.getElementById('vpVisited').textContent !== '0');
    eq(await progress(), before, 'after refresh'); eq(before, [4, 3, 1, 1, 2], 'values');
    const texts = (await shops()).map(s => s.text);
    expect(texts.some(t => /Alpha Shop.*No order: Other/.test(t)) && texts.some(t => /Charlie Shop.*Order ORD-/.test(t)), texts.join(' | '));
    return before.join('/');
  });
  await R.check('E9', 'Repeat visit is kept in history but the shop is counted once', async () => {
    await logNoOrder('c1', 'Shop closed', '');
    await page.waitForFunction(() => document.getElementById('vpNoOrder').textContent === '3');
    eq(await progress(), [4, 3, 1, 1, 3], 'distinct visited unchanged');
    eq((await store('visits')).filter(v => v.customerId === 'c1').length, 2, 'both visits kept');
    return 'visited stays 3; Alpha has 2 visits';
  });

  // ---------- failed saves ----------
  await R.check('E10', 'Failed save leaves no order, no visit, no used order number; retry then succeeds (order 0042)', async () => {
    const before = { o: (await store('orders')).length, v: (await store('visits')).length, c: (await doc('orderCounters/naisiOrder')).counter };
    await fake(() => window.__fake.failNextCommits(1));
    await placeOrder('c2');
    await page.waitForFunction(() => /Could not submit/i.test(document.body.innerText));
    eq({ o: (await store('orders')).length, v: (await store('visits')).length, c: (await doc('orderCounters/naisiOrder')).counter }, before, 'partial data left behind');
    await page.click('#lvSubmitOrderBtn');                   // retry: same request id
    await page.waitForFunction(() => document.getElementById('vpOrders').textContent === '2');
    const orders = await store('orders');
    eq(orders.length, before.o + 1, 'orders after retry'); eq((await doc('orderCounters/naisiOrder')).counter, before.c + 1, 'counter');
    return `orders ${before.o} -> ${orders.length}, counter ${before.c} -> ${before.c + 1}`;
  });
  await R.check('E11', 'Lost acknowledgement: retry creates ONE order, ONE visit, ONE order number', async () => {
    const before = { o: (await store('orders')).length, v: (await store('visits')).length, c: (await doc('orderCounters/naisiOrder')).counter };
    await fake(() => window.__fake.failNextAcks(1));
    await placeOrder('c1');
    await page.waitForFunction(() => /Could not submit/i.test(document.body.innerText));
    eq((await store('orders')).length, before.o + 1, 'the first attempt did commit');
    await page.click('#lvSubmitOrderBtn');                   // retry
    await page.waitForFunction(() => /already been saved/i.test(document.body.innerText));
    eq({ o: (await store('orders')).length, v: (await store('visits')).length, c: (await doc('orderCounters/naisiOrder')).counter }, { o: before.o + 1, v: before.v + 1, c: before.c + 1 }, 'duplicates created');
    return `orders +1, visits +1, counter +1`;
  });
  await R.check('E12', 'Double-click on Submit creates one order and one visit', async () => {
    const before = { o: (await store('orders')).length, v: (await store('visits')).length, c: (await doc('orderCounters/naisiOrder')).counter };
    await placeOrder('c3', { dbl: true });
    await page.waitForFunction((n) => document.getElementById('vpOrders').textContent !== String(n), 3);
    await page.waitForTimeout(400);
    eq({ o: (await store('orders')).length, v: (await store('visits')).length, c: (await doc('orderCounters/naisiOrder')).counter }, { o: before.o + 1, v: before.v + 1, c: before.c + 1 }, 'duplicates');
    return 'orders +1, visits +1';
  });
  await R.check('E13', 'Same flow for No Order: failed save leaves nothing; lost-ack retry saves once', async () => {
    const n0 = (await store('visits')).length;
    await fake(() => window.__fake.failNextCommits(1));
    await logNoOrder('c2', 'Not interested', '');
    await page.waitForFunction(() => { const e = document.getElementById('lvNoOrderError'); return e.offsetParent !== null && /Could not save the visit/i.test(e.innerText); });
    eq((await store('visits')).length, n0, 'partial visit');
    await fake(() => window.__fake.failNextAcks(1));
    await page.click('#lvSubmitNoOrderBtn');
    await page.waitForFunction(() => { const e = document.getElementById('lvNoOrderError'); return e.offsetParent !== null && /Could not save the visit/i.test(e.innerText); });
    eq((await store('visits')).length, n0 + 1, 'committed once');
    await page.click('#lvSubmitNoOrderBtn');                 // retry with the same request id
    await page.waitForFunction(() => document.getElementById('lvOutcomeCard').offsetParent === null);   // screen reset = save acknowledged
    eq((await store('visits')).length, n0 + 1, 'duplicate after retry');
    await page.waitForFunction(() => /already been saved/i.test(document.body.innerText));
    return 'visits +1';
  });

  // ---------- rep 2: shared schedule, separate progress ----------
  await R.check('E14', 'Two reps share the schedule but keep separate progress', async () => {
    const rep1 = await progress();
    await logout(); await login('rep2@naisi.test'); await repReady();
    const names = (await shops()).map(s => s.text.split(' To visit')[0].split(' ✓')[0]);
    eq(names.sort(), ['Alpha Shop', 'Bravo Shop', 'Charlie Shop', 'Foxtrot No Pin'], 'rep2 list');
    eq(await progress(), [4, 0, 4, 0, 0], 'rep2 starts at zero');
    await logNoOrder('c1', 'Stock unavailable', '');
    await page.waitForFunction(() => document.getElementById('vpNoOrder').textContent === '1');
    eq(await progress(), [4, 1, 3, 0, 1], 'rep2 progress');
    await logout(); await login('rep1@naisi.test'); await repReady();
    await page.waitForFunction(() => document.getElementById('vpVisited').textContent !== '0');
    eq(await progress(), rep1, 'rep1 unchanged by rep2');
    return `rep1 ${rep1.join('/')} | rep2 1 visited`;
  });

  // ---------- Malawi date boundary ----------
  await R.check('E15', 'Malawi date boundary: 21:59 UTC Thursday is still Thursday; 22:00 UTC is Friday (Echo only)', async () => {
    await when('2026-10-15T21:59:00Z'); await page.reload(); await login('rep3@naisi.test'); await repReady();
    expect(/Thursday/.test(await page.locator('#todaysRouteCard h2').innerText()), 'expected Thursday at 23:59 Malawi');
    eq((await shops()).length, 4, 'Thursday shops');
    await when('2026-10-15T22:00:30Z'); await page.reload(); await login('rep3@naisi.test'); await repReady();
    const h = await page.locator('#todaysRouteCard h2').innerText();
    expect(/Friday/.test(h) && /16-10-2026/.test(h), h);
    eq((await shops()).map(s => s.text.split(' To visit')[0]), ['Echo Friday'], 'Friday shops');
    return h.replace(/\s+/g, ' ');
  });
  await R.check('E16', 'A visit saved at 00:30 Malawi (22:30 UTC) is dated the Malawi day', async () => {
    await when('2026-10-15T22:30:00Z');
    await logNoOrder('c5', 'Shop closed', '');
    await page.waitForFunction(() => document.getElementById('vpNoOrder').textContent === '1');
    const v = (await store('visits')).find(x => x.customerId === 'c5');
    eq([v.date, v.scheduledDay, v.wasScheduled], ['2026-10-16', 'Fri', true], 'visit');
    return `date ${v.date}`;
  });

  // ---------- manager ----------
  await when(THU);
  await page.goto(url);
  await R.check('E17', 'Manager report: filters by date and rep, includes reps with no visits, numbers match saved records', async () => {
    // a legacy visit without value/new fields, to prove "—" rather than 0
    await login('mgr@naisi.test');
    await page.waitForSelector('#navPerformanceBtn', { state: 'visible' });
    await page.click('#navPerformanceBtn');
    await page.waitForSelector('#repSummaryBody tr');
    await page.fill('#perfFrom', '2026-10-15'); await page.fill('#perfTo', '2026-10-15'); await page.click('#perfRunBtn');
    await page.waitForTimeout(300);
    const rows = await page.$$eval('#repSummaryBody tr', trs => trs.map(tr => [...tr.children].map(td => td.innerText.replace(/\s+/g, ' ').trim())));
    // expected values computed independently from the saved records
    const visits = (await store('visits')).filter(v => v.date === '2026-10-15');
    const exp = (email) => {
      const mine = visits.filter(v => v.repEmail === email);
      const sched = new Set(['c1', 'c2', 'c3', 'c6']);
      const visited = new Set(mine.filter(v => sched.has(v.customerId)).map(v => v.customerId));
      const orders = mine.filter(v => v.outcome === 'Order Placed').length, no = mine.filter(v => v.outcome === 'No Order').length;
      return [String(4), String(visited.size), String(4 - visited.size), String(orders), String(no)];
    };
    for (const [email, label] of [['rep1@naisi.test', 'Rep One'], ['rep2@naisi.test', 'Rep Two'], ['rep3@naisi.test', 'Rep Three']]) {
      const row = rows.find(r => r[0].startsWith(label));
      expect(row, 'missing row for ' + label + ' in ' + JSON.stringify(rows));
      eq(row.slice(1, 6), exp(email), 'numbers for ' + label);
    }
    expect(rows.find(r => r[0].startsWith('Rep Three'))[0].includes('no visits recorded'), 'rep with no visits not flagged');
    // rep filter
    await page.selectOption('#perfRepFilter', 'rep2@naisi.test');
    const filtered = await page.$$eval('#repSummaryBody tr', trs => trs.length);
    eq(filtered, 1, 'rep filter');
    await page.selectOption('#perfRepFilter', 'all');
    return rows.map(r => r.slice(0, 6).join(' ')).join(' || ');
  });
  await shot('03-manager-report');
  await R.check('E18', 'Manager report: still-due shops, no-order reasons with explanations, orders linked with values', async () => {
    const due = await page.$$eval('#dueBody tr', trs => trs.map(t => t.innerText.replace(/\s+/g, ' ').trim()));
    expect(due.some(t => /Rep Three.*Alpha Shop/.test(t)), 'rep3 should have Alpha due: ' + due.join(' | '));
    const no = await page.$$eval('#noOrderBody tr', trs => trs.map(t => t.innerText.replace(/\s+/g, ' ').trim()));
    expect(no.some(t => /Alpha Shop.*Other.*Owner is at a funeral/.test(t)), 'explanation missing: ' + no.join(' | '));
    expect(no.some(t => /Bravo Shop.*Price too high/.test(t)), 'reason missing');
    const ord = await page.$$eval('#ordersTakenBody tr', trs => trs.map(t => t.innerText.replace(/\s+/g, ' ').trim()));
    expect(ord.length >= 3 && ord.every(t => /ORD-/.test(t) && /3,000|MWK/.test(t)), 'orders: ' + ord.join(' | '));
    await page.click('#ordersTakenBody [data-view-order]');
    await page.waitForSelector('#orderPreviewModal', { state: 'visible' });
    const modal = await page.locator('#orderPreviewModal').innerText();
    expect(/ORD-/.test(modal) && /Amanda 100g/.test(modal), 'order preview did not open the linked order');
    await page.evaluate(() => { const m = document.getElementById('orderPreviewModal'); m.style.display = 'none'; });
    return `${due.length} due rows, ${no.length} no-order rows, ${ord.length} orders`;
  });
  await R.check('E19', 'Order values: a visit with no recorded value shows "—", never 0', async () => {
    await page.evaluate(() => {
      // add a legacy-style visit (no orderValue) for rep3 on the 15th
      const raw = JSON.parse(localStorage.getItem('naisi-fake-store'));
      raw.push(['visits/legacy1', { customerId: 'c2', customerName: 'Bravo Shop', repId: 'u_rep3', repEmail: 'rep3@naisi.test', date: '2026-10-15', outcome: 'Order Placed', reasonNoOrder: null, reasonNotes: '', orderId: 'ordX', orderNo: 'ORD-2026-0001' }, {}]);
      localStorage.setItem('naisi-fake-store', JSON.stringify(raw));
    });
    await page.reload(); await login('mgr@naisi.test'); await page.click('#navPerformanceBtn');
    await page.fill('#perfFrom', '2026-10-15'); await page.fill('#perfTo', '2026-10-15'); await page.click('#perfRunBtn'); await page.waitForTimeout(300);
    const legacy = await page.$$eval('#ordersTakenBody tr', trs => trs.map(t => [...t.children].map(td => td.innerText.trim())).find(c => c[3].includes('ORD-2026-0001')));
    eq(legacy[4], '—', 'value cell');
    const note = await page.locator('#ordersValueNote').innerText();
    expect(/no recorded value/i.test(note) && /not as zero/i.test(note), note);
    return note;
  });
  await R.check('E20', 'Report explains percentages and how a later schedule change affects history', async () => {
    const txt = await page.locator('#performanceView details').innerText();
    expect(/Coverage/.test(txt) && /Conversion/.test(txt) && /as it is now/i.test(txt) && /Still due/.test(txt), txt.slice(0, 200));
    return 'definitions present on screen';
  });
  await R.check('E21', 'Manager changes a weekly visit day; rep sees it; report warns about history', async () => {
    await page.click('#navCustomersBtn'); await page.waitForSelector('#weeklyScheduleCard', { state: 'visible' });
    await page.click('.schedule-day-tab[data-day="Fri"]');
    await page.selectOption('#scheduleDayList .customer-day-select >> nth=0', 'Thu');   // Echo Friday -> Thursday
    await page.waitForFunction(() => /Visit day updated/.test(document.body.innerText));
    eq((await doc('customers/c5')).assignedDay, 'Thu', 'saved day');
    expect((await doc('customers/c5')).assignedDayChangedAt, 'change time not recorded');
    await page.click('#navPerformanceBtn'); await page.waitForTimeout(300);
    await page.fill('#perfFrom', '2026-10-15'); await page.fill('#perfTo', '2026-10-15'); await page.click('#perfRunBtn'); await page.waitForTimeout(300);
    expect(await page.locator('#perfScheduleWarning').isVisible(), 'no schedule-change warning');
    await logout(); await login('rep1@naisi.test'); await repReady();
    const names = (await shops()).map(s => s.text.split(' To visit')[0].split(' ✓')[0]);
    expect(names.includes('Echo Friday'), 'Echo should now be on Thursday: ' + names);
    return names.join(', ');
  });
  await R.check('E22', 'No JavaScript errors during the whole run', async () => { eq(errors, [], 'page errors'); });
} finally {
  fs.writeFileSync(`${OUT}/e2e-results.json`, JSON.stringify(R.rows, null, 2));
  await browser.close(); server.close();
}
console.log('\n' + R.rows.map(r => `${r.status}\t${r.id}\t${r.name}`).join('\n'));
process.exit(R.rows.some(r => r.status === 'FAIL') ? 1 : 0);
