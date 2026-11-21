// A throwaway Kea profile with sample content, for looking at every screen (design work and screenshots). Never point
// it at a real profile.
//
//   node scripts/design-fixture.cjs <empty folder>
//   then: set KEA_USERDATA=<that folder> and run Kea (node_modules\electron\dist\electron.exe .), with KEA_CAPTURE etc.
//
// It writes: settings (set up, School on, nothing synced), a School profile with two classes, their chapters, a week of
// assignments, lectures and a test, grades, and a ready practice set of questions for the study stream.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const out = path.resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('Say which (empty) folder to write the sample profile into.');
if (fs.existsSync(path.join(out, 'settings.json')) && !fs.existsSync(path.join(out, '.kea-design-fixture'))) throw new Error('That folder already has a Kea profile in it. Use an empty folder.');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, '.kea-design-fixture'), 'A sample profile made by scripts/design-fixture.cjs.\n');

const extra = process.argv[3] ? JSON.parse(process.argv[3]) : {};
fs.writeFileSync(
  path.join(out, 'settings.json'),
  JSON.stringify({ 'scholar.cloud': 'off', 'scholar.pcSync': false, 'sync.migrated': true, 'app.storageMoved': true, 'areas.setupDone': true, 'areas.documents': true, 'scholar.enabled': true, 'modes.school': true, 'modes.asked': true, 'session.tabs': [], ...extra }, null, 2)
);

