// node migrate.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const storage = require('./storage');
const migrate = require('./migrate');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'note-mig-'));
const oldDir = path.join(root, 'Note');
const newDir = path.join(root, 'StickyNotes');
fs.mkdirSync(path.join(oldDir, 'tasks'), { recursive: true });
fs.mkdirSync(path.join(oldDir, 'archive'));
fs.mkdirSync(newDir);
storage.init(newDir);

assert.strictEqual(migrate.fromNote(oldDir, newDir), null, 'nothing to migrate');

const v1 = {
  version: 1,
  notes: [{
    id: 'n1', title: 'Live', pinned: true, color: '#ffddc2', bounds: { x: 5, y: 6, width: 300, height: 300 },
    tasks: [{ id: 'a', text: 'A', done: true, pri: 0, file: 'A.txt', fileTitle: 'A' }, { id: 'b', text: 'B', done: false, pri: 1 }],
    deleted: [{ task: { id: 'c', text: 'C', done: false, pri: 2 }, index: 1, at: 111 }],
  }],
  settings: { autoStart: true },
  lastClosed: 'x.zip',
};
fs.writeFileSync(path.join(oldDir, 'data.json'), JSON.stringify(v1));
fs.writeFileSync(path.join(oldDir, 'tasks', 'A.txt'), 'A\r\n\r\nalpha');
const zip = (name, note, files = {}) => {
  const z = new AdmZip();
  z.addFile('note.json', Buffer.from(JSON.stringify(note)));
  for (const [n, body] of Object.entries(files)) z.addFile(`files/${n}`, Buffer.from(body));
  z.writeZip(path.join(oldDir, 'archive', name));
};
const closedNote = { id: 'n2', title: 'Closed', color: '#cdf3dc', archivedAt: '2026-10-06T01:00:00.000Z',
  tasks: [{ id: 'd', text: 'D', done: false, pri: 2, file: 'D.txt' }, { id: 'e', text: 'E', file: 'A.txt' }],
  deleted: [{ task: { id: 'f', text: 'F' }, index: 0, at: 222 }] };
zip('Closed_1.zip', closedNote, { 'D.txt': 'from zip', 'A.txt': 'older copy' });
zip('Closed_2.zip', closedNote); // same id again
fs.writeFileSync(path.join(oldDir, 'archive', 'broken.zip'), 'not a zip');
fs.writeFileSync(path.join(newDir, 'tasks-placeholder'), '');

const before = fs.readFileSync(path.join(oldDir, 'data.json'), 'utf8');
const m = migrate.fromNote(oldDir, newDir);
assert.strictEqual(m.data.schema_version, 2);
assert.strictEqual(m.data.settings.autoStart, false, 'old auto-start is not carried over');
assert.deepStrictEqual(m.data.notes[0].tasks.map((t) => t.text), ['A', 'B']);
assert.strictEqual(m.data.notes[0].deleted, undefined, 'deleted tasks moved out of the note');
assert.strictEqual(m.data.notes[0].pinned, true);
assert.deepStrictEqual(m.data.notes[0].bounds, { width: 300, height: 300, x: 5, y: 6 });
assert.ok(m.data.notes[0].tasks[0].doneAt > 0, 'completed tasks get a date');
assert.deepStrictEqual([m.closed, m.skipped], [2, 1]);
const kinds = m.data.history.map((e) => `${e.kind}:${e.kind === 'note' ? e.note.title : e.task.text}`);
assert.deepStrictEqual(kinds, ['task:C', 'note:Closed', 'task:F', 'note:Closed', 'task:F']);
const ids = m.data.history.filter((e) => e.kind === 'note').map((e) => e.note.id);
assert.ok(ids[0] === 'n2' && ids[1] !== 'n2', 'second copy of a note gets a new id');
assert.strictEqual(m.data.history[1].at, Date.parse('2026-10-06T01:00:00.000Z'));
assert.strictEqual(fs.readFileSync(path.join(newDir, 'tasks', 'A.txt'), 'utf8'), 'A\r\n\r\nalpha', 'live file wins over the zip copy');
assert.strictEqual(fs.readFileSync(path.join(newDir, 'tasks', 'D.txt'), 'utf8'), 'from zip', 'missing file comes from the zip');
assert.strictEqual(fs.readFileSync(path.join(oldDir, 'data.json'), 'utf8'), before, 'old data untouched');
assert.strictEqual(fs.readdirSync(path.join(oldDir, 'archive')).length, 3, 'old zips untouched');

// what was migrated survives a save and a load unchanged
storage.writeNow(m.data);
assert.deepStrictEqual(storage.load().data, m.data);

// damaged data.json: the old app's own .bak is used
fs.writeFileSync(path.join(oldDir, 'data.json.bak'), before);
fs.writeFileSync(path.join(oldDir, 'data.json'), '{ broken');
assert.strictEqual(migrate.fromNote(oldDir, path.join(root, 'again')).data.notes.length, 1);

fs.rmSync(root, { recursive: true });
console.log('migrate ok');
