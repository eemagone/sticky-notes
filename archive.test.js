// node archive.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const archive = require('./archive');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'note-arch-'));
const tasks = path.join(root, 'tasks');
fs.mkdirSync(tasks);
archive.init(path.join(root, 'archive'), tasks);
const put = (n, s) => fs.writeFileSync(path.join(tasks, n), s);
const get = (n) => fs.readFileSync(path.join(tasks, n), 'utf8');

put('A.txt', 'A\r\n\r\nalpha');
put('B.txt', 'B\r\n\r\nbeta');
put('C.txt', 'C\r\n\r\ngone');
const note = {
  id: 'n1', title: 'Shop: <today>', color: '#fff3a8', pinned: true, bounds: { x: 1, y: 2, width: 300, height: 360 },
  tasks: [{ id: 'a', text: 'A', done: true, pri: 0, file: 'A.txt' }, { id: 'b', text: 'B', done: false, pri: 1, file: 'B.txt' }],
  deleted: [{ task: { id: 'c', text: 'C', done: false, pri: 2, file: 'C.txt' }, index: 2, at: 1 }],
};

const when = new Date(2026, 9, 6, 14, 32);
const z1 = archive.archive(note, when);
const z2 = archive.archive({ ...note, title: '' }, when);
const z3 = archive.archive(note, when);
assert.deepStrictEqual([z1, z2, z3], ['Shop today_2026-10-06_14-32.zip', 'Untitled_2026-10-06_14-32.zip', 'Shop today_2026-10-06_14-32 (2).zip']);
assert.strictEqual(archive.list().length, 3);

// A missing -> restored as-is; B identical -> linked; C changed -> "(restored)" copy, user's file untouched
fs.unlinkSync(path.join(tasks, 'A.txt'));
put('C.txt', 'C\r\n\r\nedited later');
const r = archive.restore(z1, ['n1'], () => false, () => 'n2');
assert.strictEqual(r.id, 'n2', 'id collision -> new id');
assert.strictEqual(r.pinned, true);
assert.strictEqual(r.tasks[0].done, true);
assert.strictEqual(r.tasks[1].pri, 1);
assert.strictEqual(r.tasks[0].file, 'A.txt');
assert.strictEqual(get('A.txt'), 'A\r\n\r\nalpha');
assert.strictEqual(r.tasks[1].file, 'B.txt');
assert.strictEqual(r.deleted[0].task.file, 'C (restored).txt');
assert.strictEqual(get('C.txt'), 'C\r\n\r\nedited later');
assert.strictEqual(get('C (restored).txt'), 'C\r\n\r\ngone');

// restoring again reuses the identical "(restored)" copy; an identical file linked to a live task is not shared
const r2 = archive.restore(z1, [], (n) => n === 'B.txt', () => 'x');
assert.strictEqual(r2.id, 'n1');
assert.strictEqual(r2.deleted[0].task.file, 'C (restored).txt');
assert.strictEqual(r2.tasks[1].file, 'B (restored).txt');
assert.ok(fs.existsSync(path.join(root, 'archive', z1)), 'zip kept after restore');

fs.rmSync(root, { recursive: true });
console.log('archive ok');
