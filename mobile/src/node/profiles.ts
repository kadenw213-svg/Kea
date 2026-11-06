// Where study.cjs keeps things, on the phone: its study folder lives in the in-memory files (node/fs.ts).
const P = { dir: '/kea', workspace: '/kea/workspace', db: '/kea/classes.db', textbooks: '/kea/Textbooks', state: '/kea/kea.json' };
export const paths = () => P;
export const active = () => 'phone';
export const all = () => ({ list: [] as { id: string; name: string }[] });
export default { paths, active, all };
