// Real-browser (Chromium) checks for the RC6.2 owner requests as corrected in RC6.3 (E56+). Same backend as the other
// browser suites: in-memory Firestore stand-in + fake sign-in. NOT the emulator and NOT the real rules (see tests/rules).
//   1. a rep's Expenses screen holds only his own Transport / Meals / Other (never Fuel / Stock Purchase, not even older ones)
//   2. missing locations: a clear reminder, never a block; orders are saved and flagged "No location"; first-capture credit
//   3. no Walk-in Invoice tab (checked in decisions.e2e.mjs E40/E41)
//   4. one Weekly Schedule: refreshed immediately after every kind of schedule change; agrees with Rep Performance and the
//      rep's daily list; "History unavailable" / "Data unavailable" instead of misleading figures
import { serveDist, newBrowser, Results, expect, eq } from './harness.mjs';
import { seedData, THU } from './seed.mjs';

const OUT = process.env.E2E_OUT || '/tmp';
const R = new Results();
const { server, url } = await serveDist();
const { browser, context } = await newBrowser();
await context.grantPermissions(['geolocation'], { origin: url.replace(/\/$/, '') });
await context.setGeolocation({ latitude: -13.9712, longitude: 33.7891 });
// Leaflet comes from a CDN that the test browser may not reach, so a minimal stand-in records what the app does with the map.
await context.addInitScript(() => {
  if (window.L) return;
  const marker = (ll) => { let pos = { lat: ll[0], lng: ll[1] }; const m = { addTo: () => m, on: () => m, setLatLng: (x) => { pos = { lat: x[0], lng: x[1] }; return m; }, getLatLng: () => pos }; return m; };
  const map = () => { const m = { setView: () => m, on: () => m, invalidateSize: () => m, removeLayer: () => m }; return m; };
  Object.defineProperty(window, 'L', { configurable: true, get() { return window.__realL || { map, marker, tileLayer: () => ({ addTo: () => ({}) }) }; }, set(v) { window.__realL = v; } });
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('dialog', d => d.accept());
const fake = (fn, arg) => page.evaluate(fn, arg);
const store = (prefix) => fake((p) => window.__fake.list(p), prefix);
const doc = (path) => fake((p) => window.__fake.get(p), path);
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
const login = async (email) => { await page.fill('#loginEmail', email); await page.fill('#loginPassword', 'pw'); await page.click('#loginBtn'); };
const logout = async () => { await page.evaluate(() => document.getElementById('logoutBtn')?.click()); await page.waitForSelector('#loginBtn', { state: 'visible' }); };
const toast = (re) => page.waitForFunction((s) => new RegExp(s, 'i').test(document.body.innerText), re.source, { timeout: 8000 });
async function nav(id) { await page.waitForSelector(`#${id}`, { state: 'visible' }); await page.click(`#${id}`); }
const ts = (iso) => ({ __ts: Date.parse(iso) });

const extra = {
  'customers/c7': { name: 'Golf Monday', phone: '0999', location: 'Area 3', active: true, assignedDay: 'Mon', lat: -13.98, lng: 33.78 },
  'customers/c8': { name: 'Hotel Tuesday', phone: '0999', location: 'Area 49', active: true, assignedDay: 'Tue', lat: -13.98, lng: 33.78 },
  'customers/c9': { name: 'India Unscheduled', phone: '0999', location: 'Area 18', active: true, assignedDay: null, lat: -13.98, lng: 33.78 },
  'customers/c10': { name: 'Juliet Closed No Pin', phone: '0999', location: 'Area 12', active: false, assignedDay: null, lat: null, lng: null },
  'customers/c11': { name: 'Kilo Unscheduled', phone: '0999', location: 'Area 25', active: true, assignedDay: null, lat: -13.98, lng: 33.78 },
  'orders/oNoPin': { orderNo: 'ORD-2026-0049', status: 'Submitted', source: 'rep-visit', customerId: 'c10', customerName: 'Juliet Closed No Pin', customerLat: null, customerLng: null, items: [{ qty: 1, desc: 'Amanda 100g', price: 1000, total: 1000, productId: 'p1' }], grandTotal: 1000, createdBy: 'u_rep1', createdByEmail: 'rep1@naisi.test', createdAt: ts('2026-10-14T08:00:00Z') },
  // this week (Thu 15 Oct is today): Monday Golf visited with an order, Tuesday Hotel never visited (missed),
  // Thursday Alpha order + Bravo no-order by rep1; Charlie no-order by rep2; an extra (unplanned) visit to Echo on Thursday
  'visits/w1': { customerId: 'c7', customerName: 'Golf Monday', repId: 'u_rep1', repEmail: 'rep1@naisi.test', date: '2026-10-12', outcome: 'Order Placed', orderNo: 'ORD-2026-0050', orderValue: 12000, createdAt: ts('2026-10-12T08:00:00Z') },
  'visits/w2': { customerId: 'c1', customerName: 'Alpha Shop', repId: 'u_rep1', repEmail: 'rep1@naisi.test', date: '2026-10-15', outcome: 'Order Placed', orderNo: 'ORD-2026-0051', orderValue: 45000, createdAt: ts('2026-10-15T07:00:00Z') },
  'visits/w3': { customerId: 'c2', customerName: 'Bravo Shop', repId: 'u_rep1', repEmail: 'rep1@naisi.test', date: '2026-10-15', outcome: 'No Order', reasonNoOrder: 'Shop closed', createdAt: ts('2026-10-15T07:20:00Z') },
  'visits/w4': { customerId: 'c3', customerName: 'Charlie Shop', repId: 'u_rep2', repEmail: 'rep2@naisi.test', date: '2026-10-15', outcome: 'No Order', reasonNoOrder: 'Price too high', createdAt: ts('2026-10-15T07:40:00Z') },
  'visits/w5': { customerId: 'c5', customerName: 'Echo Friday', repId: 'u_rep1', repEmail: 'rep1@naisi.test', date: '2026-10-15', outcome: 'Order Placed', orderNo: 'ORD-2026-0052', orderValue: 3000, createdAt: ts('2026-10-15T07:50:00Z') },
  // expenses: rep1 has older Fuel and Stock records (he must never see them); rep2 has his own (rep1 must never see it)
  'expenses/x1': { date: '2026-10-15', category: 'Transport', amount: 2000, notes: 'minibus', createdBy: 'u_rep1', createdByEmail: 'rep1@naisi.test', createdAt: ts('2026-10-15T06:00:00Z') },
  'expenses/x2': { date: '2026-10-10', category: 'Fuel', amount: 1500, notes: 'old record', createdBy: 'u_rep1', createdByEmail: 'rep1@naisi.test', createdAt: ts('2026-10-10T06:00:00Z') },
  'expenses/x2b': { date: '2026-10-09', category: 'Stock', amount: 7000, notes: 'old stock record', createdBy: 'u_rep1', createdByEmail: 'rep1@naisi.test', createdAt: ts('2026-10-09T06:00:00Z') },
  'expenses/x3': { date: '2026-10-15', category: 'Meals', amount: 900, notes: 'rep2 lunch', createdBy: 'u_rep2', createdByEmail: 'rep2@naisi.test', createdAt: ts('2026-10-15T06:00:00Z') },
  'expenses/x4': { date: '2026-10-14', category: 'Stock', amount: 250000, notes: 'manager stock buy', createdBy: 'u_mgr', createdByEmail: 'mgr@naisi.test', createdAt: ts('2026-10-14T06:00:00Z') },
};
// the extra customers need their schedule-history baselines too, like the seeded ones
function seedAll() {
  const d = { ...seedData(), ...extra };
  for (const id of ['c7', 'c8', 'c9', 'c10', 'c11']) {
    const c = d['customers/' + id];
    d['scheduleChanges/base_' + id] = { customerId: id, customerName: c.name, kind: 'baseline', active: c.active !== false, assignedDay: c.assignedDay, changedBy: 'u_mgr', changedByEmail: 'mgr@naisi.test', createdAt: ts('2026-01-01T06:05:00Z') };
  }
  return d;
}

try {
  await page.clock.setFixedTime(new Date(THU));
  await page.goto(url);
  await fake((d) => window.__fake.seed(d), seedAll());
  await page.reload();

  // ---------------- 1. rep expenses ----------------
  await login('rep1@naisi.test');
  await page.waitForSelector('#todaysRouteCard', { state: 'visible' });
  await R.check('E56', 'Rep expenses: only his own Transport / Meals / Other are listed, totalled and editable; his older Fuel and Stock records are not shown; he cannot choose Fuel/Stock', async () => {
    await nav('navExpensesBtn'); await page.waitForSelector('#expenseListBody tr');
    eq(await page.$$eval('#expCategory option', os => os.map(o => o.value)), ['Transport', 'Meals', 'Other'], 'rep categories');
    eq(await page.$$eval('#expenseSummary .exp-tile-label', ls => ls.map(l => l.textContent)), ['Transport', 'Meals', 'Other'], 'tiles');
    const rows = await page.$$eval('#expenseListBody tr', trs => trs.map(t => t.innerText));
    expect(rows.length === 1 && /minibus/.test(rows[0]), 'list: ' + rows.join(' | '));
    expect(/2,000/.test(await page.locator('#expenseSummary').innerText()) && !/1,500|7,000/.test(await page.locator('#expenseSummary').innerText()), 'totals include an excluded record');
    await page.click('#expenseListBody [data-action="edit"]');
    eq(await page.$$eval('#expenseListBody select[data-field="category"] option', os => os.map(o => o.value)), ['Transport', 'Meals', 'Other'], 'edit options');
    await page.click('#expenseListBody [data-action="cancel"]');
    await page.fill('#expAmount', '1200'); await page.selectOption('#expCategory', 'Meals'); await page.click('#addExpenseBtn');
    await toast(/Expense logged/);
    expect((await store('expenses')).some(e => e.createdBy === 'u_rep1' && e.category === 'Meals' && e.amount === 1200), 'meal expense not saved');
    eq((await doc('expenses/x2')).category, 'Fuel', 'older Fuel record untouched (kept for managers)');
    await shot('56-rep-expenses');
    return 'Transport/Meals/Other only';
  });

  // ---------------- 2. customer locations: reminder, never a block ----------------
  await R.check('E57', 'Missing location: counter, banner and reminder are shown, and an ORDER is blocked until the shop is pinned (nothing is saved)', async () => {
    await nav('navLogVisitBtn'); await page.waitForSelector('#todaysRouteList .todays-route-item');
    eq(await page.locator('#vpNeedPin').innerText(), '1', 'need-pin count');
    expect(/Foxtrot No Pin/.test(await page.locator('#todaysPinBanner').innerText()), 'banner');
    await page.click('#todaysRouteList .todays-route-item[data-id="c6"]');
    await page.waitForSelector('#lvPinPrompt', { state: 'visible' });
    expect(/only be taken once the location is saved/i.test(await page.locator('#lvPinPrompt').innerText()), 'reminder must say an order needs the location');
    const before = { o: (await store('orders')).length, v: (await store('visits')).length, c: (await doc('orderCounters/naisiOrder')).counter };
    await page.click('#lvOutcomeYes');
    await page.waitForSelector('#lvPinRequired', { state: 'visible', timeout: 4000 });
    expect(!(await page.locator('#lvOrderFormWrap').isVisible()), 'the order form must stay hidden until the shop is pinned');
    await page.waitForTimeout(300);
    eq([(await store('orders')).length, (await store('visits')).length, (await doc('orderCounters/naisiOrder')).counter], [before.o, before.v, before.c], 'nothing saved');
    await shot('57-order-blocked-without-pin');
    await page.click('#lvClearCustomer');                           // leave the visit unsaved, back to today's list
    return 'blocked';
  });
  await R.check('E58', 'Saving the location: GPS start; first capture stamped with the rep and server time; the order can then be taken and copies the pin; a re-pin keeps the stamp; the counter clears', async () => {
    await page.click('#todaysRouteList .todays-route-item[data-id="c6"]');
    await page.waitForSelector('#lvPinPrompt', { state: 'visible' });
    await page.click('#lvPinHereBtn');
    await page.waitForSelector('#locationPickerModal', { state: 'visible' });
    await page.waitForFunction(() => /Pinned at -13\.971/.test(document.getElementById('lpCoordsLabel').textContent), null, { timeout: 8000 });
    await page.click('#lpSaveBtn');
    await toast(/Location saved/);
    const c6 = await doc('customers/c6');
    expect(Math.abs(c6.lat - -13.9712) < 1e-6 && Math.abs(c6.lng - 33.7891) < 1e-6, 'pin ' + JSON.stringify([c6.lat, c6.lng]));
    eq([c6.firstPinnedBy, c6.firstPinnedByEmail, !!c6.firstPinnedAt], ['u_rep1', 'rep1@naisi.test', true], 'first capture stamp');
    eq(await page.locator('#vpNeedPin').innerText(), '0', 'need-pin count after pinning');
    // now pinned: the order form opens and the order copies the saved pin (double tap: still one order)
    const before = { o: (await store('orders')).length, v: (await store('visits')).length, c: (await doc('orderCounters/naisiOrder')).counter };
    if (!(await page.locator('#lvOutcomeYes').evaluate(b => b.classList.contains('active')))) await page.click('#lvOutcomeYes');
    await page.waitForSelector('#lvOrderFormWrap', { state: 'visible', timeout: 4000 });
    expect(!(await page.locator('#lvPinRequired').isVisible()), 'pin box must be gone once pinned');
    await page.click('#lvQuickAddGrid button >> nth=0'); await page.waitForSelector('#lvOrderItemsBody tr');
    await page.fill('#lvOrderItemsBody tr .qty-input', '2');
    await page.dblclick('#lvSubmitOrderBtn');
    await toast(/submitted/);
    await page.waitForTimeout(400);
    const o = (await store('orders')).filter(x => x.customerId === 'c6');
    eq(o.length, 1, 'one order for the newly pinned shop');
    expect(Math.abs(o[0].customerLat - -13.9712) < 1e-6 && Math.abs(o[0].customerLng - 33.7891) < 1e-6, 'order copies the pin ' + JSON.stringify([o[0].customerLat, o[0].customerLng]));
    eq([(await store('orders')).length, (await store('visits')).length, (await doc('orderCounters/naisiOrder')).counter], [before.o + 1, before.v + 1, before.c + 1], 'one order, one visit, one number');
    // a second pin (correction) does not change who/when gets the credit (a saved order already cleared the selection)
    if (await page.locator('#lvClearCustomer').isVisible()) await page.click('#lvClearCustomer');
    await nav('navCustomersBtn'); await page.waitForSelector('#customerListBody tr');
    await page.click('#customerListBody tr[data-id="c6"] [data-action="set-location"]');
    await page.waitForSelector('#locationPickerModal', { state: 'visible' });
    await page.click('#lpUseMyLocationBtn'); await page.waitForTimeout(200); await page.click('#lpSaveBtn'); await toast(/Location saved/);
    const again = await doc('customers/c6');
    eq([again.firstPinnedBy, JSON.stringify(again.firstPinnedAt)], [c6.firstPinnedBy, JSON.stringify(c6.firstPinnedAt)], 'stamp unchanged by a re-pin');
    return 'stamped once';
  });
  await R.check('E59', 'A rep has no Weekly Schedule and no Walk-in Invoice tab', async () => {
    const tabs = await page.$$eval('.nav-tab', els => els.filter(e => e.offsetParent !== null).map(e => e.id));
    expect(!tabs.includes('navScheduleBtn') && !tabs.includes('navFormBtn'), 'tabs: ' + tabs);
    return tabs.join(', ');
  });
  await logout();

  // ---------------- 4. manager: one weekly schedule ----------------
  await login('mgr@naisi.test');
  await page.waitForSelector('#navOrdersBtn', { state: 'visible' });
  const rowsOf = (date) => page.$$eval(`#schedBoard details[data-date="${date}"] .sched-row`, rs => rs.map(r => ({ id: r.dataset.id, cls: [...r.classList].find(c => c.startsWith('st-')), text: r.querySelector('.sched-status').textContent })));
  const kpis = async () => (await page.locator('#schedKpis').innerText()).replace(/\s+/g, ' ');
  await R.check('E66', 'Older orders saved without a location are still flagged "No location" on the manager\'s order list', async () => {
    await page.waitForSelector('#orderListBody tr');
    const row = page.locator('#orderListBody tr', { hasText: 'ORD-2026-0049' });
    expect(/No location/.test(await row.innerText()), 'no flag on the unpinned order');
    const pinnedRow = page.locator('#orderListBody tr', { hasText: 'Foxtrot No Pin' });
    expect(!/No location/.test(await pinnedRow.innerText()), 'an order whose shop has since been pinned is not flagged');
    return 'flagged';
  });
  await R.check('E60', 'Weekly Schedule: plan + outcome per shop (order / no order / missed / due / planned), extra visits, week totals', async () => {
    await nav('navScheduleBtn'); await page.waitForSelector('#schedBoard details.sched-day');
    const mon = await rowsOf('2026-10-12'), tue = await rowsOf('2026-10-13'), thu = await rowsOf('2026-10-15'), fri = await rowsOf('2026-10-16');
    eq(mon.map(r => [r.id, r.cls]), [['c7', 'st-order']], 'Monday');
    eq(tue.map(r => [r.id, r.cls]), [['c8', 'st-missed']], 'Tuesday missed');
    const thuBy = Object.fromEntries(thu.map(r => [r.id, r.cls]));
    eq([thuBy.c1, thuBy.c2, thuBy.c3, thuBy.c6], ['st-order', 'st-noorder', 'st-noorder', 'st-order'], 'Thursday');
    eq(fri.map(r => [r.id, r.cls]), [['c5', 'st-planned']], 'Friday planned');
    expect(/Echo Friday/.test(await page.locator('#schedBoard details[data-date="2026-10-15"] .sched-extra').innerText()), 'extra visit listed');
    const k = await kpis();
    expect(/Visited \(any rep\) 5\/6 coverage 83%/i.test(k) && /Missed 1/i.test(k) && /Orders 4/i.test(k) && /No location 0/i.test(k) && /1 captured this week \(info only\)/i.test(k), 'kpis: ' + k);
    await shot('60-weekly-schedule');
    return k;
  });
  await R.check('E61', 'Weekly Schedule for one rep = Rep Performance for the same rep and dates (Scheduled, Visited, Still due, Orders, No order)', async () => {
    const result = {};
    for (const rep of ['rep1@naisi.test', 'rep2@naisi.test']) {
      await nav('navScheduleBtn'); await page.waitForSelector('#schedBoard details.sched-day');
      await page.selectOption('#schedRepFilter', rep);
      const k = await kpis();
      const visited = k.match(/Visited (\d+)\/(\d+)/i), orders = k.match(/Orders (\d+)/i), noOrder = k.match(/No order (\d+)/i), missed = k.match(/Missed (\d+)/i);
      const due = await page.$$eval('#schedBoard .st-due', x => x.length);
      await nav('navPerformanceBtn'); await page.waitForSelector('#perfFrom');
      await page.fill('#perfFrom', '2026-10-12'); await page.fill('#perfTo', '2026-10-15'); await page.click('#perfRunBtn');
      await page.waitForFunction(() => /12-10-2026/.test(document.getElementById('perfShownRange').textContent) && !/changed/.test(document.getElementById('perfShownRange').textContent));
      await page.selectOption('#perfRepFilter', rep); await page.waitForTimeout(150);
      const cells = await page.$$eval('#repSummaryBody tr', trs => [...trs[0].children].map(td => td.innerText.trim()));
      eq([visited[2], visited[1], String(Number(missed[1]) + due), orders[1], noOrder[1]], [cells[1], cells[2], cells[3], cells[4], cells[5]], `${rep}: board vs report`);
      result[rep] = cells.slice(1, 6).join('/');
    }
    await nav('navScheduleBtn'); await page.selectOption('#schedRepFilter', 'all');
    return JSON.stringify(result);
  });
  await R.check('E62', 'Immediate refresh: a board edit, an awaiting-list assignment, a spreadsheet import and a distance suggestion each show on the board straight away (saved plan + dated history reloaded)', async () => {
    await nav('navScheduleBtn'); await page.waitForSelector('#schedBoard details.sched-day');
    // (a) board edit: Echo Friday -> Thursday (today). Echo was visited today, so it becomes a measured, visited target at once.
    await page.selectOption('#schedBoard .sched-row[data-id="c5"] .customer-day-select', 'Thu');
    await toast(/Echo Friday now on Thursday/);
    await page.waitForFunction(() => !!document.querySelector('#schedBoard details[data-date="2026-10-15"] .sched-row[data-id="c5"].st-order'));
    eq((await rowsOf('2026-10-16')).length, 0, 'Friday empty at once');
    expect(!/Echo Friday/.test(await page.locator('#schedBoard details[data-date="2026-10-15"]').innerText().then(t => t.split(/Also visited/)[1] || '')), 'Echo no longer an extra visit');
    const h = await doc('scheduleChanges/' + (await doc('customers/c5')).lastScheduleChangeId);
    eq([h.kind, h.assignedDay], ['schedule', 'Thu'], 'dated history entry');
    // (b) awaiting-list assignment: India -> Friday
    await page.selectOption('#awaitingSchedulingList .customer-day-select[data-id="c9"]', 'Fri');
    await toast(/Visit day set/);
    await page.waitForFunction(() => !!document.querySelector('#schedBoard details[data-date="2026-10-16"] .sched-row[data-id="c9"]'));
    // (c) spreadsheet import: Hotel Tuesday -> Saturday
    await page.click('#schedTools > summary'); await page.click('#importDaysToggleBtn');
    await page.setInputFiles('#importDaysFile', { name: 'plan.csv', mimeType: 'text/csv', buffer: Buffer.from('Name,Day\nHotel Tuesday,Sat\n') });
    await page.waitForSelector('#importApplyBtn'); await page.click('#importApplyBtn'); await page.waitForSelector('#importDone');
    await page.waitForFunction(() => !!document.querySelector('#schedBoard details[data-date="2026-10-17"] .sched-row[data-id="c8"]'));
    eq((await rowsOf('2026-10-13')).map(r => r.id), ['c8'], 'Tuesday (past) keeps its dated target: history is not rewritten');
    // (d) distance suggestion: Kilo (unscheduled) placed next to nearby shops
    await page.click('#suggestScheduleToggleBtn'); await page.click('#suggestCalcBtn'); await page.waitForSelector('#suggestApplyBtn');
    await page.click('#suggestApplyBtn'); await page.waitForSelector('#suggestSummary');
    const kiloDay = (await doc('customers/c11')).assignedDay;
    expect(kiloDay, 'suggestion not applied');
    const kiloDate = { Mon: '2026-10-12', Tue: '2026-10-13', Wed: '2026-10-14', Thu: '2026-10-15', Fri: '2026-10-16', Sat: '2026-10-17' }[kiloDay];
    if (kiloDate >= '2026-10-15') await page.waitForFunction((d) => !!document.querySelector(`#schedBoard details[data-date="${d}"] .sched-row[data-id="c11"]`), kiloDate);
    expect(!(await page.locator('#awaitingSchedulingBox').isVisible()), 'awaiting box should be empty now');
    // the customer table follows too, and shows days as text only
    await nav('navCustomersBtn'); await page.waitForSelector('#customerListBody tr');
    eq(await page.locator('#customerListBody .customer-day-select').count(), 0, 'day selects in the customer table');
    expect(/Thursday/.test(await page.locator('#customerListBody tr[data-id="c5"]').innerText()), 'table shows the new day');
    await nav('navScheduleBtn'); await page.waitForSelector('#schedBoard details.sched-day');
    return `Echo->Thu, India->Fri, Hotel->Sat, Kilo->${kiloDay}`;
  });
  let boardToday = [];
  await R.check('E63', 'The rep\'s daily list agrees with the manager\'s board for today straight after the changes', async () => {
    boardToday = (await rowsOf('2026-10-15')).map(r => r.id).sort();
    await logout(); await login('rep1@naisi.test'); await page.waitForSelector('#todaysRouteList .todays-route-item');
    const repToday = (await page.$$eval('#todaysRouteList .todays-route-item', els => els.map(e => e.dataset.id))).sort();
    eq(repToday, boardToday, 'rep list vs board');
    eq(Number(await page.locator('#vpScheduled').innerText()), boardToday.length, 'scheduled count');
    await logout(); await login('mgr@naisi.test'); await page.waitForSelector('#navOrdersBtn', { state: 'visible' });
    return boardToday.join(', ');
  });
  await R.check('E64', 'Failed loads are shown as unavailable, never as zero activity, missed visits or percentages (Weekly Schedule and Rep Performance)', async () => {
    // visits fail on the board
    await fake(() => window.__fake.failNextQueries('visits', 1));
    await nav('navScheduleBtn');
    await page.waitForFunction(() => document.querySelector('#schedBoard details[data-date="2026-10-12"]')?.dataset.unavailable === 'visits');
    const k = await kpis();
    expect(/Visited \(any rep\) — unavailable/i.test(k) && /Missed — unavailable/i.test(k) && /Orders — unavailable/i.test(k), 'kpis: ' + k);
    eq(await page.$$eval('#schedBoard .st-missed, #schedBoard .st-due', x => x.length), 0, 'missed/due shown from a failed load');
    const banner = await page.locator('#schedLoadError').innerText();
    expect(/Visits could not be loaded/i.test(banner) && !/schedule history/i.test(banner), 'banner must blame the visits only: ' + banner);
    await shot('64-visits-unavailable');
    // schedule history fails: started days not measured
    await fake(() => window.__fake.failNextQueries('scheduleChanges', 1));
    await page.click('#schedThisWeekBtn');
    await page.waitForFunction(() => document.querySelector('#schedBoard details[data-date="2026-10-13"]')?.dataset.unavailable === 'history-failed');
    eq(await page.$$eval('#schedBoard .st-missed', x => x.length), 0, 'missed shown without history');
    expect(/history could not be loaded/i.test(await page.locator('#schedLoadError').innerText()), 'history banner');
    // recovers on the next load
    await page.click('#schedThisWeekBtn');
    await page.waitForFunction(() => !document.querySelector('#schedBoard details[data-unavailable]:not([data-unavailable=""])'));
    // Rep Performance: a fresh page with a failed load shows "Data unavailable" and no figures
    await page.reload(); await login('mgr@naisi.test'); await page.waitForSelector('#navOrdersBtn', { state: 'visible' });
    await fake(() => window.__fake.failNextQueries('visits', 1));
    await nav('navPerformanceBtn');
    await page.waitForSelector('#perfLoadError', { state: 'visible' });
    expect(/Data unavailable/.test(await page.locator('#perfLoadError').innerText()), 'report message');
    eq(await page.$$eval('#repSummaryBody tr', x => x.length), 0, 'report rows from a failed load');
    eq(await page.evaluate(() => document.getElementById('performanceView').dataset.reportState), 'unavailable', 'report state');
    return 'unavailable, not zero';
  });
  await R.check('E67', 'Week navigation: previous week shows its own dates and dated plan; "This week" returns', async () => {
    await nav('navScheduleBtn'); await page.waitForSelector('#schedBoard details.sched-day');
    await page.click('#schedPrevWeekBtn');
    await page.waitForFunction(() => document.querySelector('#schedBoard details.sched-day')?.dataset.date === '2026-10-05');
    expect(/5 Oct – 10 Oct 2026/.test(await page.locator('#schedWeekLabel').innerText()), 'label');
    eq((await rowsOf('2026-10-08')).map(r => r.cls).every(c => c === 'st-missed'), true, 'last Thursday: nobody visited');
    await page.click('#schedThisWeekBtn');
    await page.waitForFunction(() => document.querySelector('#schedBoard details.sched-day')?.dataset.date === '2026-10-12');
    return 'ok';
  });
  await R.check('E68', 'Manager expenses keep every category and still see the rep\'s older Fuel / Stock records', async () => {
    await nav('navExpensesBtn'); await page.waitForSelector('#expenseListBody tr');
    eq(await page.$$eval('#expCategory option', os => os.map(o => o.value)), ['Transport', 'Meals', 'Fuel', 'Stock', 'Other'], 'manager categories');
    const t = await page.locator('#expenseListBody').innerText();
    expect(/old record/.test(t) && /old stock record/.test(t), 'manager lost historical records');
    return 'all five; history kept';
  });
  await logout();
  await R.check('E65', 'Schedule history never started: the board says "History unavailable" for past days and today, marks nothing missed and calculates no coverage; upcoming days still show the plan', async () => {
    await page.goto(url);
    await fake((d) => window.__fake.seed(d), seedData({ history: false }));
    await page.reload(); await login('mgr@naisi.test'); await page.waitForSelector('#navOrdersBtn', { state: 'visible' });
    await nav('navScheduleBtn');
    await page.waitForFunction(() => document.querySelector('#schedBoard details[data-date="2026-10-12"]')?.dataset.unavailable === 'history');
    for (const d of ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15']) eq(await page.evaluate((x) => document.querySelector(`#schedBoard details[data-date="${x}"]`).dataset.unavailable, d), 'history', d);
    eq(await page.$$eval('#schedBoard .st-missed, #schedBoard .st-due', x => x.length), 0, 'missed/due without history');
    const k = await kpis();
    expect(/Visited \(any rep\) — coverage —/i.test(k) && /Missed —/i.test(k), 'kpis: ' + k);
    eq((await rowsOf('2026-10-16')).map(r => [r.id, r.cls]), [['c5', 'st-planned']], 'upcoming plan');
    await shot('65-history-unavailable');
    return k;
  });
  await R.check('E69', 'No JavaScript errors during the RC6.3 run', async () => { eq(errors, [], 'page errors'); });
} finally {
  const rows = R.rows;
  console.log('\n' + rows.map(r => `${r.status}\t${r.id}\t${r.name}`).join('\n'));
  await browser.close(); server.close();
  if (rows.some(r => r.status !== 'PASS')) process.exitCode = 1;
}