const day = (n) => {
  const d = new Date(Date.now() + n * 864e5);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const SCHEMA = `
CREATE TABLE courses (id TEXT PRIMARY KEY, course_code TEXT, name TEXT, term TEXT, instructor TEXT, instructor_contact TEXT, campus TEXT, delivery_format TEXT, d2l_url TEXT, start_date TEXT, end_date TEXT, status TEXT, is_synthetic INTEGER, d2l_identifier TEXT);
CREATE TABLE chapter_topics (course_id TEXT, chapter_label TEXT, title TEXT, summary TEXT, sections_json TEXT, objectives_json TEXT, added_objectives_json TEXT, vocabulary TEXT, added_vocabulary TEXT, reading_url TEXT, reading_label TEXT, depth_verdict TEXT, depth_note TEXT);
CREATE TABLE study_pdfs (course_id TEXT, chapters_json TEXT, source_path TEXT, file_path TEXT, page_count INTEGER, week_start TEXT);
CREATE TABLE academic_items (id TEXT PRIMARY KEY, course_id TEXT, item_type TEXT, title TEXT, date TEXT, date_range_end TEXT, start_time TEXT, end_time TEXT, due_time TEXT, status TEXT, description TEXT, source_wording TEXT, platform_location TEXT, location TEXT, instructor TEXT, points REAL, optional INTEGER, tentative INTEGER, module TEXT, covered_chapters_json TEXT, study_focus_json TEXT, weekly_links_json TEXT, submission_url TEXT, submission_url_label TEXT, reference_url TEXT, reference_url_label TEXT, resource_url TEXT, resource_url_label TEXT);
CREATE TABLE course_portal_links (course_id TEXT, kind TEXT, label TEXT, url TEXT);
CREATE TABLE digest_entries (course_id TEXT, kind TEXT, external_id TEXT, payload_json TEXT, first_seen TEXT);
CREATE TABLE course_grade_snapshots (course_id TEXT, overall_percent REAL, letter_grade TEXT, captured_at TEXT);
CREATE TABLE grade_snapshots (course_id TEXT, title TEXT, is_missing INTEGER);
`;

(async () => {
  const S = await require('sql.js')();
  const d = new S.Database();
  d.run(SCHEMA);
  const ins = (table, row) => d.run(`INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`, Object.values(row));
  const classes = [
    { id: 'bio', code: 'BIO 111', name: 'General Biology I', who: 'Dr. Rivera', chapters: [['Chapter 3', 'Cell structure'], ['Chapter 4', 'Membranes and transport'], ['Chapter 5', 'Cellular respiration']] },
    { id: 'his', code: 'HIST 201', name: 'Modern World History', who: 'Prof. Chen', chapters: [['Unit 1', 'Industrial revolutions'], ['Unit 2', 'Empires and resistance']] }
  ];
  for (const c of classes) {
    ins('courses', { id: c.id, course_code: c.code, name: c.name, term: 'Fall 2026', instructor: c.who, status: 'active', is_synthetic: 0, start_date: day(-80), end_date: day(30) });
    for (const [label, title] of c.chapters) ins('chapter_topics', { course_id: c.id, chapter_label: label, title, summary: `${title}: the main ideas, terms and examples.`, sections_json: JSON.stringify([{ title: 'Overview' }, { title: 'Key terms' }]) });
    ins('course_grade_snapshots', { course_id: c.id, overall_percent: c.id === 'bio' ? 91.4 : 86.2, letter_grade: c.id === 'bio' ? 'A-' : 'B', captured_at: new Date().toISOString() });
  }
  const items = [
    ['b1', 'bio', 'assignment', 'Lab report: osmosis in potato cells', 1, '23:59'],
    ['b2', 'bio', 'lecture', 'Lecture: the mitochondrion', 0, null, '09:00', '10:15'],
    ['b3', 'bio', 'quiz', 'Quiz 4: membranes', 3, '11:00'],
    ['b4', 'bio', 'exam', 'Midterm 2 (chapters 3 to 5)', 9, '09:00'],
    ['h1', 'his', 'assignment', 'Primary source analysis: factory testimony', 2, '23:59'],
    ['h2', 'his', 'discussion', 'Discussion: who benefited from industrialisation?', 4, '23:59'],
    ['h3', 'his', 'reading', 'Read Unit 2, sections 1 and 2', 5, null]
  ];
  for (const [id, cid, type, title, n, due, st, et] of items) ins('academic_items', { id, course_id: cid, item_type: type, title, date: day(n), due_time: due, start_time: st || null, end_time: et || null, status: 'active', points: type === 'exam' ? 100 : 20, description: 'Sample item for screenshots.' });
  ins('grade_snapshots', { course_id: 'his', title: 'Map quiz', is_missing: 0 });

  const prof = path.join(out, 'profiles');
  const dbFile = path.join(prof, 'school', 'scholar', 'data', 'academic_sync.db');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  fs.writeFileSync(dbFile, Buffer.from(d.export()));
  d.close();
  fs.writeFileSync(path.join(prof, 'profiles.json'), JSON.stringify({ active: 'school', list: [{ id: 'school', name: 'School', created: new Date().toISOString() }] }));

  // A ready practice set (Biology, chapters 3 to 5): what the study stream asks.
  const q = (chapter, section, text, choices, answer, explain, wrong) => ({ type: 'mc', chapter, section, q: text, choices, answer, explain, wrong });
  const questions = [
    q('Chapter 3', 'Organelles', 'Which organelle makes most of a cell’s ATP?', ['Ribosome', 'Mitochondrion', 'Golgi apparatus', 'Lysosome'], 1, 'Mitochondria carry out the later stages of cellular respiration, where most ATP is made by oxidative phosphorylation across the inner membrane. Ribosomes make proteins, the Golgi packages them, and lysosomes break things down.', ['Ribosomes make proteins, not ATP.', '', 'The Golgi sorts and ships proteins.', 'Lysosomes digest worn-out parts.']),
    q('Chapter 4', 'Osmosis', 'A red blood cell is placed in a hypertonic solution. What happens?', ['It swells and may burst', 'It shrinks as water leaves it', 'Nothing changes', 'Salt moves into the cell until it bursts'], 1, 'In a hypertonic solution the water concentration is lower outside the cell, so water moves out by osmosis and the cell shrinks (crenation).', ['That happens in a hypotonic solution.', '', 'Only in an isotonic solution.', 'Water moves, not mainly the salt.']),
    q('Chapter 4', 'Transport', 'Which kind of transport needs energy from ATP?', ['Simple diffusion', 'Facilitated diffusion', 'Active transport', 'Osmosis'], 2, 'Active transport moves substances against their concentration gradient, which takes energy, usually from ATP (like the sodium-potassium pump). The others move substances down their gradient without spending ATP.', ['Down the gradient, no energy.', 'Uses a protein, but no energy.', '', 'Water down its gradient, no energy.']),
    q('Chapter 5', 'Glycolysis', 'Where in the cell does glycolysis happen?', ['Mitochondrial matrix', 'Cytoplasm', 'Nucleus', 'Inner mitochondrial membrane'], 1, 'Glycolysis splits glucose into two pyruvate molecules in the cytoplasm, before anything enters the mitochondrion.', ['The Krebs cycle happens there.', '', 'DNA is kept there; no respiration.', 'The electron transport chain is there.'])
  ];
  const study = path.join(prof, 'school', 'study');
  fs.mkdirSync(path.join(study, 'sets'), { recursive: true });
  fs.writeFileSync(path.join(study, 'index.json'), JSON.stringify([{ id: 'set-bio-1', kind: 'exam', courseId: 'bio', courseCode: 'BIO 111', title: 'BIO 111 practice', chapters: ['Chapter 3', 'Chapter 4', 'Chapter 5'], status: 'ready', count: questions.length, createdAt: new Date().toISOString(), source: 'class' }]));
  fs.writeFileSync(path.join(study, 'sets', 'set-bio-1.json'), JSON.stringify({ questions }));
  fs.writeFileSync(path.join(prof, 'school', 'kea.json'), JSON.stringify({ done: {} }));
  console.log(`Sample profile written to ${out} (${crypto.randomBytes(2).toString('hex')})`);
})();
