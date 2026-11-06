import { DocMeta, defaultMeta, emptyHF } from './docMeta';
import { setting } from '../../lib/settings';

/** Ready-made documents. Each returns editor HTML plus document settings. */
export interface Template {
  id: string;
  name: string;
  group: 'School' | 'Work' | 'Personal';
  blurb: string;
  build(): { html: string; meta: DocMeta; fileName: string };
}

const nameParts = () => {
  const full = (setting<string>('user.name') || '').trim();
  const parts = full.split(/\s+/).filter(Boolean);
  return { full: full || 'Your Name', last: parts.length ? parts[parts.length - 1] : 'Lastname' };
};
const longDate = () => new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
const mlaDate = () => {
  const d = new Date();
  return `${d.getDate()} ${d.toLocaleDateString('en-US', { month: 'long' })} ${d.getFullYear()}`;
};

/** The usual school paper setup: Times New Roman 12, double spaced, 1" margins, indented paragraphs. */
const paperMeta = (over: Partial<DocMeta> = {}) =>
  defaultMeta({
    defaults: { font: 'Times New Roman', sizePt: 12, lineHeight: 2, spaceAfterPt: 0, firstLineIn: 0.5 },
    ...over
  });

const p = (text: string, opts: { center?: boolean; noIndent?: boolean; bold?: boolean } = {}) =>
  `<p${opts.noIndent || opts.center ? ' data-text-indent="0"' : ''}${opts.center ? ' style="text-align: center"' : ''}>${opts.bold ? `<strong>${text}</strong>` : text}</p>`;
const body = 'Start writing here. Press Enter for a new paragraph; the first line indents automatically.';

