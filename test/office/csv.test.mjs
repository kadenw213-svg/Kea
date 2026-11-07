// CSV round trip (src/editors/sheet/csv.ts): a file opened and saved without edits comes back byte for byte;
// an edited date is written as 2026-11-01; formatting alone adds no rows; what CSV can't keep is named.
//   node --test test/office/
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
let C, M;
before(async () => {
  const build = async (entry) => {
    const out = path.join(os.tmpdir(), `kea-office-${path.basename(entry)}-${process.pid}.cjs`);
    await require('esbuild').build({ entryPoints: [path.resolve(here, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
    const mod = require(out);
    fs.rmSync(out, { force: true });
    return mod;
  };
  C = await build('../../src/editors/sheet/csv.ts');
  M = await build('../../src/editors/sheet/model.ts');
});

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);
const roundTrip = (bytes, name = 'data.csv') => {
  const sheet = C.readCsvSheet(bytes, name.endsWith('.tsv') ? '\t' : undefined, name);
  return C.writeCsv({ sheets: [sheet] }, 0, name.endsWith('.tsv') ? '\t' : undefined);
};

test('an unedited CSV is written back exactly', () => {
  const files = [
    'date,amount,id\r\n2026-11-01,12.50,007\r\n2026-11-02,"1,000",010\r\n2026-11-03,$4,=SUM(A1)\r\n',
    'name;when\nAnn;1/2/2026\nBo;Mar 5 2026\n',
    'a,b,c\n1,,3\n,,\n',
    'no final newline,x\n1,2',
    'ragged\n1,2,3\n4\n',
    '"quoted","also ""quoted"""\n"","x"\n',
    ' 12 ,TRUE,50%\n',
    ''
  ];
  for (const f of files) assert.equal(dec(roundTrip(enc(f))), f, JSON.stringify(f));
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...enc('a,b\r\n1,2\r\n')]);
  assert.deepEqual([...roundTrip(bom)], [...bom], 'BOM kept');
  const latin = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x2c, 0x31, 0x0a]); // "café,1\n" in Latin-1
  assert.deepEqual([...roundTrip(latin)], [...latin], 'Latin-1 kept');
  const tsv = 'a\tb\n2026-01-05\t3\n';
  assert.equal(dec(roundTrip(enc(tsv), 'x.tsv')), tsv, 'TSV');
});

test('only edited cells change; edited dates are ISO; formatting adds no rows', () => {
  const sheet = C.readCsvSheet(enc('when,n\r\n2026-11-01,1\r\n2026-11-02,2\r\n'), undefined, 'd.csv');
  // Bold a cell and give a far-away empty cell formatting only (as selecting and styling would).
  sheet.cells['1,0'] = { ...sheet.cells['1,0'], s: { ...sheet.cells['1,0'].s, b: true } };
  sheet.cells['9,5'] = { s: { b: true } };
  // Type a new date and a number.
  const typed = M.parseInput('11/5/2026');
  sheet.cells['2,0'] = { ...typed.cell, s: typed.fmt };
  sheet.cells['3,1'] = { v: 7 };
  assert.equal(dec(C.writeCsv({ sheets: [sheet] }, 0)), 'when,n\r\n2026-11-01,1\r\n2026-11-05,2\r\n,7\r\n');
});

test('what CSV would drop is named; number formats are not a loss', () => {
  const plain = C.readCsvSheet(enc('when,cost\n2026-11-01,$5\n'), undefined, 'd.csv');
  assert.equal(C.csvLosses({ sheets: [plain] }, 0), null, 'dates and currency read from the file are fine');
  plain.cells['0,0'] = { ...plain.cells['0,0'], s: { b: true } };
  assert.equal(C.csvLosses({ sheets: [plain] }, 0), 'formatting');
  plain.cells['5,5'] = { f: 'SUM(B1:B2)' };
  assert.equal(C.csvLosses({ sheets: [plain, M.newSheet('Two')] }, 0), 'formatting, formulas and other sheets');
});
