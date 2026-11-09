// Claude's document edits in the background (src/editors/doc/claudeEdits.ts): the person's selection stays where it
// was (mapped through Claude's change), Claude's "here" maps through the person's own typing, one undo reverts one
// Claude change, and what Claude changed is highlighted briefly.
//   node --test test/office/claudeEdits.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { history, undo, closeHistory } from '@tiptap/pm/history';
import { claudeEditsPlugin, claudeEditsKey, setAnchorTr, anchorOf, changedRanges, userBusy } from '../../src/editors/doc/claudeEdits.ts';

const schema = new Schema({
  nodes: { doc: { content: 'paragraph+' }, paragraph: { content: 'text*', toDOM: () => ['p', 0] }, text: {} },
  marks: { strong: { toDOM: () => ['strong', 0] } }
});
const p = (t) => schema.node('paragraph', null, t ? [schema.text(t)] : []);

/** A tiny editor: state + dispatch, with Claude's flag. */
function editor(paras, opts = {}) {
  let claude = 0;
  let clock = opts.clock ?? 1000;
  let state = EditorState.create({
    doc: schema.node('doc', null, paras.map(p)),
    plugins: [history({ newGroupDelay: 500 }), claudeEditsPlugin({ active: () => claude > 0, now: () => clock })]
  });
  const ed = {
    get state() {
      return state;
    },
    dispatch(tr) {
      state = state.apply(tr);
    },
    /** As Claude's tool code: transactions dispatched inside are Claude's. */
    claude(fn) {
      claude++;
      try {
        fn(ed);
      } finally {
        claude--;
      }
    },
    tick(ms) {
      clock += ms;
    },
    text: () => state.doc.textBetween(0, state.doc.content.size, '|'),
    undo: () => undo(state, (tr) => (state = state.apply(tr)))
  };
  return ed;
}
/** Position of the character index `i` in paragraph `n` (0-based). */
const at = (ed, n, i) => {
  let pos = 0;
  for (let k = 0; k < n; k++) pos += ed.state.doc.child(k).nodeSize;
  return pos + 1 + i;
};
const type = (ed, s) => ed.dispatch(ed.state.tr.insertText(s).setTime(Date.now()));

test('Claude inserting earlier in the document leaves the person’s cursor on the same text', () => {
  const ed = editor(['First paragraph.', 'I am typing here.']);
  const cursor = at(ed, 1, 5); // after "I am "
  ed.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, cursor)));
  ed.claude((e) => e.dispatch(e.state.tr.insertText(' Claude added this.', at(e, 0, 16))));
  assert.equal(ed.text(), 'First paragraph. Claude added this.|I am typing here.');
  const sel = ed.state.selection;
  assert.ok(sel.empty);
  assert.equal(ed.state.doc.textBetween(sel.from - 5, sel.from), 'I am ');
  // What they type next goes where they were typing.
  type(ed, 'still ');
  assert.equal(ed.text(), 'First paragraph. Claude added this.|I am still typing here.');
});

test('Claude moving the selection to work (format a passage) never shows: the person’s selection comes back', () => {
  const ed = editor(['Bold this phrase please.', 'My selection is here.']);
  const sel = TextSelection.create(ed.state.doc, at(ed, 1, 3), at(ed, 1, 12)); // "selection"
  ed.dispatch(ed.state.tr.setSelection(sel));
  ed.claude((e) => {
    const tr = e.state.tr.setSelection(TextSelection.create(e.state.doc, at(e, 0, 0), at(e, 0, 4)));
    tr.addMark(at(e, 0, 0), at(e, 0, 4), schema.marks.strong.create());
    e.dispatch(tr);
  });
  const s = ed.state.selection;
  assert.equal(ed.state.doc.textBetween(s.from, s.to), 'selection');
  assert.ok(ed.state.doc.child(0).child(0).marks.some((m) => m.type.name === 'strong'));
});

test('a cursor right where Claude inserts stays before the new text', () => {
  const ed = editor(['Hello world']);
  const c = at(ed, 0, 5);
  ed.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, c)));
  ed.claude((e) => e.dispatch(e.state.tr.insertText(', Claude', c)));
  assert.equal(ed.text(), 'Hello, Claude world');
  assert.equal(ed.state.selection.from, c);
});

