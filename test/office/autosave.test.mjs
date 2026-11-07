// Autosave never does something destructive on its own (src/lib/autosavePolicy.ts, src/editors/pdf/autosaveHold.ts):
// a PDF with redactions, or page changes that would drop bookmarks or form fields, waits for Save; a held tab is not
// retried in a loop; a busy one is retried a few times, then left for the next edit.
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
let P, H;
before(async () => {
  const build = async (entry) => {
    const out = path.join(os.tmpdir(), `kea-office-${path.basename(entry)}-${process.pid}.cjs`);
    await require('esbuild').build({ entryPoints: [path.resolve(here, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
    const mod = require(out);
    fs.rmSync(out, { force: true });
    return mod;
  };
  P = await build('../../src/lib/autosavePolicy.ts');
  H = await build('../../src/editors/pdf/autosaveHold.ts');
});

const pages = (n) => Array.from({ length: n }, (_, i) => ({ src: 0, index: i }));

test('a PDF with a redaction box is never autosaved', () => {
  const base = { pages: pages(3), originalPageCount: 3, hasForm: false, hasOutline: false };
  assert.equal(H.pdfAutosaveHold({ ...base, annots: [{ type: 'highlight' }, { type: 'text' }] }), null, 'ordinary markup autosaves');
  assert.equal(H.pdfAutosaveHold({ ...base, annots: [{ type: 'redact' }] }), H.REDACT_HOLD);
});

test('page changes wait for Save only when they would drop bookmarks or form fields', () => {
  const swapped = [{ src: 0, index: 1 }, { src: 0, index: 0 }];
  const o = { annots: [], pages: swapped, originalPageCount: 2 };
  assert.equal(H.pdfAutosaveHold({ ...o, hasForm: false, hasOutline: false }), null, 'a plain PDF rebuilds safely');
  assert.equal(H.pdfAutosaveHold({ ...o, hasForm: true, hasOutline: false }), H.REBUILD_HOLD);
  assert.equal(H.pdfAutosaveHold({ ...o, hasForm: false, hasOutline: true }), H.REBUILD_HOLD);
  assert.equal(H.pdfAutosaveHold({ annots: [], pages: pages(2), originalPageCount: 2, hasForm: true, hasOutline: true }), null, 'untouched pages edit in place');
  assert.equal(H.pdfAutosaveHold({ annots: [], pages: pages(1), originalPageCount: 2, hasForm: true, hasOutline: false }), H.REBUILD_HOLD, 'a deleted page');
});

test('autosave stops instead of looping', () => {
  assert.equal(P.nextAutosaveStep({ held: false, saved: true, stillDirty: false, tries: 0 }), 'done');
  assert.equal(P.nextAutosaveStep({ held: true, saved: false, stillDirty: true, tries: 0 }), 'stop', 'held: wait for the user');
  assert.equal(P.nextAutosaveStep({ held: false, saved: false, stillDirty: true, tries: 0 }), 'retry', 'busy: try again');
  assert.equal(P.nextAutosaveStep({ held: false, saved: false, stillDirty: true, tries: P.AUTOSAVE_MAX_RETRIES }), 'stop', 'but not forever');
  assert.equal(P.nextAutosaveStep({ held: false, saved: false, stillDirty: false, tries: 3 }), 'done', 'saved some other way');
});
