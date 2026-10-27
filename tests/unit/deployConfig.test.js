// Finding 6: deployment configuration. The release rules, the emulator config, the rules tests and the indexes must all name
// the same existing files. These are static checks (no emulator): they catch a missing file or a mismatched path before deployment.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const json = (p) => JSON.parse(read(p));

describe('F6 deployment configuration', () => {
  const rulesRel = json('firebase.json').firestore?.rules;
  it('firebase.json points at a rules file that exists and is not empty', () => {
    expect(rulesRel, 'firebase.json has no firestore.rules').toBeTruthy();
    expect(fs.existsSync(path.join(root, rulesRel)), `${rulesRel} is referenced by firebase.json but does not exist`).toBe(true);
    expect(read(rulesRel).startsWith("rules_version = '2'")).toBe(true);
  });
  it('the emulator config uses EXACTLY the same rules file as deployment', () => {
    expect(json('firebase.emulators.json').firestore.rules).toBe(rulesRel);
  });
  it('the rules tests default to the same file', () => {
    const t = read('tests/rules/invoicing.rules.test.js');
    expect(t).toContain("'../../" + rulesRel + "'");
    expect(t).not.toMatch(/FINAL-CANDIDATE/);
  });
  it('no script or document still names a rules file that does not exist', () => {
    const files = ['run-rules-tests.bat', 'start-emulators.bat', 'run-app-on-emulators.bat', 'docs/DEPLOYMENT-AND-RULES.md', 'docs/WINDOWS-TESTING.md', 'docs/RELEASE-CHECKLIST.md', 'tests/README.md', 'docs/FINAL-RULES.md'];
    for (const f of files) {
      if (!fs.existsSync(path.join(root, f))) continue;
      for (const m of read(f).matchAll(/rules\/(firestore[A-Za-z0-9._-]*)/g)) {
        expect(fs.existsSync(path.join(root, 'rules', m[1])), `${f} mentions rules/${m[1]} which does not exist`).toBe(true);
      }
    }
  });
  it('hosting serves the build folder and rewrites to index.html', () => {
    const h = json('firebase.json').hosting;
    expect(h.public).toBe('dist');
    expect(h.rewrites).toEqual([{ source: '**', destination: '/index.html' }]);
  });
  it('the rules file is balanced and every function it calls is defined (static lint, NOT a substitute for the emulator tests)', () => {
    const src = read(rulesRel).replace(/\/\/.*$/gm, '').replace(/'[^'\n]*'/g, "''");
    for (const [o, c] of [['(', ')'], ['{', '}'], ['[', ']']]) expect(src.split(o).length, `unbalanced ${o}${c}`).toBe(src.split(c).length);
    const defined = new Set([...src.matchAll(/function\s+([A-Za-z0-9_]+)\s*\(/g)].map(m => m[1]));
    const builtin = new Set(['get', 'exists', 'getAfter', 'existsAfter', 'string', 'int', 'float', 'duration', 'timestamp', 'hasOnly', 'hasAll', 'hasAny', 'keys', 'size', 'matches', 'replace', 'trim', 'diff', 'affectedKeys', 'value', 'abs', 'toMillis', 'concat', 'join', 'match', 'service', 'allow', 'if', 'else', 'let', 'return', 'path', 'debug']);
    const called = [...src.matchAll(/(?<![.\w])([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)].map(m => m[1]).filter(n => !builtin.has(n));
    const missing = [...new Set(called)].filter(n => !defined.has(n));
    expect(missing, 'called but never defined: ' + missing.join(', ')).toEqual([]);
  });
});

describe('F6 indexes', () => {
  it('firestore.indexes.json exists, is referenced by both configs, and is valid', () => {
    expect(json('firebase.json').firestore.indexes).toBe('firestore.indexes.json');
    expect(json('firebase.emulators.json').firestore.indexes).toBe('firestore.indexes.json');
    const idx = json('firestore.indexes.json');
    expect(Array.isArray(idx.indexes)).toBe(true);
    for (const i of idx.indexes) { expect(i.collectionGroup).toBeTruthy(); expect(i.fields.length).toBeGreaterThanOrEqual(2); }
  });
  it('every query that filters by equality on one field and sorts by another has a declared composite index', () => {
    const declared = new Set(json('firestore.indexes.json').indexes.map(i => `${i.collectionGroup}|${i.fields.map(f => f.fieldPath + ':' + f.order).join(',')}`));
    const needed = new Set();
    const srcDir = path.join(root, 'src');
    for (const f of fs.readdirSync(srcDir).filter(x => x.endsWith('.js'))) {
      const code = fs.readFileSync(path.join(srcDir, f), 'utf8');
      for (const chunk of code.split(/\n(?=(?:export )?(?:async )?function )/)) {
        const colls = [...chunk.matchAll(/collection\(db,\s*'([A-Za-z]+)'\)/g)].map(m => m[1]);
        const eq = [...chunk.matchAll(/where\('([A-Za-z]+)',\s*'=='/g)].map(m => m[1]);
        const ord = [...chunk.matchAll(/orderBy\('([A-Za-z]+)'(?:,\s*'(desc|asc)')?\)/g)].map(m => [m[1], m[2] === 'desc' ? 'DESCENDING' : 'ASCENDING']);
        if (colls.length !== 1 || !eq.length || !ord.length) continue;
        for (const e of eq) for (const [o, dir] of ord) if (o !== e) needed.add(`${colls[0]}|${e}:ASCENDING,${o}:${dir}`);
      }
    }
    expect(needed.size).toBeGreaterThan(0);
    const missing = [...needed].filter(n => !declared.has(n));
    expect(missing, 'composite indexes used by the app but not declared:\n' + missing.join('\n')).toEqual([]);
  });
});
