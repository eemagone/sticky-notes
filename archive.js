// Closed/deleted notes become a zip: note.json + files/<task txt files>. Zips are never removed.
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

let dir, tasksDir;
function init(archiveDir, taskDir) {
  dir = archiveDir;
  tasksDir = taskDir;
  fs.mkdirSync(dir, { recursive: true });
}

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;
const safeTitle = (t) => String(t || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim()
  .slice(0, 60).replace(/[. ]+$/, '') || 'Untitled';
const linked = (note) => [...note.tasks, ...(note.deleted || []).map((d) => d.task)].filter((t) => t.file);

// Writes the zip and verifies it before returning its name. Caller removes the note from live data only after this.
function archive(note, now = new Date()) {
  const base = `${safeTitle(note.title)}_${stamp(now)}`;
  let name = `${base}.zip`;
  for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${base} (${i}).zip`;

  const zip = new AdmZip();
  zip.addFile('note.json', Buffer.from(JSON.stringify({ ...note, archivedAt: now.toISOString() }, null, 2)));
  for (const t of linked(note)) {
    const p = path.join(tasksDir, t.file);
    if (fs.existsSync(p) && !zip.getEntry(`files/${t.file}`)) zip.addFile(`files/${t.file}`, fs.readFileSync(p));
  }
  const tmp = path.join(dir, `${name}.tmp`);
  fs.writeFileSync(tmp, zip.toBuffer());
  if (!new AdmZip(tmp).getEntry('note.json')) throw new Error('archive verification failed');
  fs.renameSync(tmp, path.join(dir, name));
  return name;
}

// Newest first: [{ zip, title, archivedAt }]
function list() {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.zip')).map((zip) => {
    try {
      const n = JSON.parse(new AdmZip(path.join(dir, zip)).readAsText('note.json'));
      return { zip, title: n.title || 'Untitled', archivedAt: n.archivedAt };
    } catch { return null; }
  }).filter(Boolean).sort((a, b) => (b.archivedAt || '').localeCompare(a.archivedAt || ''));
}

// Returns the note to put back into live data. taken(name) says if a filename is linked to a live task.
function restore(zipName, liveIds, taken, newId) {
  const zip = new AdmZip(path.join(dir, path.basename(zipName)));
  const note = JSON.parse(zip.readAsText('note.json'));
  delete note.archivedAt;
  if (liveIds.includes(note.id)) note.id = newId();
  note.deleted ||= [];

  for (const t of linked(note)) {
    const entry = zip.getEntry(`files/${t.file}`);
    if (!entry) continue; // never had content on disk; ">" will create it
    const data = entry.getData();
    const stem = t.file.replace(/\.txt$/i, '');
    // original name, then "(restored)", "(restored 2)", ... ; reuse a candidate only if identical and not someone else's
    for (let i = 1; ; i++) {
      const name = i === 1 ? t.file : `${stem} (restored${i > 2 ? ` ${i - 1}` : ''}).txt`;
      const p = path.join(tasksDir, name);
      if (!fs.existsSync(p)) { fs.writeFileSync(p, data, { flag: 'wx' }); t.file = name; break; }
      if (!taken(name) && fs.readFileSync(p).equals(data)) { t.file = name; break; }
    }
  }
  return note;
}

module.exports = { init, archive, list, restore, dir: () => dir };
