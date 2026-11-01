// Stage 4 report builders, checked against hand-worked numbers.
import { describe, it, expect, vi } from 'vitest';
vi.mock('../../src/firebase.js', () => ({ db: {}, auth: {}, googleProvider: {} }));
import {
  floatBalanceSummary, moneyIssuedLog, expenseReportSummary, itemisedLines, fuelByVehicle, expenseVsFloat,
  categorySpend, periodOverPeriod, managerOwnExpenses, REPORTS,
} from '../../src/controlReports.js';

// A timestamp at a given Malawi date/time (UTC+2).
const ts = (iso) => ({ toDate: () => new Date(iso + '+02:00') });
const names = { u1: { name: 'Rep One', email: 'r1@x' }, u2: { name: 'Driver Two', email: 'd2@x' }, m: { name: 'Boss', email: 'm@x' } };
const from = '2026-10-01', to = '2026-10-31';

const settings = [
  { staffUid: 'u1', staffEmail: 'r1@x', floatTarget: 20000 },
  { staffUid: 'u2', staffEmail: 'd2@x', floatTarget: 30000, lastClosingBalance: 4000 },
];
const openPeriods = [{ staffUid: 'u1', startDate: '2026-10-05', openingBalance: 2000, totalIssued: 15000, totalApproved: 6500, floatTarget: 20000 }];
const records = [
  { recipientUid: 'u1', kind: 'issue', amount: 10000, issuedAt: ts('2026-10-05T09:00:00'), method: 'cash', issuedBy: 'm', reversedById: 'mr_a' },
  { recipientUid: 'u1', kind: 'reversal', amount: 10000, issuedAt: ts('2026-10-05T10:00:00'), method: 'cash', issuedBy: 'm' },
  { recipientUid: 'u1', kind: 'issue', amount: 15000, issuedAt: ts('2026-10-06T00:30:00'), method: 'mobile', reference: 'MP1', issuedBy: 'm' }, // 00:30 Malawi = 5 Oct UTC
  { recipientUid: 'u2', kind: 'issue', amount: 5000, issuedAt: ts('2026-09-30T23:00:00'), method: 'cash', issuedBy: 'm' },                   // outside range
];
const reports = [
  { id: 'r1', ownerUid: 'u1', ownerEmail: 'r1@x', title: 'W41', status: 'reviewed', createdAt: ts('2026-10-07T08:00:00') },
  { id: 'r2', ownerUid: 'u1', ownerEmail: 'r1@x', title: 'W42', status: 'submitted', createdAt: ts('2026-10-14T08:00:00') },
  { id: 'r3', ownerUid: 'u2', ownerEmail: 'd2@x', title: 'Truck', status: 'reviewed', createdAt: ts('2026-10-20T08:00:00') },
];
const lines = [
  { reportId: 'r1', ownerUid: 'u1', date: '2026-10-06', category: 'Transport', amount: 1500, lineStatus: 'approved', notes: 'Minibus' },
  { reportId: 'r1', ownerUid: 'u1', date: '2026-10-06', category: 'Meals', amount: 900, lineStatus: 'rejected', notes: 'Lunch', decisionNote: 'No receipt' },
  { reportId: 'r1', ownerUid: 'u1', date: '2026-10-07', category: 'EmergencyCash', amount: 5000, lineStatus: 'approved', notes: 'Tyre' },
  { reportId: 'r2', ownerUid: 'u1', date: '2026-10-13', category: 'Transport', amount: 1200, lineStatus: 'pending', notes: 'Taxi' },
  { reportId: 'r3', ownerUid: 'u2', date: '2026-10-19', category: 'VehicleMaintenance', amount: 6000, lineStatus: 'approved', notes: 'Puncture', vehicleId: 'v1' },
];
const vehicles = [
  { id: 'v1', registration: 'MW 1 A', description: 'Truck', assignedToUid: 'u2', active: true },
  { id: 'v2', registration: 'MW 2 B', description: 'Van', assignedToUid: null, active: true },
];
const expenses = [
  { date: '2026-10-02', category: 'Fuel', amount: 20000, createdBy: 'u2', createdByEmail: 'd2@x', vehicleId: 'v1' },
  { date: '2026-10-09', category: 'Fuel', amount: 10000, createdBy: 'u2', createdByEmail: 'd2@x' },             // old entry: via assigned driver -> v1
  { date: '2026-10-10', category: 'Fuel', amount: 7000, createdBy: 'm', createdByEmail: 'm@x' },               // manager, no vehicle -> not linked
  { date: '2026-10-11', category: 'Fuel', amount: 3000, createdBy: 'm', createdByEmail: 'm@x', vehicleId: 'v2' },
  { date: '2026-10-12', category: 'Stock', amount: 50000, createdBy: 'm', createdByEmail: 'm@x' },
  { date: '2026-11-02', category: 'Fuel', amount: 999, createdBy: 'u2', vehicleId: 'v1' },                      // outside range
];

describe('Float Balance Summary', () => {
  it('open period position, last closing balance otherwise, cash-in-field total', () => {
    const r = floatBalanceSummary({ settings, openPeriods, names });
    const one = r.rows.find(x => x.person === 'Rep One');
    expect(one).toMatchObject({ opening: 2000, issued: 15000, approved: 6500, balance: 10500, topUp: 9500 });
    expect(r.rows.find(x => x.person === 'Driver Two')).toMatchObject({ balance: 4000, topUp: null, status: 'No open period' });
    expect(r.totals).toMatchObject({ balance: 14500, topUp: 9500, target: 50000 });
  });
});

