// Single JSON file, atomic writes, .bak of the previous version, one daily backup kept for 7 days.
const fs = require('fs');
const path = require('path');

let file, bdir, timer = null;

function init(dir) {
  file = path.join(dir, 'data.json');
  bdir = path.join(dir, 'backups');
  fs.mkdirSync(bdir, { recursive: true });
}

const empty = () => ({ version: 1, notes: [], settings: { autoStart: true } });

function readJson(f) {
  try {
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    return d && Array.isArray(d.notes) ? d : null;
  } catch { return null; }
}

// Returns { data, recovered?: backup name, lost?: true }. Never silently starts empty.
function load() {
  const main = readJson(file);
  if (main) return { data: main };
  const exists = fs.existsSync(file);
  if (exists) fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`);
  const dailies = fs.readdirSync(bdir).filter((f) => /^data-.*\.json$/.test(f)).sort().reverse();
  for (const b of [`${file}.bak`, ...dailies.map((f) => path.join(bdir, f))]) {
    const d = readJson(b);
    if (d) return { data: d, recovered: path.basename(b) };
  }
  return exists ? { data: empty(), lost: true } : { data: empty() };
}

function writeNow(data) {
  clearTimeout(timer);
  timer = null;
  try {
    const tmp = `${file}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, JSON.stringify(data, null, 2));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
    fs.renameSync(tmp, file);
    const day = path.join(bdir, `data-${new Date().toLocaleDateString('sv')}.json`); // sv = YYYY-MM-DD
    if (!fs.existsSync(day)) {
      fs.copyFileSync(file, day);
      fs.readdirSync(bdir).filter((f) => /^data-.*\.json$/.test(f)).sort().reverse().slice(7)
        .forEach((f) => fs.unlinkSync(path.join(bdir, f)));
    }
  } catch (e) {
    console.error('save failed, will retry on next change', e);
  }
}

const save = (data) => { clearTimeout(timer); timer = setTimeout(() => writeNow(data), 300); };
const flush = (data) => { if (timer) writeNow(data); };

module.exports = { init, load, save, flush, writeNow };
