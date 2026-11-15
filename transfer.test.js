// node transfer.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const { upgrade } = require('./model');
const transfer = require('./transfer');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'note-xfer-'));
const dir = (name, files = {}) => {
  const d = path.join(root, name);
  fs.mkdirSync(d, { recursive: true });
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(d, f), body);
  return d;
};
const files = (d) => Object.fromEntries(fs.readdirSync(d).sort().map((f) => [f, fs.readFileSync(path.join(d, f), 'utf8')]));

// everything the app stores: open notes, done tasks, deleted tasks, closed notes, settings, linked files
const A = upgrade({ schema_version: 2,
  notes: [{ id: 'n1', title: 'Näte ✓', color: '#cdf3dc', pinned: true, bounds: { x: 10, y: 20, width: 300, height: 360 },
    tasks: [{ id: 't1', text: 'One', done: true, doneAt: 5, pri: 0, file: 'One.txt', fileTitle: 'One' }, { id: 't2', text: 'Two', pri: 1 }] }],
  history: [
    { id: 'h1', kind: 'task', at: 7, noteId: 'n1', noteTitle: 'Näte ✓', index: 1, task: { id: 't3', text: 'Gone', file: 'Gone.txt' } },
    { id: 'h2', kind: 'note', at: 8, note: { id: 'n2', title: 'Closed', tasks: [{ id: 't4', text: 'Old' }] } },
  ],
  settings: { autoStart: true, launcher: { x: 1, y: 2 } } });
const aTasks = dir('a-tasks', { 'One.txt': 'One\r\n\r\nfirst', 'Gone.txt': 'Gone\r\n\r\nkept', 'Loose.txt': 'not linked' });
const zip = path.join(root, 'StickyNotes-backup.zip');

assert.deepStrictEqual(transfer.exportTo(zip, A, aTasks), { notes: 1, tasks: 2, history: 2 });
assert.ok(!fs.existsSync(`${zip}.tmp`));

// round trip: export -> import (replace) on an empty computer -> identical data and files
const backup = transfer.read(zip);
assert.deepStrictEqual(backup.counts, { notes: 1, tasks: 2, history: 2 });
const bTasks = path.join(root, 'b-tasks');
let r = transfer.apply(upgrade({ notes: [] }), backup, 'replace', bTasks);
assert.deepStrictEqual(r.data, A);
assert.deepStrictEqual(files(bTasks), files(aTasks));

// export of the imported data is again the same data (second round trip)
const zip2 = path.join(root, 'again.zip');
transfer.exportTo(zip2, r.data, bTasks);
assert.deepStrictEqual(transfer.read(zip2).data, A);

// merge into itself: nothing added, nothing changed
r = transfer.apply(A, backup, 'merge', aTasks);
assert.deepStrictEqual(r.data, A);
assert.deepStrictEqual(r.added, { notes: 0, history: 0 });
assert.strictEqual(Object.keys(files(aTasks)).length, 3);

// merge into other data: both kept; a clashing .txt is never overwritten, the imported task points at its own copy
const C = upgrade({ schema_version: 2, notes: [{ id: 'c1', title: 'Mine', tasks: [{ id: 'x', text: 'One', file: 'One.txt' }] }], history: [], settings: { autoStart: false } });
const cTasks = dir('c-tasks', { 'One.txt': 'my own text' });
const before = JSON.stringify(C);
r = transfer.apply(C, backup, 'merge', cTasks);
assert.strictEqual(JSON.stringify(C), before, 'current data object not modified');
assert.deepStrictEqual(r.data.notes.map((n) => n.id), ['c1', 'n1']);
assert.deepStrictEqual(r.data.notes[0], C.notes[0]);
assert.deepStrictEqual(r.added, { notes: 1, history: 2 });
assert.strictEqual(r.data.settings.autoStart, false, 'merge keeps your settings');
assert.strictEqual(files(cTasks)['One.txt'], 'my own text');
assert.strictEqual(r.data.notes[1].tasks[0].file, 'One (imported).txt');
assert.strictEqual(files(cTasks)['One (imported).txt'], 'One\r\n\r\nfirst');
assert.strictEqual(backup.data.notes[0].tasks[0].file, 'One.txt', 'the read backup is not modified either');
// merging the same backup again adds nothing and makes no second copy
const r2 = transfer.apply(r.data, backup, 'merge', cTasks);
assert.deepStrictEqual(r2.added, { notes: 0, history: 0 });
assert.ok(!('One (imported 2).txt' in files(cTasks)));

