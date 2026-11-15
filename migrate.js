// One-time copy of the data of the old installed "Note" app (schema 1, closed notes as zips).
// Only reads the old folder: nothing in it is changed or deleted.
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { readJson } = require('./storage');
const { upgrade, cleanNote, deletedOf, newId } = require('./model');

// Returns { data, closed, skipped } or null when there is nothing to migrate.
function fromNote(oldDir, newDir) {
  const backups = path.join(oldDir, 'backups');
  const candidates = [path.join(oldDir, 'data.json'), path.join(oldDir, 'data.json.bak'),
    ...(fs.existsSync(backups) ? fs.readdirSync(backups).sort().reverse().map((f) => path.join(backups, f)) : [])];
  let raw = null;
  for (const f of candidates) if ((raw = readJson(f))) break;
  if (!raw) return null;
  const data = upgrade(raw);

  const tasks = path.join(newDir, 'tasks');
  fs.mkdirSync(tasks, { recursive: true });
  const keep = (name, write) => { // never overwrite a file that is already there
    try { write(path.join(tasks, name)); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  };
  const oldTasks = path.join(oldDir, 'tasks');
  if (fs.existsSync(oldTasks)) {
    for (const f of fs.readdirSync(oldTasks)) {
      const src = path.join(oldTasks, f);
      if (fs.statSync(src).isFile()) keep(f, (dst) => fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL));
    }
  }

  // closed notes: archive\*.zip (note.json + files\<task txt>) become History entries
  const archive = path.join(oldDir, 'archive');
  const zips = fs.existsSync(archive) ? fs.readdirSync(archive).filter((f) => f.endsWith('.zip')).sort() : [];
  const used = new Set(data.notes.map((n) => n.id));
  let closed = 0, skipped = 0;
  for (const name of zips) {
    try {
      const zip = new AdmZip(path.join(archive, name));
      const rawNote = JSON.parse(zip.readAsText('note.json'));
      const note = cleanNote(rawNote);
      if (!note) throw new Error('no note inside');
      if (used.has(note.id)) note.id = newId(); // the same note closed, reopened and closed again
      used.add(note.id);
      const deleted = deletedOf(rawNote, note);
      for (const t of [...note.tasks, ...deleted.map((e) => e.task)]) {
        const entry = t.file && zip.getEntry(`files/${t.file}`);
        if (entry) keep(t.file, (dst) => fs.writeFileSync(dst, entry.getData(), { flag: 'wx' }));
      }
      data.history.push({ id: newId(), kind: 'note', at: Date.parse(rawNote.archivedAt) || fs.statSync(path.join(archive, name)).mtimeMs, note }, ...deleted);
      closed++;
    } catch { skipped++; } // damaged zip: it stays in the old folder, the count is reported
  }
  return { data, closed, skipped };
}

module.exports = { fromNote };