test('a selected range doesn’t grow to take in text Claude inserts at its edges', () => {
  const ed = editor(['abc def ghi']);
  ed.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, at(ed, 0, 4), at(ed, 0, 7)))); // "def"
  ed.claude((e) => {
    const tr = e.state.tr.insertText('X', at(e, 0, 7));
    tr.insertText('Y', at(e, 0, 4));
    e.dispatch(tr);
  });
  const s = ed.state.selection;
  assert.equal(ed.state.doc.textBetween(s.from, s.to), 'def');
});

test('Claude’s “here” maps through what the person typed after asking', () => {
  const ed = editor(['Intro.', 'Put it after this.', 'End.']);
  // They ask with the cursor at the end of paragraph 2…
  ed.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, at(ed, 1, 18))));
  ed.dispatch(setAnchorTr(ed.state, { from: ed.state.selection.from, to: ed.state.selection.to }));
  // …then click into the first paragraph and keep typing while Claude works.
  ed.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, at(ed, 0, 6))));
  type(ed, ' More intro text.');
  const here = anchorOf(ed.state);
  assert.equal(ed.state.doc.textBetween(here.from - 5, here.from), 'this.');
  ed.claude((e) => e.dispatch(e.state.tr.insertText(' Claude.', here.from)));
  assert.equal(ed.text(), 'Intro. More intro text.|Put it after this. Claude.|End.');
  // The person's cursor is still at the end of their own typing.
  assert.equal(ed.state.doc.textBetween(ed.state.selection.from - 5, ed.state.selection.from), 'text.');
});

test('one undo reverts one Claude change; typing right after it is its own step', () => {
  const ed = editor(['One two three.']);
  ed.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, at(ed, 0, 14))));
  type(ed, ' Four.');
  ed.claude((e) => e.dispatch(e.state.tr.insertText('Zero. ', at(e, 0, 0))));
  type(ed, ' Five.'); // straight after Claude's change: must not merge into it
  assert.equal(ed.text(), 'Zero. One two three. Four. Five.');
  ed.undo();
  assert.equal(ed.text(), 'Zero. One two three. Four.');
  ed.undo();
  assert.equal(ed.text(), 'One two three. Four.');
});

test('the person’s typing just before Claude’s change isn’t undone with it', () => {
  const ed = editor(['Text.']);
  ed.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, at(ed, 0, 5))));
  type(ed, ' Mine.');
  ed.claude((e) => {
    // (The app closes the history before each of Claude's tool calls: beginStep.)
    e.dispatch(closeHistory(e.state.tr));
    e.dispatch(e.state.tr.insertText(' Claude.', at(e, 0, 11)));
  });
  assert.equal(ed.text(), 'Text. Mine. Claude.');
  ed.undo();
  assert.equal(ed.text(), 'Text. Mine.');
});

test('what Claude changed is highlighted, mapped through later edits, and not what the person types', () => {
  const ed = editor(['Hello world']);
  ed.claude((e) => e.dispatch(e.state.tr.insertText('big ', at(e, 0, 6))));
  let deco = claudeEditsKey.getState(ed.state).deco.find();
  assert.equal(deco.length, 1);
  assert.equal(ed.state.doc.textBetween(deco[0].from, deco[0].to), 'big ');
  ed.dispatch(ed.state.tr.insertText('Oh, ', at(ed, 0, 0)));
  deco = claudeEditsKey.getState(ed.state).deco.find();
  assert.equal(deco.length, 1);
  assert.equal(ed.state.doc.textBetween(deco[0].from, deco[0].to), 'big ');
});

test('changed ranges cover replacements and mark changes, merged', () => {
  const ed = editor(['aaaa bbbb cccc']);
  const tr = ed.state.tr.insertText('XX', at(ed, 0, 5), at(ed, 0, 9));
  tr.addMark(at(ed, 0, 0), at(ed, 0, 4), schema.marks.strong.create());
  const ranges = changedRanges([tr]);
  assert.deepEqual(ranges.map((r) => tr.doc.textBetween(r.from, r.to)), ['aaaa', 'XX']);
});

test('only the person’s own typing counts as them being busy', () => {
  const ed = editor(['Hi'], { clock: 10_000 });
  ed.claude((e) => e.dispatch(e.state.tr.insertText('!', at(e, 0, 2))));
  assert.equal(userBusy(ed.state, 4000, 10_500), false);
  type(ed, 'x');
  assert.equal(userBusy(ed.state, 4000, 10_500), true);
  assert.equal(userBusy(ed.state, 4000, 20_000), false);
});