describe('Money Issued Log', () => {
  it('uses the Malawi day, shows reversals negative, nets to what went out', () => {
    const r = moneyIssuedLog({ records, names, from, to });
    expect(r.rows.map(x => [x.date, x.type, x.amount])).toEqual([
      ['2026-10-05', 'Issue (reversed)', 10000], ['2026-10-05', 'Reversal', -10000], ['2026-10-06', 'Issue', 15000]]);
    expect(r.totals.amount).toBe(15000);
  });
});

describe('Expense Report Summary', () => {
  it('claimed vs approved vs rejected vs pending per report', () => {
    const r = expenseReportSummary({ reports, lines, names, from, to });
    expect(r.rows.find(x => x.report === 'W41')).toMatchObject({ lines: 3, claimed: 7400, approved: 6500, rejected: 900, pending: 0, approvalRate: 87.84 });
    expect(r.rows.find(x => x.report === 'W42')).toMatchObject({ status: 'Waiting for approval', pending: 1200 });
    expect(r.totals).toMatchObject({ claimed: 14600, approved: 12500, rejected: 900, pending: 1200 });
  });
});

describe('Itemised lines and Rejected log', () => {
  it('all lines in range with vehicle names; rejected log keeps only rejected with reason', () => {
    const r = itemisedLines({ lines, reports, names, vehicles, from, to });
    expect(r.rows).toHaveLength(5);
    expect(r.totals.amount).toBe(14600);
    expect(r.rows.find(x => x.category === 'Vehicle/Maintenance').vehicle).toBe('MW 1 A');
    const rej = itemisedLines({ lines, reports, names, vehicles, from, to, status: 'rejected' });
    expect(rej.title).toBe('Rejected Expense Log');
    expect(rej.rows.map(x => [x.what, x.amount, x.decisionNote])).toEqual([['Lunch', 900, 'No receipt']]);
  });
});

describe('Fuel by Vehicle', () => {
  it('fuel by vehicle, old driver fuel via assigned vehicle, approved maintenance added, unlinked fuel shown', () => {
    const r = fuelByVehicle({ expenses, lines, vehicles, names, from, to });
    const v1 = r.rows.find(x => x.vehicle === 'MW 1 A');
    expect(v1).toMatchObject({ fuelCount: 2, fuel: 30000, fuelViaDriver: 10000, maintenance: 6000, total: 36000, driver: 'Driver Two' });
    expect(r.rows.find(x => x.vehicle === 'MW 2 B')).toMatchObject({ fuel: 3000, total: 3000 });
    expect(r.rows.find(x => x.vehicle.startsWith('Not linked'))).toMatchObject({ vehicle: 'Not linked to a vehicle (Boss)', fuel: 7000 });
    expect(r.totals).toMatchObject({ fuelCount: 4, fuel: 40000, maintenance: 6000, total: 46000 });
    expect(r.rows[0].vehicle).toBe('MW 1 A');   // biggest first
  });
});

describe('Rep Expense vs Float', () => {
  it('per person over the range', () => {
    const r = expenseVsFloat({ settings, openPeriods, records, lines, names, from, to });
    expect(r.rows.find(x => x.person === 'Rep One')).toMatchObject({ issued: 15000, claimed: 8600, approved: 6500, rejected: 900, pending: 1200, balanceNow: 10500, spendVsTarget: 32.5 });
    expect(r.rows.find(x => x.person === 'Driver Two')).toMatchObject({ issued: 0, approved: 6000, balanceNow: 4000, spendVsTarget: 20 });
  });
});

describe('Priority 2', () => {
  it('Category Spend: approved only, shares and biggest claimant', () => {
    const r = categorySpend({ lines, names, from, to });
    expect(r.totals).toMatchObject({ lines: 3, amount: 12500 });
    expect(r.rows[0]).toMatchObject({ category: 'Vehicle/Maintenance', amount: 6000, share: 48, top: 'Driver Two (100%)' });
    expect(r.rows.find(x => x.category === 'Meals')).toBeUndefined();
  });
  it('Period-over-Period: closed periods in range', () => {
    const r = periodOverPeriod({ names, from, to, periods: [
      { staffUid: 'u1', status: 'closed', closedAt: ts('2026-10-04T17:00:00'), startDate: '2026-09-28', openingBalance: 0, totalIssued: 20000, totalApproved: 18000, closingBalance: 2000, proposedTopUp: 18000 },
      { staffUid: 'u1', status: 'open', startDate: '2026-10-05' },
    ] });
    expect(r.rows).toEqual([{ closed: '2026-10-04', person: 'Rep One', started: '2026-09-28', opening: 0, issued: 20000, approved: 18000, closing: 2000, topUp: 18000 }]);
  });
  it('Manager Business Expenses: entries by managers only', () => {
    const r = managerOwnExpenses({ expenses, managerEmails: ['M@x'], names, from, to });
    expect(r.rows.map(x => x.amount)).toEqual([7000, 3000, 50000]);
    expect(r.totals.amount).toBe(60000);
  });
  it('catalogue: 6 core + 4 analysis reports, each with a builder', () => {
    expect(REPORTS.filter(r => r.priority === 1)).toHaveLength(6);
    expect(REPORTS.filter(r => r.priority === 2)).toHaveLength(4);
    for (const r of REPORTS) expect(typeof r.build).toBe('function');
  });
});
