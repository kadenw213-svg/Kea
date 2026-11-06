// The phone's study code (study.cjs over the in-memory files) run on a real copy of the data: node mobile/test/run.cjs
import { loadStudy, studyOut, study, askPC, phoneRequests } from '../src/study';
import { createHash } from '../src/node/crypto';

declare const process: any;
declare const require: any;
const fsReal = require('fs');
const pathReal = require('path');

const ok = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(`FAILED: ${msg}`);
  console.log(`ok - ${msg}`);
};

(globalThis as any).localStorage = (() => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k) };
})();

async function main() {
  // sha1 the same as Node's
  const nodeSha = require('crypto').createHash('sha1').update('Ünïcode question — 5.1 ×10³').digest('hex');
  ok(createHash('sha1').update('Ünïcode question — 5.1 ×10³').digest('hex') === nodeSha, 'sha1 matches Node');

  const [dataFile, studyDir] = process.argv.slice(2);
  const data = JSON.parse(fsReal.readFileSync(dataFile, 'utf8'));
  const files: Record<string, any> = {};
  const walk = (d: string, rel: string) => {
    for (const e of fsReal.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name !== 'images') walk(pathReal.join(d, e.name), `${rel}${e.name}/`);
      } else if (e.name.endsWith('.json')) files[`${rel}${e.name}`] = JSON.parse(fsReal.readFileSync(pathReal.join(d, e.name), 'utf8'));
    }
  };
  walk(studyDir, '');
  data.study = files;
  loadStudy(data);

  const list = study.list();
  ok(list.length > 10, `lists the PC's sets (${list.length})`);
  const bank = list.find((s: any) => s.bank && s.status === 'ready' && s.kind === 'exam');
  ok(bank, `has a question bank (${bank?.title})`);
  const full = study.get(bank.id);
  ok(full?.questions?.length > 0, `opens a set (${full.questions.length} questions)`);
  const pool = study.pool(bank.courseId, bank.chapters);
  ok(pool.length > 0, `pool for its chapters (${pool.length})`);
  const saved = await study.saved({ kind: 'exam', courseId: bank.courseId, chapters: bank.chapters });
  ok(saved.count > 0, `saved count (${saved.count})`);
  const made = await study.request({ kind: 'exam', courseId: bank.courseId, chapters: bank.chapters, count: 10, mode: 'saved' });
  ok(made.ready && made.id, `practice exam from saved questions (${made.id})`);
  const set = study.get(made.id);
  ok(set.questions.length === 10, 'it has 10 questions');
  study.saveAttempt(made.id, { score: 7, total: 10, n: 10, items: set.questions.map((q: any, i: number) => [q.k, i % 3 !== 0]) });
  study.star(set.questions[0].k, true);
  const q = await study.reviewQueue({ courseId: bank.courseId, limit: 50 });
  ok(Array.isArray(q.due) && Array.isArray(q.fresh), `review queue (${q.due.length} due, ${q.fresh.length} new)`);
  await study.reviewMark(set.questions[1].k, 'good', { courseId: bank.courseId, chapter: bank.chapters[0] });

  const out = studyOut();
  ok(out['attempts.json'][made.id]?.length === 1, 'the attempt goes back to the PC');
  ok(out['stars.json'][set.questions[0].k] === true && out['stars-log.json'][set.questions[0].k]?.on === true, 'the star goes back, with its time');
  ok(out['review.json'][set.questions[1].k]?.box >= 1, 'the review mark goes back');
  ok(out.made.some((m: any) => m.entry.id === made.id && m.set.questions.length === 10), 'the set made here goes back with its questions');

  // A new copy from the PC (without the phone's changes yet): the phone's progress stays.
  loadStudy(data);
  const again = studyOut();
  ok(again['attempts.json'][made.id]?.length === 1, 'progress kept across a new copy from the PC');
  ok(study.get(made.id)?.questions?.length === 10, 'the set made here is kept until the PC has it');

  // The PC has it now: the phone stops sending it.
  const withIt = JSON.parse(JSON.stringify(data));
  withIt.study['index.json'] = [...withIt.study['index.json'], { ...out.made[0].entry }];
  withIt.study[`sets/${made.id}.json`] = out.made[0].set;
  withIt.study['attempts.json'] = { ...withIt.study['attempts.json'], [made.id]: out['attempts.json'][made.id] };
  loadStudy(withIt);
  const after = studyOut();
  ok(!after.made.length, 'the set the PC has is no longer sent');
  ok(after['attempts.json'][made.id]?.length === 1, 'and its attempt is not doubled');

  askPC('practice', { req: { kind: 'exam', courseId: bank.courseId, chapters: bank.chapters, count: 25, mode: 'new', id: 'exam-test' } });
  ok(phoneRequests().length === 1, 'a request for new questions is queued for the PC');
  console.log('all passed');
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
