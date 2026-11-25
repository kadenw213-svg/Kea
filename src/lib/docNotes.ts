// Working notes for one file (Kea 0.107): a short context file Claude keeps for a paper, sheet or deck, so a new
// conversation about it starts from what's already settled instead of re-reading and re-working everything. It holds
// what the assignment asks (condensed), the plan and outline, what's been decided, what's done and what's left, and
// the student's preferences for this piece of work. Kept on this PC per file (like drafts), under 3,000 characters.
// The student sees and edits them (the folder bar's menu → Notes on this file).
import { create } from 'zustand';
import type { AssistantTool } from '../store';
import { fileKey } from './assignmentContext';
import { setting } from './settings';

const KEY = 'kea.docNotes';
export const NOTES_MAX = 3000;

type Notes = Record<string, { text: string; at: number }>;
const load = (): Notes => {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}') || {};
  } catch {
    return {};
  }
};
export const useDocNotes = create<{ byFile: Notes }>(() => ({ byFile: load() }));
const save = () => {
  try {
    // (Unsaved files have no lasting key: their notes last as long as the tab.)
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(Object.entries(useDocNotes.getState().byFile).filter(([f]) => !f.startsWith('tab:')))));
  } catch {}
};

export const notesOf = (tabId: string) => useDocNotes.getState().byFile[fileKey(tabId)]?.text || '';
export function setNotes(tabId: string, text: string) {
  const k = fileKey(tabId);
  const clean = String(text || '').trim().slice(0, NOTES_MAX);
  useDocNotes.setState((s) => {
    const byFile = { ...s.byFile };
    if (clean) byFile[k] = { text: clean, at: Date.now() };
    else delete byFile[k];
    return { byFile };
  });
  save();
}
/** A short fingerprint, so a conversation is sent the notes again only after they change. */
export const notesSig = (text: string) => `${text.length}:${[...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)}`;

const SECRET = /\b(password|passcode|pin|ssn|social security|account number|routing number|card number|cvv)\b/i;

/** Claude's tool for the notes (none when turned off: Settings → Claude, assistant.docNotes). */
export function docNotesTools(tabId: string): AssistantTool[] {
  if (setting('assistant.docNotes') === false) return [];
  return [
    {
      name: 'update_file_notes',
      description:
        'Replace your working notes for this file (under 3,000 characters, plain Markdown). They are given to you at the start of every later conversation about this file, so you don’t have to re-read and re-work what is settled. Keep: what the assignment asks (condensed, with the rubric’s criteria), the plan or outline (part names, not text), decisions made with the student, what is done and what is left, and their preferences for this work. Never paste passages of the file itself, and never anything private (passwords, codes, account numbers). Update after something is settled, not every message.',
      input_schema: { type: 'object', properties: { notes: { type: 'string', description: 'The whole new notes (they replace the old ones)' } }, required: ['notes'] },
      run: ({ notes }: { notes: string }) => {
        const text = String(notes || '').trim();
        if (!text) throw new Error('Write the notes first (or leave them as they are).');
        if (SECRET.test(text)) throw new Error('Notes can’t hold passwords, codes or account numbers. Leave that out.');
        if (text.length > NOTES_MAX) throw new Error(`Too long (${text.length} characters): keep the notes under ${NOTES_MAX}. Condense them.`);
        setNotes(tabId, text);
        return 'Saved. They’ll be given to you in later conversations about this file.';
      }
    }
  ];
}
