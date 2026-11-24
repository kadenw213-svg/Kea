// What Claude remembers about a context folder (Kea 0.104). Each folder keeps its own notes in `.kea-memory.md`, beside
// `.kea-project.json`: the person's preferences ("sign reminders as Kaden, keep them short"), the people and their
// roles, standing facts ("shifts are 6–2 and 2–10"), and how things are done here. Claude saves to it on its own with
// the remember tool when it learns something worth keeping, reads it at the start of every conversation about the
// folder, and keeps it tidy (forget). The person sees and edits every note in the folder's window (ContextFolder.tsx).
//
// It's plain Markdown so it can be read or fixed by hand. It never leaves this person's copy: shared folders skip
// `.kea-` files (electron/teamFoldersCore.cjs), so each person sharing a folder has their own notes.
import { api } from './api';
import { setting } from './settings';
import type { AssistantTool } from '../store';
import type { Project } from './projects';

export const MEMORY_FILE = '.kea-memory.md';
const MAX = 12_000; // characters: about 3k tokens, sent once per conversation

export const TOPICS = ['Preferences', 'People', 'Facts', 'How things are done'] as const;
export type Topic = (typeof TOPICS)[number];
const TOPIC_KEY: Record<string, Topic> = { preferences: 'Preferences', people: 'People', facts: 'Facts', how: 'How things are done' };

const sepOf = (p: string) => (p.includes('\\') ? '\\' : '/');
export const memoryPath = (dir: string) => `${dir.replace(/[\\/]+$/, '')}${sepOf(dir)}${MEMORY_FILE}`;
const on = () => setting('projects.memory') !== false;

export interface Note {
  topic: Topic;
  text: string;
}

/** The notes in a memory file, by topic (lines that aren't notes are kept as they are when it's written back). */
export function parseMemory(md: string): Note[] {
  const out: Note[] = [];
  let topic: Topic = 'Facts';
  for (const raw of md.split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(raw);
    if (h) {
      topic = (TOPICS.find((t) => t.toLowerCase() === h[1].toLowerCase()) as Topic) || 'Facts';
      continue;
    }
    const m = /^\s*[-*]\s+(.+?)\s*$/.exec(raw);
    if (m) out.push({ topic, text: m[1] });
  }
  return out;
}

/** The file's text for a list of notes. */
export function writeMemoryText(name: string, notes: Note[]): string {
  const parts = [`# What Claude remembers about ${name}`, '', 'Kea keeps this file for Claude. Edit or delete anything; Claude reads it at the start of each conversation about this folder.'];
  for (const t of TOPICS) {
    const list = notes.filter((n) => n.topic === t);
    if (list.length) parts.push('', `## ${t}`, ...list.map((n) => `- ${n.text}`));
  }
  return `${parts.join('\n')}\n`;
}

export async function readMemory(dir: string): Promise<string> {
  try {
    return new TextDecoder().decode((await api.readFile(memoryPath(dir))).data);
  } catch {
    return '';
  }
}
export async function readNotes(dir: string): Promise<Note[]> {
  return parseMemory(await readMemory(dir));
}
export async function saveNotes(p: Pick<Project, 'dir' | 'name'>, notes: Note[]) {
  await api.writeFile(memoryPath(p.dir), new TextEncoder().encode(writeMemoryText(p.name, notes)));
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * What goes to Claude at the start of a conversation about the folder (and again whenever the notes change), or ''
 * when there's nothing yet. `sig` tells the chat whether it has already been given these notes.
 */
export async function memoryForClaude(p: Pick<Project, 'dir' | 'name'>): Promise<{ text: string; sig: string }> {
  if (!on()) return { text: '', sig: '' };
  const notes = await readNotes(p.dir);
  if (!notes.length) return { text: '', sig: 'empty' };
  const body = TOPICS.map((t) => {
    const list = notes.filter((n) => n.topic === t);
    return list.length ? `${t}:\n${list.map((n) => `- ${n.text}`).join('\n')}` : '';
  })
    .filter(Boolean)
    .join('\n');
  return { text: `[What you remember about the folder "${p.name}" (your notes in ${MEMORY_FILE}): follow these preferences and use these facts without being told again. Keep them current with remember and forget.]\n${body}`, sig: sigOf(body) };
}
export const sigOf = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `${s.length}:${h}`;
};

/** Claude's tools for the folder's notes: remember (add or replace one) and forget. */
export function memoryTools(p: Project, onChange?: () => void): AssistantTool[] {
  if (!on()) return [];
  if (p.shared?.access === 'view') return [];
  return [
    {
      name: 'remember',
      description: `Save something worth knowing next time to this folder's notes ("${p.name}"), which you're given at the start of every conversation about it. Save on your own, without being asked, whenever you learn: a preference (tone, format, how they sign messages, what to always or never do), a person and their role or contact, a standing fact (hours, deadlines, rules, recurring tasks), or how something is done here; and when the person corrects you. One short self-contained sentence per note. To change a note, give \`replaces\` (part of the old note). Never save passwords, codes, money details or anything they asked you not to keep. Tell them in a few words what you saved.`,
      input_schema: {
        type: 'object',
        properties: {
          note: { type: 'string', description: 'e.g. "Sign reminder emails as Kaden, front desk lead; keep them under 80 words."' },
          topic: { type: 'string', enum: ['preferences', 'people', 'facts', 'how'] },
          replaces: { type: 'string', description: 'Part of an existing note this one updates (it is removed)' }
        },
        required: ['note', 'topic']
      },
      async run({ note, topic, replaces }) {
        const text = String(note || '').replace(/\s+/g, ' ').trim();
        if (!text) throw new Error('Give the note to save.');
        if (/\b(password|passcode|pin|ssn|social security|card number|routing number)\b/i.test(text)) throw new Error('That looks like something private (a password, code or account number). Notes never keep those.');
        let notes = await readNotes(p.dir);
        let replaced = '';
        if (replaces) {
          const r = norm(String(replaces));
          const hit = notes.find((n) => norm(n.text).includes(r));
          if (hit) {
            replaced = hit.text;
            notes = notes.filter((n) => n !== hit);
          }
        }
        if (notes.some((n) => norm(n.text) === norm(text))) return 'Already in the notes.';
        notes.push({ topic: TOPIC_KEY[String(topic)] || 'Facts', text });
        if (writeMemoryText(p.name, notes).length > MAX) throw new Error('The notes are full. Merge or forget old notes first (forget, or remember with replaces).');
        await saveNotes(p, notes);
        onChange?.();
        return replaced ? `Updated the note “${replaced}” to “${text}”.` : `Saved to ${p.name}’s notes: “${text}”.`;
      }
    },
    {
      name: 'forget',
      description: `Remove a note from this folder's notes when it's wrong, out of date, or the person asks you to forget it. \`note\`: part of the note's text.`,
      input_schema: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] },
      async run({ note }) {
        const r = norm(String(note || ''));
        if (!r) throw new Error('Say which note.');
        const notes = await readNotes(p.dir);
        const hits = notes.filter((n) => norm(n.text).includes(r));
        if (!hits.length) return 'No note matches that.';
        if (hits.length > 1) throw new Error(`That matches ${hits.length} notes: ${hits.map((n) => `“${n.text}”`).join(', ')}. Be more specific.`);
        await saveNotes(
          p,
          notes.filter((n) => n !== hits[0])
        );
        onChange?.();
        return `Forgot “${hits[0].text}”.`;
      }
    }
  ];
}
