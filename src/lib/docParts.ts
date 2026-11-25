// A long document read in parts (read_document, Kea 0.107): its outline and parts, by heading.
export const PART_CHARS = 5_000; // with no headings, a part is about this long
export const words = (s: string) => (s.match(/\S+/g) || []).length;
/** The document's parts: a new part at each heading (sections labelled "Paragraph N" are body text), or every ~5,000 characters. */
export function partsOf(sections: { label: string; text: string }[]): { title: string; text: string }[] {
  const out: { title: string; text: string }[] = [];
  for (const s of sections) {
    const heading = !/^Paragraph \d+$/.test(s.label);
    const cur = out[out.length - 1];
    if (!cur || heading || cur.text.length >= PART_CHARS) out.push({ title: heading ? s.label : `${s.text.slice(0, 50).trim()}…`, text: s.text });
    else cur.text += `\n\n${s.text}`;
  }
  return out;
}
