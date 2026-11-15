// Export / import: one .zip with data.json and the task .txt files (tasks/<name>.txt).
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { upgrade, counts, safeName, allTasks } = require('./model');

function exportTo(dest, data, tasksDir) {
  const zip = new AdmZip();
  zip.addFile('data.json', Buffer.from(JSON.stringify(data, null, 2)));
  for (const f of fs.existsSync(tasksDir) ? fs.readdirSync(tasksDir) : []) {
    const p = path.join(tasksDir, f);
    if (safeName(f) && fs.statSync(p).isFile()) zip.addFile(`tasks/${f}`, fs.readFileSync(p));
  }
  const tmp = `${dest}.tmp`;
  zip.writeZip(tmp);
  read(tmp); // a backup that cannot be read back is not a backup
  fs.renameSync(tmp, dest);
  return counts(data);
}

// Checks a backup file and returns what is in it. Changes nothing. Throws an Error whose message can be shown as is.
function read(src) {
  const bad = (why) => new Error(`This file is not a Sticky Notes backup (${why}).`);
  let zip, entry;
  try {
    zip = new AdmZip(src);
    entry = zip.getEntry('data.json');
  } catch { throw bad('it is not a .zip file, or it is damaged'); }
  if (!entry) throw bad('there is no data.json inside');
  let raw;
  try { raw = JSON.parse(zip.readAsText(entry).replace(/^﻿/, '')); } catch { throw bad('its data.json cannot be read'); }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.notes)) throw bad('its data.json has no notes list');
  let data;
  try { data = upgrade(raw); } catch (e) {
    throw e.code === 'NEWER_SCHEMA' ? new Error('This backup was made by a newer version of Sticky Notes. Update the app, then import it again.') : bad('its data.json cannot be used');
  }
  const files = new Map();
  for (const e of zip.getEntries()) {
    const name = e.entryName.startsWith('tasks/') ? e.entryName.slice(6) : null;
    if (name && !e.isDirectory && safeName(name)) files.set(name, e.getData()); // "tasks/../x" never leaves the tasks folder
  }
  return { data, files, counts: counts(data) };
}

// Builds the data after an import and writes the backup's .txt files. `current` is not modified.
//   replace: the result is the backup.
//   merge:   notes and history items that are not here yet are added; nothing that is here changes.
// A .txt file that already exists with other text is never overwritten: the imported one is saved as "name (imported).txt".
function apply(current, backup, mode, tasksDir) {
  const incoming = structuredClone(backup.data);
  let data, added;
  if (mode === 'replace') {
    data = incoming;
    added = allTasks(incoming);
  } else {
    const noteIds = new Set([...current.notes.map((n) => n.id), ...current.history.filter((e) => e.kind === 'note').map((e) => e.note.id)]);
    const entryIds = new Set(current.history.map((e) => e.id));
    const notes = incoming.notes.filter((n) => !noteIds.has(n.id));
    const history = incoming.history.filter((e) => !entryIds.has(e.id) && !(e.kind === 'note' && noteIds.has(e.note.id)));
    data = { ...structuredClone(current), notes: [...structuredClone(current.notes), ...notes], history: [...structuredClone(current.history), ...history] };
    added = allTasks({ notes, history });
  }

  fs.mkdirSync(tasksDir, { recursive: true });
  const same = (p, buf) => fs.existsSync(p) && fs.readFileSync(p).equals(buf);
  for (const [name, buf] of backup.files) {
    const owners = added.filter((t) => t.file === name);
    const stem = name.replace(/\.txt$/i, '');
    // original name, then "(imported)", "(imported 2)", ... : the first that is free or already holds the same text
    for (let i = 1; ; i++) {
      const candidate = i === 1 ? name : `${stem} (imported${i > 2 ? ` ${i - 1}` : ''}).txt`;
      const p = path.join(tasksDir, candidate);
      if (!fs.existsSync(p)) fs.writeFileSync(p, buf, { flag: 'wx' });
      else if (!same(p, buf) && owners.length) continue;
      if (same(p, buf)) owners.forEach((t) => { t.file = candidate; });
      break;
    }
  }
  return { data, added: { notes: data.notes.length - (mode === 'replace' ? 0 : current.notes.length), history: data.history.length - (mode === 'replace' ? 0 : current.history.length) } };
}

module.exports = { exportTo, read, apply };
