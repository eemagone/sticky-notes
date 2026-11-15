// The shape of data.json, and the only code that repairs or upgrades it.
//   { schema_version, notes: [note], history: [entry], settings }
//   note  = { id, title, color, pinned, bounds, tasks: [task] }
//   task  = { id, text, done, pri (0 high, 1 medium, 2 low), doneAt?, file?, fileTitle? }
//   entry = { id, kind: 'task', at, noteId, noteTitle, index, task }   a deleted task
//         | { id, kind: 'note', at, note }                             a closed note
const path = require('path');

const SCHEMA = 2;
const PALETTE = [
  { name: 'Yellow', hex: '#fff3a8' },
  { name: 'Pink', hex: '#ffd3df' },
  { name: 'Mint', hex: '#cdf3dc' },
  { name: 'Sky', hex: '#d1e6ff' },
  { name: 'Lavender', hex: '#e3d9ff' },
  { name: 'Peach', hex: '#ffddc2' },
  { name: 'Lime', hex: '#e6f4c0' },
  { name: 'Aqua', hex: '#c9f0ee' },
];

let seq = 0;
const newId = () => Date.now().toString(36) + (seq++).toString(36) + Math.random().toString(36).slice(2, 6);
const str = (v) => (typeof v === 'string' ? v : '');
// A plain filename only: a crafted name like "../x.txt" must never leave the tasks folder.
const safeName = (name) => typeof name === 'string' && name === path.basename(name) && !/^\.\.?$/.test(name);
// spellcheck is off by default (it underlines every word that is not in the Windows language); hotkeys are on.
const cleanSettings = (s, keepAutoStart = true) => {
  const out = { autoStart: keepAutoStart && !!s?.autoStart, spellcheck: !!s?.spellcheck, hotkeys: s?.hotkeys !== false };
  const l = s?.launcher;
  if (Number.isFinite(l?.x) && Number.isFinite(l?.y)) {
    out.launcher = { x: l.x, y: l.y };
    if (l.width > 0 && l.height > 0) Object.assign(out.launcher, { width: Math.round(l.width), height: Math.round(l.height) });
  }
  return out;
};
const empty = () => ({ schema_version: SCHEMA, notes: [], history: [], settings: cleanSettings() });

// The clean* functions accept anything (old files, hand-edited files, the note window) and
// return a well-formed copy, or null when there is nothing to keep.
function cleanTask(t) {
  if (!t || typeof t !== 'object') return null;
  const out = { id: str(t.id) || newId(), text: str(t.text), done: !!t.done, pri: [0, 1, 2].includes(t.pri) ? t.pri : 2 };
  if (out.done) out.doneAt = +t.doneAt || Date.now();
  if (safeName(t.file)) {
    out.file = t.file;
    if (typeof t.fileTitle === 'string') out.fileTitle = t.fileTitle;
  }
  return out;
}
const cleanTasks = (list) => (Array.isArray(list) ? list.map(cleanTask).filter(Boolean) : []);

function cleanNote(n) {
  if (!n || typeof n !== 'object') return null;
  const b = n.bounds && typeof n.bounds === 'object' && +n.bounds.width > 0 && +n.bounds.height > 0 ? n.bounds : null;
  const bounds = b ? { width: Math.round(b.width), height: Math.round(b.height) } : { width: 300, height: 360 };
  if (b && Number.isFinite(b.x) && Number.isFinite(b.y)) Object.assign(bounds, { x: Math.round(b.x), y: Math.round(b.y) });
  return {
    id: str(n.id) || newId(),
    title: str(n.title),
    color: PALETTE.some((c) => c.hex === n.color) ? n.color : PALETTE[0].hex,
    pinned: !!n.pinned,
    bounds,
    tasks: cleanTasks(n.tasks),
  };
}

const makeNote = ({ title = '', color, width = 300, height = 360 } = {}) => cleanNote({ id: newId(), title, color, bounds: { width, height } });

function cleanEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const base = { id: str(e.id) || newId(), at: +e.at || Date.now() };
  if (e.kind === 'note') {
    const note = cleanNote(e.note);
    return note && { ...base, kind: 'note', note };
  }
  const task = cleanTask(e.task);
  return task && { ...base, kind: 'task', noteId: str(e.noteId), noteTitle: str(e.noteTitle), index: Math.max(0, Math.round(+e.index) || 0), task };
}

// Schema 1 kept deleted tasks inside each note: turn them into history entries.
function deletedOf(rawNote, note) {
  return (Array.isArray(rawNote?.deleted) ? rawNote.deleted : [])
    .map((d) => cleanEntry({ kind: 'task', at: d?.at, noteId: note.id, noteTitle: note.title, index: d?.index, task: d?.task }))
    .filter(Boolean);
}

// Any older or hand-edited file in, current-schema data out. Throws NEWER_SCHEMA for a file from a newer app.
function upgrade(d) {
  const version = +(d.schema_version ?? d.version ?? 1) || 1;
  if (version > SCHEMA) throw Object.assign(new Error(`data file has schema ${version}, this app reads up to ${SCHEMA}`), { code: 'NEWER_SCHEMA' });
  const notes = [];
  const history = (Array.isArray(d.history) ? d.history : []).map(cleanEntry).filter(Boolean);
  for (const raw of Array.isArray(d.notes) ? d.notes : []) {
    const note = cleanNote(raw);
    if (!note) continue;
    notes.push(note);
    history.push(...deletedOf(raw, note));
  }
  const settings = cleanSettings(d.settings, version >= 2); // schema 1 was the old installed app; its auto-start is not ours
  return { schema_version: SCHEMA, notes, history, settings };
}

// Every task that may own a .txt file: on open notes, deleted, and inside closed notes.
const allTasks = (data) => [
  ...data.notes.flatMap((n) => n.tasks),
  ...(data.history || []).flatMap((e) => (e.kind === 'note' ? e.note.tasks : [e.task])),
];

const counts = (data) => ({
  notes: data.notes.length,
  tasks: data.notes.reduce((n, note) => n + note.tasks.length, 0),
  history: data.history.length,
});

module.exports = { SCHEMA, PALETTE, newId, safeName, empty, cleanTask, cleanTasks, cleanNote, makeNote, cleanEntry, deletedOf, upgrade, allTasks, counts };
