// Kea Scholar profiles ("School", "Personal"): each keeps its own classes, textbooks, scan engine and settings,
// in userData/profiles/<id>/. Profiles are local for now; a Kea server may sync them later.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const root = () => path.join(app.getPath('userData'), 'profiles');
const indexFile = () => path.join(root(), 'profiles.json');

function read() {
  try {
    const j = JSON.parse(fs.readFileSync(indexFile(), 'utf8'));
    if (Array.isArray(j.list) && j.list.length) return j;
  } catch {}
  return null;
}

function write(j) {
  fs.mkdirSync(root(), { recursive: true });
  fs.writeFileSync(indexFile(), JSON.stringify(j, null, 2));
}

/** The profile list, creating the first one ("School") the first time Scholar is used. */
function all() {
  let j = read();
  if (!j) {
    j = { active: 'school', list: [{ id: 'school', name: 'School', created: new Date().toISOString() }] };
    write(j);
  }
  if (!j.list.some((p) => p.id === j.active)) j.active = j.list[0].id;
  return j;
}

const active = () => all().active;

function create(name) {
  const j = all();
  const clean = String(name || '').trim().slice(0, 40) || 'Profile';
  let id = clean.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'profile';
  for (let n = 2; j.list.some((p) => p.id === id); n++) id = `${id.replace(/-\d+$/, '')}-${n}`;
  j.list.push({ id, name: clean, created: new Date().toISOString() });
  j.active = id;
  write(j);
  return j;
}

function select(id) {
  const j = all();
  if (j.list.some((p) => p.id === id)) j.active = id;
  write(j);
  return j;
}

function rename(id, name) {
  const j = all();
  const p = j.list.find((x) => x.id === id);
  if (p && String(name || '').trim()) p.name = String(name).trim().slice(0, 40);
  write(j);
  return j;
}

/** Where a profile's things live. */
function paths(id = active()) {
  const dir = path.join(root(), id);
  return {
    dir,
    /** The scan engine's workspace (its own copy of the engine, its database and downloads). */
    workspace: path.join(dir, 'scholar'),
    db: path.join(dir, 'scholar', 'data', 'academic_sync.db'),
    /** One folder per class with its study PDFs ("textbook" chapters). */
    textbooks: path.join(dir, 'textbooks'),
    /** Kea's own state for the profile: what's checked off, notes. The engine's database is never written by Kea. */
    state: path.join(dir, 'kea.json')
  };
}

module.exports = { all, active, create, select, rename, paths };
