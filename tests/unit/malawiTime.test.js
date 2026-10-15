import { describe, it, expect } from 'vitest';
const t = await import('../../src/malawiTime.js');

describe('Malawi date boundaries (Africa/Blantyre, UTC+2)', () => {
  it('22:30 UTC Thursday is already Friday 00:30 in Malawi', () => {
    const i = new Date('2026-10-15T22:30:00Z');           // Thursday in UTC
    expect(t.malawiDate(i)).toBe('2026-10-16');
    expect(t.malawiWeekday(i)).toBe('Fri');
  });
  it('21:59:59 UTC is still Thursday 23:59:59 in Malawi; 22:00:00 UTC is Friday', () => {
    expect(t.malawiDate(new Date('2026-10-15T21:59:59Z'))).toBe('2026-10-15');
    expect(t.malawiDate(new Date('2026-10-15T22:00:00Z'))).toBe('2026-10-16');
  });
  it('year and month boundaries', () => {
    expect(t.malawiDate(new Date('2026-12-31T22:00:00Z'))).toBe('2027-01-01');
    expect(t.malawiDate(new Date('2026-02-28T23:00:00Z'))).toBe('2026-03-01');
  });
  it('independent of the process time zone', () => {
    const i = new Date('2026-10-15T22:30:00Z');
    expect(t.malawiDate(i)).toBe('2026-10-16');
  });
  it('weekday of a calendar date', () => {
    expect(t.weekdayOfDate('2026-10-15')).toBe('Thu');
    expect(t.weekdayOfDate('2026-10-18')).toBe('Sun');
    expect(() => t.weekdayOfDate('2026-02-30')).toThrow();
    expect(() => t.weekdayOfDate('15/10/2026')).toThrow();
  });
  it('datesInRange', () => {
    expect(t.datesInRange('2026-10-14', '2026-10-16')).toEqual(['2026-10-14', '2026-10-15', '2026-10-16']);
    expect(t.datesInRange('2026-10-16', '2026-10-14')).toEqual([]);
    expect(t.addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});

// ---- Review finding 3: no silent truncation; one effective reporting interval ----
describe('report range limit', () => {
  it('MAX_REPORT_DAYS is 366 and daysInRange counts inclusively', () => {
    expect(t.MAX_REPORT_DAYS).toBe(366);
    expect(t.daysInRange('2026-10-15', '2026-10-15')).toBe(1);
    expect(t.daysInRange('2026-10-14', '2026-10-16')).toBe(3);
    expect(t.daysInRange('2024-02-28', '2024-03-01')).toBe(3);   // 28 Feb, 29 Feb (leap day), 1 Mar
    expect(t.daysInRange('2025-02-28', '2025-03-01')).toBe(2);   // no leap day in 2025
  });
  it('exactly the maximum is accepted (inclusive start and end), one day more is refused', () => {
    expect(t.daysInRange('2024-01-01', '2024-12-31')).toBe(366);            // leap year
    expect(t.validateReportRange('2024-01-01', '2024-12-31')).toBeNull();
    expect(t.datesInRange('2024-01-01', '2024-12-31')).toHaveLength(366);
    expect(t.datesInRange('2024-01-01', '2024-12-31').at(-1)).toBe('2024-12-31');
    expect(t.daysInRange('2025-03-01', '2026-03-01')).toBe(366);            // spans 12 months, not a leap year
    expect(t.validateReportRange('2025-03-01', '2026-03-01')).toBeNull();
    expect(t.daysInRange('2025-03-01', '2026-03-02')).toBe(367);
    const msg = t.validateReportRange('2025-03-01', '2026-03-02');
    expect(msg).toMatch(/366/); expect(msg).toMatch(/shorter|split/i);
    expect(t.validateReportRange('2025-01-01', '2025-12-31')).toBeNull();   // 365 days
  });
  it('a two-year range is refused with an explanation, never truncated', () => {
    expect(t.validateReportRange('2025-01-01', '2026-12-31')).toMatch(/366/);
    expect(() => t.datesInRange('2025-01-01', '2026-12-31')).toThrow(RangeError);
    expect(() => t.datesInRange('2024-01-01', '2025-01-01')).toThrow(RangeError);   // 367 days
  });
  it('invalid or reversed ranges are reported, not quietly emptied', () => {
    expect(t.validateReportRange('', '2026-10-15')).toMatch(/date/i);
    expect(t.validateReportRange('2026-10-16', '2026-10-15')).toMatch(/after/i);
    expect(t.validateReportRange('2026-02-30', '2026-03-01')).toMatch(/date/i);
  });
});
