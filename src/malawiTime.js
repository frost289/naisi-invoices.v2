// All "what day is it?" decisions for visits use Malawi time (Africa/Blantyre,
// UTC+2, no daylight saving), never the phone's own time zone and never UTC.
// A visit logged at 00:30 on Friday in Lilongwe is a Friday visit even though
// it is still Thursday in UTC.
//
// Limit: the instant comes from the device clock (Date.now()). The server
// timestamp `createdAt` stored with each visit is the authoritative time; the
// `date` string is derived on the device. A device with a badly wrong clock
// could therefore record the wrong calendar day. See docs/DAILY-VISITS.md.
export const MALAWI_TZ = 'Africa/Blantyre';
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: MALAWI_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

// 'YYYY-MM-DD' for the given instant, as the calendar date in Malawi.
export function malawiDate(instant = new Date()) {
  const parts = dateFmt.formatToParts(instant);
  const get = (t) => parts.find(p => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function isDateString(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// 'Mon'..'Sun' for a calendar date string. A calendar date has the same
// weekday everywhere, so this is computed in UTC.
export function weekdayOfDate(dateStr) {
  if (!isDateString(dateStr)) throw new Error('Invalid date: ' + dateStr);
  return WEEKDAYS[new Date(dateStr + 'T00:00:00Z').getUTCDay()];
}

export function malawiWeekday(instant = new Date()) { return weekdayOfDate(malawiDate(instant)); }

export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Every calendar date from..to inclusive (empty if from > to; capped at 366).
export function datesInRange(from, to) {
  if (!isDateString(from) || !isDateString(to) || from > to) return [];
  const out = [];
  for (let d = from; d <= to && out.length < 366; d = addDays(d, 1)) out.push(d);
  return out;
}
