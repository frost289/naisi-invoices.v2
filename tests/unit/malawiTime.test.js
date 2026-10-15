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
