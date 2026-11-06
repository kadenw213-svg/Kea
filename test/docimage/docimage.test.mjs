// The document editor's pictures (src/editors/doc/extensions.ts): only data:, blob: and https pictures are taken in or
// written out, never a file on this PC or a network share (\\server\share), which printing would otherwise load.
//   node --test test/docimage/
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
let X, schema;
before(async () => {
  const out = path.join(os.tmpdir(), `kea-docimage-${process.pid}.cjs`);
  await require('esbuild').build({
    stdin: {
      contents: [
        "export { safeImageSrc, ResizableImage } from './src/editors/doc/extensions.ts';",
        "export { getSchema } from '@tiptap/core';",
        "export { default as Document } from '@tiptap/extension-document';",
        "export { default as Paragraph } from '@tiptap/extension-paragraph';",
        "export { default as Text } from '@tiptap/extension-text';"
      ].join('\n'),
      resolveDir: root,
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: out,
    logLevel: 'silent'
  });
  X = require(out);
  schema = X.getSchema([X.Document, X.Paragraph, X.Text, X.ResizableImage]);
  fs.rmSync(out, { force: true });
});

const el = (src) => ({ getAttribute: (k) => (k === 'src' ? src : null), style: {}, hasAttribute: (k) => k === 'src' });
const BAD = ['file:///C:/Users/me/secret.png', 'FILE://server/share/x.png', '\\\\server\\share\\x.png', '//server/share/x.png', 'http://example.com/x.png', 'javascript:alert(1)', 'C:\\x.png', 'kea-media://x', 'https:\\\\server\\x', ''];
const GOOD = ['data:image/png;base64,iVBORw0KGgo=', 'blob:app://kea/1234', 'https://example.com/x.png'];

test('safeImageSrc: data:, blob: and https only', () => {
  for (const s of BAD) assert.equal(X.safeImageSrc(s), false, s);
  for (const s of GOOD) assert.equal(X.safeImageSrc(s), true, s);
  assert.equal(X.safeImageSrc(null), false);
});

test('opening or pasting HTML: a picture from a file or network share isn’t taken in', () => {
  const rule = schema.nodes.image.spec.parseDOM.find((r) => r.tag && r.tag.startsWith('img'));
  for (const s of BAD) assert.equal(rule.getAttrs(el(s)), false, s);
  for (const s of GOOD) assert.equal(rule.getAttrs(el(s)).src, s, s);
});

test('writing out: an unsafe src set any other way (a command, a saved document) is left off', () => {
  const toDOM = schema.nodes.image.spec.toDOM;
  for (const s of BAD) {
    const [tag, attrs] = toDOM(schema.nodes.image.create({ src: s }));
    assert.equal(tag, 'img');
    assert.equal(attrs.src, undefined, s);
  }
  assert.equal(toDOM(schema.nodes.image.create({ src: GOOD[0] }))[1].src, GOOD[0]);
});
