// What the Claude panel sends each step, trimmed (Kea 0.107). Every step of a turn re-sends the whole conversation, so
// a full read of a paper, or a picture of it, sent once was paid for again on every later step and every later message.
// Quality first: nothing Claude needs right now is cut, and anything trimmed can be read again with the same tool.
//
// - Earlier turns (before the student's latest message): a long tool result becomes one line naming the tool and its
//   size; a picture a tool returned becomes a note; Claude's thinking is dropped (only the turn in progress needs it).
// - The turn in progress: a document read that a later read of the same thing replaced becomes one line.
// - The student's own words, Claude's answers, and pictures the student attached are never changed.
// The trim is the same for the same conversation, so the prompt cache still matches step to step within a turn.

type Block = { type: string; [k: string]: any };
type Msg = { role: 'user' | 'assistant'; content: string | Block[] };

/** Results longer than this (characters) are trimmed in earlier turns. */
export const KEEP_CHARS = 600;
/** Tools whose newer call replaces an older one's result in the same turn (a fresh read of the same thing). */
const REREADS = new Set(['read_document', 'read_range', 'read_project_file', 'read_outline', 'read_section']);

const textOf = (c: any): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b?.type === 'text' ? b.text : '')).join('\n') : '');
const hasImage = (c: any) => Array.isArray(c) && c.some((b) => b?.type === 'image');
const isToolResults = (m: Msg) => m.role === 'user' && Array.isArray(m.content) && m.content.length > 0 && m.content.every((b) => b.type === 'tool_result');

/** The index of the student's latest message (a user message that isn't only tool results), or -1. */
export function lastTurnStart(messages: Msg[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user' && !isToolResults(messages[i])) return i;
  return -1;
}

/** The trimmed copy to send (the stored conversation is never changed). */
export function compactHistory(messages: Msg[]): Msg[] {
  const start = lastTurnStart(messages);
  // tool_use id → [tool name, a key for "the same read"].
  const calls = new Map<string, { name: string; key: string }>();
  for (const m of messages)
    if (m.role === 'assistant' && Array.isArray(m.content))
      for (const b of m.content) if (b.type === 'tool_use') calls.set(b.id, { name: b.name, key: `${b.name}:${JSON.stringify(b.input ?? {})}` });
  // In the turn in progress: the last result for each read key (older ones of the same read are trimmed).
  const latest = new Map<string, string>();
  messages.forEach((m, i) => {
    if (i < start || !isToolResults(m)) return;
    for (const b of m.content as Block[]) {
      const c = calls.get(b.tool_use_id);
      if (c && REREADS.has(c.name)) latest.set(c.key, b.tool_use_id);
    }
  });
  const note = (name: string, chars: number, why: string) => `[${why}: the result of ${name} (${chars.toLocaleString('en-US')} characters) was here. Call ${name} again if you need it.]`;
  return messages.map((m, i) => {
    if (!Array.isArray(m.content)) return m;
    const earlier = start >= 0 && i < start;
    if (m.role === 'assistant') {
      if (!earlier) return m;
      const kept = m.content.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking');
      return kept.length === m.content.length ? m : { ...m, content: kept.length ? kept : [{ type: 'text', text: '(thinking)' }] };
    }
    if (!isToolResults(m)) return m;
    let changed = false;
    const content = m.content.map((b) => {
      const c = calls.get(b.tool_use_id);
      const name = c?.name || 'the tool';
      const text = textOf(b.content);
      if (earlier && (text.length > KEEP_CHARS || hasImage(b.content))) {
        changed = true;
        return { ...b, content: hasImage(b.content) && text.length <= KEEP_CHARS ? `[A picture from ${name} was here. Call ${name} again to see it now.]` : note(name, text.length, 'Trimmed to save space') };
      }
      if (!earlier && c && REREADS.has(c.name) && latest.get(c.key) !== b.tool_use_id && text.length > KEEP_CHARS) {
        changed = true;
        return { ...b, content: note(name, text.length, 'Replaced by a newer read below') };
      }
      return b;
    });
    return changed ? { ...m, content } : m;
  });
}

/** Characters a conversation sends (for tests and the benchmark: about 4 characters a token). */
export function sizeOf(messages: Msg[]): number {
  let n = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') n += m.content.length;
    else for (const b of m.content) n += b.type === 'image' ? 6000 : b.type === 'tool_result' ? (hasImage(b.content) ? 6000 : 0) + textOf(b.content).length : JSON.stringify(b).length;
  }
  return n;
}
