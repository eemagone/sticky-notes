// One .txt per task, named after the task title. The link lives in the task itself:
//   task.file      = current filename in the tasks folder
//   task.fileTitle = the title the file was named after (differs from task.text => rename pending)
// A file is deleted only when its task is deleted permanently from History.
const fs = require('fs');
const path = require('path');
const { allTasks, safeName } = require('./model');

let dir;
const init = (d) => { dir = d; fs.mkdirSync(dir, { recursive: true }); };
const full = (name) => {
  if (!safeName(name)) throw new Error(`bad task file name: ${name}`);
  return path.join(dir, name);
};
const EOL = '\r\n';

const RESERVED = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i;
function baseName(title) {
  let s = String(title || '').replace(/[<>:"/\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim()
    .slice(0, 80).replace(/[\uD800-\uDBFF]$/, '').replace(/[. ]+$/, ''); // never cut an emoji in half
  if (!s) s = 'Untitled task';
  if (RESERVED.test(s.split('.')[0].trim())) s = `${s}_`; // "NUL.txt" and "nul.notes.txt" are both reserved
  return s;
}

// First free "Title.txt", "Title (2).txt", ... — free on disk and not linked to any other task.
function uniqueName(data, title, self) {
  const own = self.file?.toLowerCase();
  const linked = new Set(allTasks(data).filter((t) => t !== self && t.file).map((t) => t.file.toLowerCase()));
  const base = baseName(title);
  for (let i = 1; ; i++) {
    const name = i === 1 ? `${base}.txt` : `${base} (${i}).txt`;
    const lc = name.toLowerCase();
    if (lc === own || (!linked.has(lc) && !fs.existsSync(full(name)))) return name;
  }
}

// Rename the file to match a renamed task. On failure (file busy) keep the old name; retried later.
function tryRename(data, t) {
  if (!safeName(t.file) || t.fileTitle === t.text || !fs.existsSync(full(t.file))) return false;
  const name = uniqueName(data, t.text, t);
  try {
    if (name !== t.file) fs.renameSync(full(t.file), full(name));
  } catch {
    return false; // file is open somewhere: the old name keeps working and the rename is retried later
  }
  t.file = name; // the link follows the file right away, even if the header update below fails
  const oldTitle = t.fileTitle;
  t.fileTitle = t.text;
  try {
    const p = full(name);
    const body = fs.readFileSync(p, 'utf8');
    const first = body.match(/^[^\r\n]*/)[0];
    if (first === oldTitle) fs.writeFileSync(p, t.text + body.slice(first.length)); // only touch an untouched header
  } catch { /* the first line keeps the old title; the file and its link are fine */ }
  return true;
}

// Make sure the task has a file and return its path. Creates it with a header if missing.
function ensure(data, t) {
  fs.mkdirSync(dir, { recursive: true }); // the user may have deleted the folder
  if (t.file && !safeName(t.file)) t.file = null;
  tryRename(data, t);
  if (!t.file || !fs.existsSync(full(t.file))) {
    t.file = null;
    t.file = uniqueName(data, t.text, t);
    t.fileTitle = t.text;
    fs.writeFileSync(full(t.file), `${t.text || 'Untitled task'}${EOL}${EOL}`, { flag: 'wx' }); // wx: never overwrite
  }
  return full(t.file);
}

// Task ids whose file has something beyond the header line.
function hints(note) {
  return note.tasks.filter((t) => {
    if (!safeName(t.file)) return false;
    try {
      return fs.readFileSync(full(t.file), 'utf8').replace(/^[^\r\n]*/, '').trim() !== '';
    } catch { return false; }
  }).map((t) => t.id);
}

// Launch-time retry of renames that failed earlier (e.g. file was open). Returns true if anything changed.
const renamePending = (data) => data.notes.flatMap((n) => n.tasks).map((t) => tryRename(data, t)).some(Boolean);

// Delete the files of tasks that were deleted permanently. A file another task still links to is kept.
function remove(data, tasks) {
  const kept = new Set(allTasks(data).filter((t) => t.file).map((t) => t.file.toLowerCase()));
  for (const t of tasks) {
    if (safeName(t.file) && !kept.has(t.file.toLowerCase())) fs.rmSync(full(t.file), { force: true });
  }
}

module.exports = { init, ensure, hints, renamePending, remove, baseName, safeName, dir: () => dir };
