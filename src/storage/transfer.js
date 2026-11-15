// Export / import: one .zip with data.json and the task .txt files (tasks/<name>.txt).
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { upgrade, counts, safeName, allTasks } = require('../models/model');

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
//   merge:   notes, tasks and history items that are not here yet are added; nothing that is here changes.
//            A task that was deleted or closed here stays that way.
// A .txt file that already exists with other text is never overwritten: the imported one is saved as "name (imported).txt".
function apply(current, backup, mode, tasksDir) {
  const incoming = structuredClone(backup.data);
  let data, added;
  const count = { notes: 0, tasks: 0, history: 0 };
  if (mode === 'replace') {
    data = incoming;
    added = allTasks(incoming);
  } else {
    data = structuredClone(current);
    added = [];
    const closedHere = new Set(current.history.filter((e) => e.kind === 'note').map((e) => e.note.id));
    const knownTasks = new Set(allTasks(current).map((t) => t.id));
    const entryIds = new Set(current.history.map((e) => e.id));
    for (const n of incoming.notes) {
      const here = data.notes.find((m) => m.id === n.id);
      if (here) { // the same note on both sides: its tasks that are new here are added at the end
        const extra = n.tasks.filter((t) => !knownTasks.has(t.id));
        here.tasks.push(...extra);
        added.push(...extra);
        count.tasks += extra.length;
      } else if (!closedHere.has(n.id)) {
        data.notes.push(n);
        added.push(...n.tasks);
        count.notes++;
      }
    }
    const liveIds = new Set(data.notes.map((n) => n.id));
    for (const e of incoming.history) {
      if (entryIds.has(e.id) || (e.kind === 'note' ? liveIds.has(e.note.id) || closedHere.has(e.note.id) : knownTasks.has(e.task.id))) continue;
      data.history.push(e);
      added.push(...(e.kind === 'note' ? e.note.tasks : [e.task]));
      count.history++;
    }
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
  return { data, added: count };
}

// One zip of every task .txt per day, newest 5 kept: data.json has its own backups, these files had none.
// Returns the new zip's name, or null if today's already exists or there is nothing to back up.
function backupTasks(tasksDir, backupsDir, keep = 5) {
  const name = `tasks-${new Date().toLocaleDateString('sv')}.zip`;
  const files = fs.existsSync(tasksDir) ? fs.readdirSync(tasksDir).filter((f) => safeName(f) && fs.statSync(path.join(tasksDir, f)).isFile()) : [];
  if (!files.length || fs.existsSync(path.join(backupsDir, name))) return null;
  const zip = new AdmZip();
  for (const f of files) zip.addFile(f, fs.readFileSync(path.join(tasksDir, f)));
  fs.mkdirSync(backupsDir, { recursive: true });
  zip.writeZip(path.join(backupsDir, `${name}.tmp`));
  fs.renameSync(path.join(backupsDir, `${name}.tmp`), path.join(backupsDir, name));
  fs.readdirSync(backupsDir).filter((f) => /^tasks-.*\.zip$/.test(f)).sort().reverse().slice(keep).forEach((f) => fs.unlinkSync(path.join(backupsDir, f)));
  return name;
}

module.exports = { exportTo, read, apply, backupTasks };
