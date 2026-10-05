// node taskfiles.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tf = require('./taskfiles');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'note-tasks-'));
tf.init(dir);
const read = (t) => fs.readFileSync(path.join(dir, t.file), 'utf8');

assert.strictEqual(tf.baseName('a/b:c*?"<>|d. '), 'abcd', 'illegal chars and trailing dot/space removed');
assert.strictEqual(tf.baseName('CON'), 'CON_');
assert.strictEqual(tf.baseName('nul.list'), 'nul.list_');
assert.strictEqual(tf.baseName('   '), 'Untitled task');
assert.strictEqual(tf.baseName('x'.repeat(200)).length, 80);

const a = { id: 'a', text: 'Buy milk' };
const b = { id: 'b', text: 'Buy milk' };
const c = { id: 'c', text: 'Buy milk' };
const data = { notes: [{ tasks: [a, b], deleted: [{ task: c }] }] };

tf.ensure(data, a);
tf.ensure(data, b);
tf.ensure(data, c);
assert.deepStrictEqual([a.file, b.file, c.file], ['Buy milk.txt', 'Buy milk (2).txt', 'Buy milk (3).txt']);
assert.strictEqual(read(a), 'Buy milk\r\n\r\n', 'header + blank line');

fs.appendFileSync(path.join(dir, a.file), 'my notes');
assert.deepStrictEqual(tf.hints(data.notes[0]), ['a'], 'hint only for file with content');

// rename: file follows, header updated, user text untouched
a.text = 'Buy oat milk';
tf.ensure(data, a);
assert.strictEqual(a.file, 'Buy oat milk.txt');
assert.strictEqual(read(a), 'Buy oat milk\r\n\r\nmy notes');
assert.ok(!fs.existsSync(path.join(dir, 'Buy milk.txt')));

// header edited by the user: rename the file but leave the first line alone
fs.writeFileSync(path.join(dir, a.file), 'My own heading\r\n\r\nmy notes');
a.text = 'Oat milk';
tf.ensure(data, a);
assert.strictEqual(a.file, 'Oat milk.txt');
assert.strictEqual(read(a), 'My own heading\r\n\r\nmy notes');

// rename onto a name another task owns -> numbered, never overwrite
b.text = 'Oat milk';
tf.ensure(data, b);
assert.strictEqual(b.file, 'Oat milk (2).txt');
assert.strictEqual(read(a), 'My own heading\r\n\r\nmy notes');

// case-only rename keeps the same slot
a.text = 'oat milk';
tf.ensure(data, a);
assert.strictEqual(a.file, 'oat milk.txt');

// user deleted the file -> fresh one with header
fs.unlinkSync(path.join(dir, c.file));
tf.ensure(data, c);
assert.strictEqual(read(c), 'Buy milk\r\n\r\n');

// pending rename retried at launch
c.text = 'Bread';
assert.strictEqual(tf.renamePending(data), false, 'deleted tasks are not renamed at launch');
data.notes[0].tasks.push(c);
assert.strictEqual(tf.renamePending(data), true);
assert.strictEqual(c.file, 'Bread.txt');

fs.rmSync(dir, { recursive: true });
console.log('taskfiles ok');
