// How long until an assignment is due, as the Claude tab shows it under the assignment ("Due in 3 days").

/** Whole calendar days from today to a date ("2026-11-24"): 0 is today, negative is past. */
export function daysUntil(date: string, now = new Date()): number {
  const [y, m, d] = date.split('-').map(Number);
  const due = Date.UTC(y, m - 1, d);
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((due - today) / 864e5);
}

export function dueText(days: number): string {
  if (days === 0) return 'Due today';
  if (days === 1) return 'Due tomorrow';
  if (days > 1) return `Due in ${days} days`;
  return days === -1 ? 'Was due yesterday' : `Was due ${-days} days ago`;
}