// a note that is closed here is not added a second time as an open note
const D = upgrade({ schema_version: 2, notes: [], history: [{ id: 'other', kind: 'note', at: 1, note: { id: 'n1', title: 'Closed here', tasks: [] } }] });
r = transfer.apply(D, backup, 'merge', dir('d-tasks'));
assert.deepStrictEqual(r.data.notes, []);

// replace over other data: result is the backup; the clashing file still is not overwritten
const eTasks = dir('e-tasks', { 'One.txt': 'my own text', 'Mine.txt': 'stays' });
r = transfer.apply(C, backup, 'replace', eTasks);
assert.strictEqual(r.data.notes.length, 1);
assert.strictEqual(r.data.notes[0].tasks[0].file, 'One (imported).txt');
assert.strictEqual(files(eTasks)['One.txt'], 'my own text');
assert.strictEqual(files(eTasks)['Mine.txt'], 'stays');
r.data.notes[0].tasks[0].file = 'One.txt';
assert.deepStrictEqual(r.data, A, 'apart from that file name, identical to the backup');

// bad files: a plain message, nothing written, never a crash
const badDir = dir('bad');
const make = (name, entries) => {
  const z = new AdmZip();
  for (const [n, body] of Object.entries(entries)) z.addFile(n, Buffer.from(body));
  z.writeZip(path.join(badDir, name));
  return path.join(badDir, name);
};
fs.writeFileSync(path.join(badDir, 'text.zip'), 'hello');
fs.writeFileSync(path.join(badDir, 'empty.zip'), '');
const not = /not a Sticky Notes backup/;
assert.throws(() => transfer.read(path.join(badDir, 'text.zip')), not);
assert.throws(() => transfer.read(path.join(badDir, 'empty.zip')), not);
assert.throws(() => transfer.read(path.join(badDir, 'missing.zip')), not);
assert.throws(() => transfer.read(make('nodata.zip', { 'readme.txt': 'x' })), not);
assert.throws(() => transfer.read(make('junk.zip', { 'data.json': '{ broken' })), not);
assert.throws(() => transfer.read(make('shape.zip', { 'data.json': '{"notes":"nope"}' })), not);
assert.throws(() => transfer.read(make('null.zip', { 'data.json': 'null' })), not);
assert.throws(() => transfer.read(make('newer.zip', { 'data.json': '{"schema_version":99,"notes":[]}' })), /newer version/);

// hostile names stay inside the tasks folder; odd content is repaired, not fatal
const evil = transfer.read(make('evil.zip', {
  'data.json': JSON.stringify({ notes: [{ id: 'e', tasks: [{ id: 't', text: 'x', file: '../../PWNED.txt' }, 7, null] }, 'junk'], history: [{ kind: 'task' }] }),
  'tasks/../PWNED.txt': 'pwned', 'tasks/sub/deep.txt': 'x', 'tasks/ok.txt': 'fine',
}));
assert.deepStrictEqual([...evil.files.keys()], ['ok.txt']);
assert.strictEqual(evil.data.notes[0].tasks[0].file, undefined);
assert.deepStrictEqual(evil.counts, { notes: 1, tasks: 1, history: 0 });
const fTasks = dir('f-tasks');
transfer.apply(upgrade({ notes: [] }), evil, 'replace', fTasks);
assert.deepStrictEqual(Object.keys(files(fTasks)), ['ok.txt']);
assert.ok(!fs.existsSync(path.join(root, 'PWNED.txt')));

// schema 1 backups (hand-made from the old app's data.json) import too
const v1 = transfer.read(make('v1.zip', { 'data.json': JSON.stringify({ version: 1, notes: [{ id: 'o', title: 'Old', tasks: [], deleted: [{ task: { id: 'd', text: 'was deleted' }, index: 0, at: 3 }] }] }) }));
assert.deepStrictEqual(v1.counts, { notes: 1, tasks: 0, history: 1 });

fs.rmSync(root, { recursive: true });
console.log('transfer ok');
