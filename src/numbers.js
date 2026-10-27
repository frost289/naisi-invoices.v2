// Strict whole-number parsing used at the points where numbers are written
// to the database (not just in the HTML form). Returns a positive safe
// integer, or null for anything else: blank, fractions, negatives, NaN,
// Infinity, exponent/hex strings, values beyond Number.MAX_SAFE_INTEGER.
export function wholeNumber(value) {
  if (typeof value === 'string') {
    const s = value.trim();
    if (!/^\d+$/.test(s)) return null;
    value = Number(s);
  }
  return (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) ? value : null;
}
