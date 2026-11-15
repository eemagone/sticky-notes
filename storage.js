// Single JSON file, atomic writes, .bak of the previous version, one daily backup kept for 7 days.
const fs = require('fs');
const path = require('path');

let file, bdir, onFail = () => {}, timer = null, failing = false;

function init(dir, failHandler) {
  file = path.join(dir, 'data.json');
  bdir = path.join(dir, 'backups');
  if (failHandler) onFail = failHandler;
  fs.mkdirSync(bdir, { recursive: true });
}

const empty = () => ({ version: 1, notes: [], settings: { autoStart: true } });
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Antivirus / OneDrive / backup tools hold files for a moment: retry IO errors briefly.
function retry(fn, tries = 5) {
  for (let i = 1; ; i++) {
    try { return fn(); } catch (e) {
      if (e.code === 'ENOENT' || i >= tries) throw e;
      sleep(100 * i);
    }
  }
}

// null = missing or not valid note data. Throws if the file exists but stays unreadable (locked).
function readJson(f) {
  let text;
  try { text = retry(() => fs.readFileSync(f, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  try {
    const d = JSON.parse(text.replace(/^\uFEFF/, '')); // editors may add a BOM
    return d && Array.isArray(d.notes) ? d : null;
  } catch { return null; }
}
// copyFileSync carries the read-only attribute over, which would block every later save/rotation
function copy(src, dst) {
  try { fs.chmodSync(dst, 0o666); } catch { /* not there yet */ }
  fs.copyFileSync(src, dst);
  fs.chmodSync(dst, 0o666);
}
const tryReadJson = (f) => { try { return readJson(f); } catch { return null; } };

// Returns { data, recovered?: backup name, lost?: true }. Never silently starts empty.
// Throws if data.json exists but cannot be read at all: better to not start than to overwrite it.
function load() {
  const main = readJson(file);
  if (main) return { data: main };
  const exists = fs.existsSync(file);
  if (exists) try { fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* keeping a copy is best effort */ }
  const dailies = fs.readdirSync(bdir).filter((f) => /^data-.*\.json$/.test(f)).sort().reverse();
  for (const b of [`${file}.bak`, ...dailies.map((f) => path.join(bdir, f))]) {
    const d = tryReadJson(b);
    if (d) return { data: d, recovered: path.basename(b) };
  }
  return exists ? { data: empty(), lost: true } : { data: empty() };
}

// Returns true if the data reached disk. On failure it retries on its own every few seconds.
function writeNow(data) {
  clearTimeout(timer);
  timer = null;
  try {
    const tmp = `${file}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(data, null, 2));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    if (fs.existsSync(file)) retry(() => copy(file, `${file}.bak`));
    retry(() => fs.renameSync(tmp, file));
  } catch (e) {
    console.error('save failed, retrying', e);
    if (!failing) onFail(e); // tell the user once per failure streak
    failing = true;
    timer = setTimeout(() => writeNow(data), 3000); // keeps flush() meaningful too
    return false;
  }
  failing = false;
  try { // the daily backup is extra safety; its failure must not count as a failed save
    const day = path.join(bdir, `data-${new Date().toLocaleDateString('sv')}.json`); // sv = YYYY-MM-DD
    if (!fs.existsSync(day)) {
      copy(file, day);
      fs.readdirSync(bdir).filter((f) => /^data-.*\.json$/.test(f)).sort().reverse().slice(7)
        .forEach((f) => fs.unlinkSync(path.join(bdir, f)));
    }
  } catch (e) { console.error('daily backup failed', e); }
  return true;
}

const save = (data) => { clearTimeout(timer); timer = setTimeout(() => writeNow(data), 300); };
const flush = (data) => { if (timer) writeNow(data); };

module.exports = { init, load, save, flush, writeNow };
