// Every kind of study id opens its own screen (src/components/scholar/studyIds.ts): a local Study button never opens
// Kea Hub practice, and a Kea Hub set never opens the local Study page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { studyRoute, studyPageId, hubSetId } from '../../src/components/scholar/studyIds.ts';

test('each kind of study id has its own route', () => {
  const scope = { courseId: 'c1', code: 'BIO111', title: 'Study', chapters: ['Chapter 8'], selected: [] };
  const page = studyRoute(studyPageId(scope));
  assert.equal(page.kind, 'page');
  assert.deepEqual(JSON.parse(decodeURIComponent(page.scope)), scope);
  assert.deepEqual(studyRoute(hubSetId('set-42')), { kind: 'hubSet', setId: 'set-42' });
  assert.deepEqual(studyRoute('readings:c1'), { kind: 'readings', courseId: 'c1' });
  for (const id of ['exam-abc', 'cards-x#learn', 'stream:%7B%7D', 'saved:all', 'review:all', 'edit:new']) assert.equal(studyRoute(id).kind, 'player', id);
});

test('a set id that happens to start like another prefix is still routed by its exact prefix', () => {
  assert.equal(studyRoute('hub:' + encodeURIComponent('{"courseId":"hubset:1"}')).kind, 'page');
  assert.equal(studyRoute('hubset:hub:1').kind, 'hubSet');
});
