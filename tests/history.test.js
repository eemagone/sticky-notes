// node tests/history.test.js
const assert = require('assert');
const { upgrade } = require('../src/models/model');
const history = require('../src/models/history');

const fresh = () => upgrade({ schema_version: 2, notes: [
  { id: 'n1', title: 'List', tasks: [
    { id: 'a', text: 'A', done: true, doneAt: 50 }, { id: 'b', text: 'B' }, { id: 'c', text: 'C', done: true, doneAt: 60, file: 'C.txt' },
    { id: 'd', text: 'D', done: true, doneAt: 70 }, { id: 'e', text: '' }] },
  { id: 'n2', title: '', tasks: [] }], history: [] });
const texts = (note) => note.tasks.map((t) => t.text).join('');

// delete a task, undo it: same place, same task
let data = fresh();
let [n1, n2] = data.notes;
const id = history.deleteTask(data, n1, 'b');
assert.strictEqual(texts(n1), 'ACD');
assert.deepStrictEqual(data.history.map((e) => [e.kind, e.task.text, e.noteId, e.index]), [['task', 'B', 'n1', 1]]);
let r = history.restore(data, id);
assert.strictEqual(texts(n1), 'ABCD');
assert.deepStrictEqual([r.open.length, r.sync.noteId, r.sync.op.index, r.focus], [0, 'n1', 1, 'n1']);
assert.strictEqual(data.history.length, 0);
assert.strictEqual(history.deleteTask(data, n1, 'e'), null, 'an empty row is dropped, not kept');
assert.strictEqual(history.deleteTask(data, n1, 'nope'), null);
assert.strictEqual(history.restore(data, 'nope'), null);

// clear completed, then restore in the returned order: the original list comes back
const ids = history.clearDone(data, n1);
assert.strictEqual(texts(n1), 'B');
assert.strictEqual(ids.length, 3);
assert.deepStrictEqual(history.items(data).filter((i) => i.stored).map((i) => i.kind), ['done', 'done', 'done'], 'cleared tasks still read as completed');
ids.forEach((x) => history.restore(data, x));
assert.strictEqual(texts(n1), 'ABCD');
assert.ok(n1.tasks[0].done && n1.tasks[2].file === 'C.txt');

// items: completed tasks on open notes are listed live; open tasks come last, for search
let rows = history.items(data);
assert.deepStrictEqual(rows.map((i) => `${i.kind}:${i.text}`), ['done:D', 'done:C', 'done:A', 'open:B']);
r = history.restore(data, 'done:n1:c');
assert.ok(!n1.tasks[2].done && n1.tasks[2].doneAt === undefined && r.sync.op.task.id === 'c', 'restore on a completed task unticks it');

// close notes: an empty one is dropped, one with content is kept and can be reopened
assert.ok(history.closeNote(data, n2));
assert.strictEqual(data.history.length, 0);
assert.ok(history.closeNote(data, n1));
assert.ok(!history.closeNote(data, n1), 'closing twice does nothing');
assert.deepStrictEqual([data.notes.length, data.history[0].kind, history.lastClosed(data).note.id], [0, 'note', 'n1']);
assert.strictEqual(history.items(data)[0].find, 'A\nB\nC\nD', 'a closed note is found by its task text');
r = history.restore(data, data.history[0].id);
assert.deepStrictEqual([r.open[0].id, data.notes.length, data.history.length], ['n1', 1, 0]);

// a deleted task whose note was closed meanwhile: the note is reopened for it
data = fresh(); [n1] = data.notes;
const del = history.deleteTask(data, n1, 'b');
history.closeNote(data, n1);
r = history.restore(data, del);
assert.deepStrictEqual([r.open.length, r.open[0].id, texts(data.notes.find((n) => n.id === 'n1')), data.history.length], [1, 'n1', 'ABCD', 0]);

// ... and if that note was deleted for good, a new note with its title is made
data = fresh(); [n1] = data.notes;
const del2 = history.deleteTask(data, n1, 'c');
history.closeNote(data, n1);
const gone = history.forget(data, [history.lastClosed(data).id]);
assert.strictEqual(gone.tasks.length, 4);
r = history.restore(data, del2);
assert.deepStrictEqual([r.open[0].title, texts(r.open[0]), r.open[0].id !== 'n1'], ['List', 'C', true]);

// describe changes nothing; forget removes stored entries and live completed tasks
data = fresh(); [n1] = data.notes;
const del3 = history.deleteTask(data, n1, 'c');
const before = JSON.stringify(data);
const what = history.describe(data, [del3, 'done:n1:a', 'missing']);
assert.deepStrictEqual([what.names, what.tasks.filter((t) => t.file).length, what.notes], [['C', 'A'], 1, 0]);
assert.strictEqual(JSON.stringify(data), before);
const f = history.forget(data, [del3, 'done:n1:a', 'missing']);
assert.deepStrictEqual([f.tasks.map((t) => t.text), f.syncs, texts(n1), data.history.length], [['C', 'A'], [{ noteId: 'n1', op: { op: 'remove', id: 'a' } }], 'BD', 0]);

// a note id that is open again when its closed copy is restored gets a new id
data = fresh(); [n1] = data.notes;
data.history.push({ id: 'h', kind: 'note', at: 1, note: structuredClone(n1) });
r = history.restore(data, 'h');
assert.ok(r.open[0].id !== 'n1' && data.notes.length === 3);

console.log('history ok');
