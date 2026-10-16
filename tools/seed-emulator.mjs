// Writes FAKE sample data into a RUNNING LOCAL Firestore emulator (127.0.0.1:8080). Never touches a live project:
// it refuses to run unless FIRESTORE_EMULATOR_HOST (or the default 127.0.0.1:8080) answers as the emulator.
//   node tools/seed-emulator.mjs            (project id defaults to naisi-invoices, the id the app is configured with)
// Fake logins (the app signs in with email + password; these accounts are created in the Auth emulator, password Passw0rd!):
//   mgr@example.com (manager)  rep1@example.com, rep2@example.com (sales reps)  deliv@example.com (deliverer)  stranger@example.com (no role)
const HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const PROJECT = process.env.NAISI_PROJECT || 'naisi-invoices';
const base = `http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents`;

try {
  const r = await fetch(`http://${HOST}/`);
  const t = await r.text();
  if (!/Ok/i.test(t)) throw new Error('unexpected answer');
} catch (e) {
  console.error(`No Firestore emulator answered at ${HOST}. Start it first (start-emulators.bat). Nothing was written.`);
  process.exit(1);
}

const enc = (v) => {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
};
async function put(path, data) {
  const res = await fetch(`${base}/${path}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', authorization: 'Bearer owner' },   // "owner" bypasses rules (emulator only)
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, enc(v)])) }),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
}

// ---- fake Auth accounts (Auth emulator, 127.0.0.1:9099). Skipped with a warning if it is not running. ----
const AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const PASSWORD = 'Passw0rd!';
for (const email of ['mgr@example.com', 'rep1@example.com', 'rep2@example.com', 'deliv@example.com', 'stranger@example.com']) {
  try {
    const r = await fetch(`http://${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD, returnSecureToken: false }) });
    const j = await r.json();
    if (r.ok) console.log(`Auth account created: ${email}`);
    else if (j?.error?.message === 'EMAIL_EXISTS') console.log(`Auth account already exists: ${email}`);
    else console.warn(`Auth account ${email}: ${JSON.stringify(j)}`);
  } catch { console.warn(`Auth emulator not reachable at ${AUTH}: accounts were NOT created (start-emulators.bat starts it).`); break; }
}

const now = new Date();
await put('config/roles', { managers: ['mgr@example.com'], submitters: ['rep1@example.com', 'rep2@example.com'], deliverers: ['deliv@example.com'] });
await put('counters/naisiInvoice', { prefix: 'NF-INV', counter: 101 });
await put('orderCounters/naisiOrder', { counter: 11 });
const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const shops = ['Chilomoni Grocery', 'Area 25 Tuckshop', 'Kawale Mini Market', 'Lumbadzi Stores', 'Mchesi Trading', 'Area 3 Supermarket', 'Biwi Shop', 'Falls Estate Kiosk', 'Old Town Wholesale', 'Area 18 Tuckshop', 'Closed Down Store'];
for (const [i, name] of shops.entries()) {
  const closed = name.startsWith('Closed');
  await put(`customers/c${i + 1}`, { name, phone: `088800${String(i).padStart(4, '0')}`, location: `Area ${i + 1}`, active: !closed,
    assignedDay: closed ? null : days[i % 6], lat: -13.96 + i * 0.004, lng: 33.77 + i * 0.004, createdBy: 'mgr', createdAt: now, updatedAt: now });
}
const prods = [['Angel Instant Dry Yeast', 'Box (25 x 10g Sachets)', 25, 10500, 40, null], ['Angel Instant Dry Yeast', 'Case (12 Boxes)', 12, 114000, 12, null],
  ['Bakerdream Instant Dry Yeast', '1 x 450g Pack', 1, 8000, 80, 20], ['Amanda Baking Powder', '100g Strip', 1, 900, 200, 14]];
for (const [i, [productName, packLabel, quantity, price, stockOnHand, unitsPerCase]] of prods.entries())
  await put(`products/p${i + 1}`, { productName, packLabel, quantity, price, stockOnHand, ...(unitsPerCase ? { unitsPerCase } : {}), createdBy: 'mgr', createdAt: now, updatedAt: now });
const line = { productId: 'p3', desc: 'Bakerdream 450g', qty: 5, price: 8000, total: 40000 };
const orderBase = (n, status, extra = {}) => ({ orderNo: `ORD-${now.getFullYear()}-${String(n).padStart(4, '0')}`, status, customerId: 'c1', customerName: shops[0], customerPhone: '0888000000',
  customerLocation: 'Area 1', customerLat: -13.96, customerLng: 33.77, items: [line], notes: '', grandTotal: 40000, createdBy: 'rep1', createdByEmail: 'rep1@example.com',
  createdAt: now, updatedAt: now, submittedAt: now, invoiceId: null, invoiceNo: null, ...extra });
await put('orders/seedSubmitted', orderBase(8, 'Submitted'));
await put('orders/seedApproved', orderBase(9, 'Approved', { customerId: 'c2', customerName: shops[1], approvedAt: now }));
await put('orders/seedInvoiced', orderBase(10, 'Invoiced', { customerId: 'c3', customerName: shops[2], invoiceId: 'ord_seedInvoiced', invoiceNo: `NF-INV-${now.getFullYear()}-0100`, invoicedAt: now }));
await put('invoices/ord_seedInvoiced', { orderId: 'seedInvoiced', invoiceNo: `NF-INV-${now.getFullYear()}-0100`, customer: shops[2], customerId: 'c3', items: [line], grandTotal: 40000, createdBy: 'mgr', createdAt: now });
console.log(`Seeded fake data into emulator project "${PROJECT}" at ${HOST}: roles, ${shops.length} customers, ${prods.length} products, counters, 3 orders, 1 invoice.`);
