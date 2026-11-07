// Office files with parts Kea can't keep (src/lib/officeLossScan.ts): found when the file opens, so autosave leaves
// the original alone and Save asks. Kea's own files and plain ones are not flagged.
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
const JSZip = require('jszip');
let S;
before(async () => {
  const out = path.join(os.tmpdir(), `kea-office-scan-${process.pid}.cjs`);
  await require('esbuild').build({ entryPoints: [path.resolve(here, '../../src/lib/officeLossScan.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
  S = require(out);
  fs.rmSync(out, { force: true });
});

const zip = async (files) => {
  const z = new JSZip();
  for (const [p, s] of Object.entries(files)) z.file(p, s);
  return new Uint8Array(await z.generateAsync({ type: 'uint8array' }));
};
const body = (xml) => `<w:document xmlns:w="w"><w:body>${xml}</w:body></w:document>`;

test('Word: charts, text boxes and equations are named; plain text and pictures are not', async () => {
  assert.deepEqual(await S.officeLosses('a.docx', await zip({ 'word/document.xml': body('<w:p><w:r><w:t>Hi</w:t></w:r></w:p>') })), []);
  assert.deepEqual(await S.officeLosses('a.docx', await zip({ 'word/document.xml': body('<w:drawing><a:blip r:embed="rId4"/></w:drawing>') })), []);
  const rich = body('<w:drawing><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="x"/></a:graphicData></w:drawing><wps:wsp><wps:txbx><w:txbxContent/></wps:txbx></wps:wsp><m:oMath/>');
  assert.deepEqual(await S.officeLosses('a.docx', await zip({ 'word/document.xml': rich })), ['charts', 'text boxes', 'Word equations']);
});

test('Excel: pivot tables and charts; a workbook Kea wrote keeps its own charts', async () => {
  assert.deepEqual(await S.officeLosses('b.xlsx', await zip({ 'xl/workbook.xml': '<workbook/>', 'xl/pivotTables/pivotTable1.xml': '<x/>', 'xl/charts/chart1.xml': '<c/>' })), ['pivot tables', 'charts']);
  assert.deepEqual(await S.officeLosses('b.xlsx', await zip({ 'xl/workbook.xml': '<sheet name="_kea_data"/>', 'xl/media/image1.png': 'x', 'xl/charts/chart1.xml': '<c/>' })), []);
  assert.deepEqual(await S.officeLosses('b.xlsm', await zip({ 'xl/workbook.xml': '<workbook/>', 'xl/vbaProject.bin': 'x' })), ['macros']);
});

test('PowerPoint: tables, SmartArt and animations', async () => {
  const slide = '<p:sld><a:tbl></a:tbl><p:timing><p:tnLst><p:par></p:par></p:tnLst></p:timing></p:sld>';
  assert.deepEqual(await S.officeLosses('c.pptx', await zip({ 'ppt/slides/slide1.xml': slide, 'ppt/diagrams/data1.xml': '<d/>' })), ['SmartArt', 'tables', 'animations']);
  assert.deepEqual(await S.officeLosses('c.pptx', await zip({ 'ppt/slides/slide1.xml': '<p:sld/>' })), []);
});

test('not an Office file, or not a zip: nothing to say', async () => {
  assert.deepEqual(await S.officeLosses('d.csv', new Uint8Array([1, 2])), []);
  assert.deepEqual(await S.officeLosses('d.docx', new Uint8Array([1, 2, 3])), []);
  assert.equal(S.listWords(['charts', 'tables', 'macros']), 'charts, tables and macros');
});