export const TEMPLATES: Template[] = [
  {
    id: 'mla',
    name: 'MLA essay',
    group: 'School',
    blurb: 'MLA 9: heading, title, header with your last name and page number, Works Cited.',
    build() {
      const { full, last } = nameParts();
      const meta = paperMeta({ header: { left: '', center: '', right: `${last} {PAGE}` }, citationStyle: 'mla' });
      const html =
        p(full, { noIndent: true }) +
        p('Instructor Name', { noIndent: true }) +
        p('Course Name', { noIndent: true }) +
        p(mlaDate(), { noIndent: true }) +
        p('Title of Your Essay', { center: true }) +
        p(body) +
        '<div data-type="page-break"></div><div data-bibliography data-title="Works Cited"></div>';
      return { html, meta, fileName: 'MLA essay' };
    }
  },
  {
    id: 'apa',
    name: 'APA paper',
    group: 'School',
    blurb: 'APA 7 student paper: title page, page numbers, References.',
    build() {
      const { full } = nameParts();
      const meta = paperMeta({ header: { left: '', center: '', right: '{PAGE}' }, citationStyle: 'apa' });
      const html =
        p('', { center: true }) +
        p('', { center: true }) +
        p('', { center: true }) +
        p('Title of Your Paper', { center: true, bold: true }) +
        p('', { center: true }) +
        p(full, { center: true }) +
        p('Department, University', { center: true }) +
        p('Course Number: Course Name', { center: true }) +
        p('Instructor Name', { center: true }) +
        p(longDate(), { center: true }) +
        '<div data-type="page-break"></div>' +
        p('Title of Your Paper', { center: true, bold: true }) +
        p(body) +
        '<div data-type="page-break"></div><div data-bibliography data-title="References"></div>';
      return { html, meta, fileName: 'APA paper' };
    }
  },
  {
    id: 'chicago',
    name: 'Chicago paper',
    group: 'School',
    blurb: 'Chicago author-date: title page, page numbers at the bottom, References.',
    build() {
      const { full } = nameParts();
      const meta = paperMeta({ footer: { left: '', center: '{PAGE}', right: '' }, firstFooter: emptyHF(), firstHeader: emptyHF(), citationStyle: 'chicago' });
      const html =
        p('', { center: true }) +
        p('', { center: true }) +
        p('', { center: true }) +
        p('Title of Your Paper', { center: true }) +
        p('', { center: true }) +
        p(full, { center: true }) +
        p('Course Name', { center: true }) +
        p(longDate(), { center: true }) +
        '<div data-type="page-break"></div>' +
        p(body) +
        '<div data-type="page-break"></div><div data-bibliography data-title="References"></div>';
      return { html, meta, fileName: 'Chicago paper' };
    }
  },
  {
    id: 'lab',
    name: 'Lab report',
    group: 'School',
    blurb: 'Purpose, hypothesis, materials, procedure, results and conclusion.',
    build() {
      const { full } = nameParts();
      const meta = defaultMeta({ footer: { left: full, center: '', right: 'Page {PAGE} of {PAGES}' } });
      const sec = (h: string, t: string) => `<h2>${h}</h2><p>${t}</p>`;
      const html =
        `<h1>Lab Report Title</h1><p>${full} · Lab partners: · ${longDate()}</p>` +
        sec('Purpose', 'What question is this experiment answering?') +
        sec('Hypothesis', 'If …, then …, because …') +
        `<h2>Materials</h2><ul><li><p>Item</p></li><li><p>Item</p></li></ul>` +
        `<h2>Procedure</h2><ol><li><p>Step</p></li><li><p>Step</p></li></ol>` +
        `<h2>Data</h2><table><tbody><tr><th><p>Trial</p></th><th><p>Measurement</p></th><th><p>Notes</p></th></tr><tr><td><p>1</p></td><td><p></p></td><td><p></p></td></tr><tr><td><p>2</p></td><td><p></p></td><td><p></p></td></tr></tbody></table>` +
        sec('Analysis', 'What do the results show? Include calculations and sources of error.') +
        sec('Conclusion', 'Was the hypothesis supported? What would you change next time?');
      return { html, meta, fileName: 'Lab report' };
    }
  },
  {
    id: 'outline',
    name: 'Essay outline',
    group: 'School',
    blurb: 'Thesis, body paragraphs with evidence, and conclusion.',
    build() {
      const html =
        '<h1>Essay Outline</h1><h2>Thesis</h2><p>One sentence that states your argument.</p>' +
        [1, 2, 3].map((n) => `<h2>Body paragraph ${n}</h2><ul><li><p>Topic sentence:</p></li><li><p>Evidence:</p></li><li><p>Analysis:</p></li></ul>`).join('') +
        '<h2>Conclusion</h2><ul><li><p>Restate thesis:</p></li><li><p>Why it matters:</p></li></ul>';
      return { html, meta: defaultMeta(), fileName: 'Essay outline' };
    }
  },
  {
    id: 'resume',
    name: 'Resume',
    group: 'Work',
    blurb: 'Clean one-page resume with experience, education and skills.',
    build() {
      const { full } = nameParts();
      const meta = defaultMeta({
        page: { ...defaultMeta().page, margins: { top: 0.7, right: 0.75, bottom: 0.7, left: 0.75 } },
        defaults: { font: 'Calibri', sizePt: 11, lineHeight: 1.08, spaceAfterPt: 2, firstLineIn: 0 }
      });
      const job = (title: string) => `<p><strong>${title}</strong> · Company, City · 2023 – Present</p><ul><li><p>What you did and the result, with a number if you can.</p></li><li><p>Another accomplishment.</p></li></ul>`;
      const html =
        `<h1 style="text-align: center">${full}</h1><p style="text-align: center">email@example.com · (555) 555-5555 · City, State · linkedin.com/in/you</p>` +
        `<h2>Experience</h2>${job('Job Title')}${job('Job Title')}` +
        `<h2>Education</h2><p><strong>School Name</strong> · Degree or Diploma · Year</p>` +
        `<h2>Skills</h2><p>Skill · Skill · Skill · Skill</p>`;
      return { html, meta, fileName: 'Resume' };
    }
  },
  {
    id: 'cover',
    name: 'Cover letter',
    group: 'Work',
    blurb: 'Business-letter cover letter.',
    build() {
      const { full } = nameParts();
      const meta = defaultMeta({ defaults: { font: 'Calibri', sizePt: 11, lineHeight: 1.08, spaceAfterPt: 8, firstLineIn: 0 } });
      const html =
        `<p>${full}<br>email@example.com · (555) 555-5555</p><p>${longDate()}</p><p>Hiring Manager<br>Company Name<br>Address</p>` +
        `<p>Dear Hiring Manager,</p><p>Opening: the role you're applying for and why you're excited about it.</p><p>Middle: one or two examples that show you can do the job.</p><p>Closing: thank them and say you'd welcome the chance to talk.</p><p>Sincerely,</p><p>${full}</p>`;
      return { html, meta, fileName: 'Cover letter' };
    }
  },
  {
    id: 'meeting',
    name: 'Meeting notes',
    group: 'Work',
    blurb: 'Agenda, notes and a checklist of action items.',
    build() {
      const html = `<h1>Meeting Notes</h1><p><strong>Date:</strong> ${longDate()}</p><p><strong>Attendees:</strong> </p><h2>Agenda</h2><ol><li><p></p></li></ol><h2>Notes</h2><p></p><h2>Action items</h2><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Who · what · when</p></li></ul>`;
      return { html, meta: defaultMeta(), fileName: 'Meeting notes' };
    }
  },
  {
    id: 'letter',
    name: 'Letter',
    group: 'Personal',
    blurb: 'A simple personal letter.',
    build() {
      const { full } = nameParts();
      const html = `<p>${longDate()}</p><p>Dear ,</p><p></p><p>Best wishes,</p><p>${full}</p>`;
      return { html, meta: defaultMeta({ defaults: { font: 'Georgia', sizePt: 12, lineHeight: 1.3, spaceAfterPt: 10, firstLineIn: 0 } }), fileName: 'Letter' };
    }
  },
  {
    id: 'journal',
    name: 'Journal entry',
    group: 'Personal',
    blurb: 'Dated entry with prompts.',
    build() {
      const html = `<h1>${longDate()}</h1><h3>Today I…</h3><p></p><h3>I'm grateful for…</h3><p></p><h3>Tomorrow I want to…</h3><p></p>`;
      return { html, meta: defaultMeta({ defaults: { font: 'Georgia', sizePt: 12, lineHeight: 1.4, spaceAfterPt: 8, firstLineIn: 0 } }), fileName: 'Journal' };
    }
  }
];

/** Encode a template as HTML bytes (with its settings embedded) so it opens like any file. */
export function templateBytes(t: Template): { name: string; data: Uint8Array } {
  const { html, meta, fileName } = t.build();
  const embedded = btoa(unescape(encodeURIComponent(JSON.stringify(meta))));
  return { name: `${fileName}.docx`, data: new TextEncoder().encode(`<!doctype html><html><head><meta name="kea-doc" content="${embedded}"></head><body>${html}</body></html>`) };
}
