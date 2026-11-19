// Pictures in Teach lessons: the figure blocks a lesson can carry, and which Commons pictures may be shown.
// Run: node --test test/study/teachFigures.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { figuresOf, withoutBlocks } from '../../src/lib/teachFigures.ts';

const require = createRequire(import.meta.url);
require('../worker/electronStub.cjs');
const { _test } = require('../../electron/figures.cjs');

const LESSON = `## The heart

It pumps blood.

\`\`\`figure
{"search": "heart anterior view labeled diagram", "caption": "The four chambers", "parts": ["right atrium", " left ventricle ", 5, ""]}
\`\`\`

### Step 1: Blood in

Text.

\`\`\`check
[{"q":"x","choices":["a","b"],"answer":0}]
\`\`\``;

test('a lesson\'s figure blocks are read, cleaned and kept to two', () => {
  const f = figuresOf(LESSON);
  assert.equal(f.length, 1);
  assert.deepEqual(f[0], { search: 'heart anterior view labeled diagram', caption: 'The four chambers', parts: ['right atrium', 'left ventricle'] });
  const many = '```figure\n{"search":"aaa one"}\n```\n```figure\n{"search":"bbb two"}\n```\n```figure\n{"search":"ccc three"}\n```';
  assert.equal(figuresOf(many).length, 2);
});

test('a broken or empty figure block is ignored, never an error', () => {
  assert.deepEqual(figuresOf('```figure\nnot json\n```'), []);
  assert.deepEqual(figuresOf('```figure\n{"search":"x"}\n```'), []);
  assert.deepEqual(figuresOf('no figure here'), []);
});

test('the text shown has neither block, also while it is still being written', () => {
  const shown = withoutBlocks(LESSON);
  assert.ok(!shown.includes('figure') && !shown.includes('check'));
  assert.ok(shown.includes('## The heart') && shown.includes('### Step 1'));
  assert.ok(!withoutBlocks('Text\n```figure\n{"search": "hea').includes('hea'));
});

test('only open licenses qualify: attribution and share-alike yes; non-commercial, no-derivatives and unknown no', () => {
  for (const ok of ['CC BY 4.0', 'CC BY-SA 3.0', 'CC0 1.0', 'Public domain', 'PD-USGov']) assert.equal(_test.licenseOk(ok), true, ok);
  for (const no of ['CC BY-NC 4.0', 'CC BY-ND 2.0', 'CC BY-NC-SA 3.0', 'All rights reserved', '', undefined]) assert.equal(_test.licenseOk(no), false, String(no));
});

test('the best picture is an openly licensed, labeled one that matches; a closed one is never picked', () => {
  const page = (title, license, mime = 'image/png') => ({ title: `File:${title}`, imageinfo: [{ mime, url: 'u', thumburl: 't', extmetadata: { LicenseShortName: { value: license } } }] });
  const pages = {
    1: page('Heart photo.jpg', 'CC BY-NC 4.0', 'image/jpeg'),
    2: page('Heart anterior view.png', 'CC BY-SA 4.0'),
    3: page('Heart anterior view labeled diagram.svg', 'CC BY 4.0', 'image/svg+xml'),
    4: page('Heart video.ogv', 'CC BY 4.0', 'video/ogg')
  };
  const best = _test.pick(pages, 'heart anterior view labeled diagram');
  assert.equal(best.p.title, 'File:Heart anterior view labeled diagram.svg');
  assert.equal(_test.pick({ 1: pages[1], 4: pages[4] }, 'heart'), null);
});
