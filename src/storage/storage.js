// One JSON file. Writes are atomic (temp file, then rename), the previous save is kept as .bak,
// and the backups folder holds the last 5 automatic backups (one per day, plus one before each import).
const fs = require('fs');
const path = require('path');
const { empty, upgrade } = require('../models/model');

const KEEP = 5;
let file, bdir, onFail = () => {}, timer = null, failing = false;

function init(dir, failHandler) {
  file = path.join(dir, 'data.json');
  bdir = path.join(dir, 'backups');
  if (failHandler) onFail = failHandler;
  fs.mkdirSync(bdir, { recursive: true });
}

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

// null = missing or not note data. Throws if the file exists but stays unreadable (locked).
function readJson(f) {
  let text;
  try { text = retry(() => fs.readFileSync(f, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  try {
    const d = JSON.parse(text.replace(/^﻿/, '')); // editors may add a BOM
    return d && Array.isArray(d.notes) ? d : null;
  } catch { return null; }
}
// copyFileSync carries the read-only attribute over, which would block every later save/rotation
function copy(src, dst) {
  try { fs.chmodSync(dst, 0o666); } catch { /* not there yet */ }
  fs.copyFileSync(src, dst);
  fs.chmodSync(dst, 0o666);
}
const backups = () => fs.readdirSync(bdir).filter((f) => /^data-.*\.json$/.test(f)).sort().reverse(); // newest first
const rotate = () => backups().slice(KEEP).forEach((f) => fs.unlinkSync(path.join(bdir, f)));
const exists = () => fs.existsSync(file) || fs.existsSync(`${file}.bak`);

// Returns { data, recovered?: backup name, lost?: true }. Never silently starts empty.
// Throws if data.json exists but cannot be read at all, or was written by a newer app:
// better to not start than to overwrite it.
function load() {
  const main = readJson(file);
  if (main) return { data: upgrade(main) };
  const had = fs.existsSync(file);
  if (had) try { fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* keeping a copy is best effort */ }
  for (const b of [`${file}.bak`, ...backups().map((f) => path.join(bdir, f))]) {
    try {
      const d = readJson(b);
      if (d) return { data: upgrade(d), recovered: path.basename(b) };
    } catch { /* unreadable backup: try the next one */ }
  }
  return had ? { data: empty(), lost: true } : { data: empty() };
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
    if (!failing) onFail(e); // tell the user once per failure streak
    failing = true;
    timer = setTimeout(() => writeNow(data), 3000); // keeps flush() meaningful too
    return false;
  }
  failing = false;
  try { // the daily backup is extra safety; its failure does not make the save a failed save
    const day = path.join(bdir, `data-${new Date().toLocaleDateString('sv')}.json`); // sv = YYYY-MM-DD
    if (!fs.existsSync(day)) {
      copy(file, day);
      rotate();
    }
  } catch { /* tried again on the next save */ }
  return true;
}

// A named backup of what is on disk right now, taken before a risky step. Throws if it cannot be made.
function backup(label) {
  if (!fs.existsSync(file)) return null;
  const name = `data-${new Date().toLocaleString('sv').replace(/[: ]/g, '-')}-${label}.json`;
  copy(file, path.join(bdir, name));
  rotate();
  return name;
}

const save = (data) => { clearTimeout(timer); timer = setTimeout(() => writeNow(data), 300); };
const flush = (data) => { if (timer) writeNow(data); };

module.exports = { init, exists, load, save, flush, writeNow, backup, readJson };
