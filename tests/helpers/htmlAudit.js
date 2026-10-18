// Static audit of HTML built from template literals: every interpolation that lands in HTML must go through esc(),
// unless it is one of the helpers that return finished (already-escaped) HTML. Used by tests/unit/htmlSafety.test.js.
// Every name in SAFE must be a helper defined in src/ whose own template is audited by the same analysis (tests/unit/htmlSafety.test.js checks that),
// and currency/number formatters (mwk, kmText, pctText, formatKm) are deliberately NOT exempt: they go through esc() at every sink.
// It is a guard against regressions, not a proof; the browser test (E53) is the behavioural check.
export const SAFE = [
  /^customerDayCellHtml\(/, /^customerMapCellHtml\(/, /^customerStatusCellHtml\(/, /^visitStatusHtml\(/, /^orderStatusBadge\(/, /^badgeHtml\(/, /^invalidAmountNote\(/,
  /^(options|optionsFor\(r\)|dayRows|skipped|blockedNote|byCell|byEditCell|actions|checkboxCell|baseCells|topProductsHtml|itemsHtml|failText|rows\.map\(line\)\.join\(''\)|moveRows|statusBreakdown|expenseBreakdown)$/, /^counts\.invoicing\.map\(esc\)/,
];

export function analyze(src) {
  const templates = []; // {start,end,exprs:[{s,e}]}
  function skipString(i, q) { i++; while (i < src.length) { if (src[i] === '\\') i += 2; else if (src[i] === q) return i + 1; else i++; } throw new Error('unterminated string'); }
  function scanTemplate(i) {
    const t = { start: i, exprs: [], text: '' }; templates.push(t); i++;
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { t.text += src.slice(i, i + 2); i += 2; continue; }
      if (c === '`') { t.end = i; return i + 1; }
      if (c === '$' && src[i + 1] === '{') { const s = i + 2; const e = scanExpr(s); t.exprs.push({ s, e }); t.text += '\u0000'; i = e + 1; continue; }
      t.text += c; i++;
    }
    throw new Error('unterminated template');
  }
  function scanExpr(i) {
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === '"' || c === "'") { i = skipString(i, c); continue; }
      if (c === '`') { i = scanTemplate(i); continue; }
      if (c === '/' && src[i + 1] === '/') { while (src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 2; continue; }
      if (c === '{') depth++;
      else if (c === '}') { if (depth === 0) return i; depth--; }
      i++;
    }
    throw new Error('unterminated expr');
  }
  // top level walk
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") { i = skipString(i, c); continue; }
    if (c === '`') { i = scanTemplate(i); continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 2; continue; }
    if (c === '/') { // regex literal heuristic: previous non-space char is one of ( , = : [ ! & | ? { } ; or start
      let j = i - 1; while (j >= 0 && /\s/.test(src[j])) j--;
      if (j < 0 || /[(,=:\[!&|?{};+\-*%<>]/.test(src[j]) || /(return|typeof)$/.test(src.slice(Math.max(0, j - 6), j + 1))) {
        i++; let inClass = false; while (i < src.length) { if (src[i] === '\\') i += 2; else if (src[i] === '[') { inClass = true; i++; } else if (src[i] === ']') { inClass = false; i++; } else if (src[i] === '/' && !inClass) { i++; break; } else i++; }
        continue;
      }
    }
    i++;
  }
  const inserts = []; const review = [];
  const isHtml = new Map();
  for (const t of templates) isHtml.set(t, /<[a-zA-Z\/!]/.test(t.text));
  // templates nested inside an expression of an HTML template inherit HTML context
  let changed = true;
  while (changed) { changed = false; for (const t of templates) { if (isHtml.get(t)) continue; const par = templates.find(p => isHtml.get(p) && p.exprs.some(x => t.start > x.s && t.start < x.e)); if (par) { isHtml.set(t, true); changed = true; } } }
  for (const t of templates) {
    if (!isHtml.get(t)) continue;
    for (const { s, e } of t.exprs) {
      const x = src.slice(s, e).trim();
      const line = src.slice(0, s).split('\n').length;
      if (/^esc\(/.test(x) && x.endsWith(')') && (() => { let d = 0; for (let k = 3; k < x.length; k++) { if (x[k] === '(') d++; else if (x[k] === ')') { d--; if (d === 0 && k < x.length - 1) return false; } } return true; })()) continue;
      if (SAFE.some(r => r.test(x))) continue;
      // contains an HTML-bearing nested template or string literal -> leave whole expression, nested ones are handled on their own
      const hasNested = templates.some(n => n.start > s && n.start < e) || /\besc\(/.test(x);
      if (hasNested && !(/<[a-zA-Z\/]/.test(x))) { review.push(`${line}: [nested/esc, not wrapped; inner handled] ${x.replace(/\s+/g, ' ').slice(0, 130)}`); continue; }
      const hasHtmlLiteral = /<[a-zA-Z\/]/.test(x) || templates.some(n => n.start > s && n.start < e && /<[a-zA-Z\/!]/.test(n.text));
      if (hasHtmlLiteral) { review.push(`${line}: [html-bearing, not wrapped] ${x.replace(/\s+/g, ' ').slice(0, 130)}`); continue; }
      inserts.push({ pos: s, str: 'esc(' }, { pos: e, str: ')' });
      review.push(`${line}: wrap ${x.replace(/\s+/g, ' ').slice(0, 100)}`);
    }
  }
  
  return { inserts, review };
}
