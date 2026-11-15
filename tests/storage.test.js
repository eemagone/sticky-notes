// node tests/storage.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const storage = require('../src/storage/storage');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'note-test-'));
let fails = 0;
storage.init(dir, () => fails++);

assert.deepStrictEqual(storage.load().data.notes, [], 'first run starts empty, no recovery');

storage.writeNow({ version: 1, notes: [{ id: 'a' }] });
storage.writeNow({ version: 1, notes: [{ id: 'a' }, { id: 'b' }] });
assert.strictEqual(storage.load().data.notes.length, 2);
assert.strictEqual(fs.readdirSync(path.join(dir, 'backups')).length, 1, 'one daily backup');

fs.writeFileSync(path.join(dir, 'data.json'), '{ broken');
let r = storage.load();
assert.strictEqual(r.recovered, 'data.json.bak');
assert.strictEqual(r.data.notes.length, 1, 'recovered previous version from .bak');

fs.unlinkSync(path.join(dir, 'data.json'));
fs.writeFileSync(path.join(dir, 'data.json.bak'), 'junk');
r = storage.load();
assert.match(r.recovered, /^data-\d{4}-\d{2}-\d{2}\.json$/, 'falls back to daily backup');

// BOM from a text editor is not corruption
fs.writeFileSync(path.join(dir, 'data.json'), '\uFEFF{"notes":[{"id":"bom"}]}');
r = storage.load();
assert.strictEqual(r.recovered, undefined);
assert.strictEqual(r.data.notes[0].id, 'bom');

// a save that cannot replace data.json is reported once and retried; flush() writes it once possible
const f = path.join(dir, 'data.json');
fs.chmodSync(f, 0o444);
assert.strictEqual(storage.writeNow({ notes: [{ id: 'new' }] }), false);
assert.strictEqual(storage.writeNow({ notes: [{ id: 'new' }] }), false);
assert.strictEqual(fails, 1, 'user told once per failure streak');
fs.chmodSync(f, 0o666);
storage.flush({ notes: [{ id: 'new' }] });
assert.strictEqual(storage.load().data.notes[0].id, 'new', 'pending save written by flush');

// schema 1 -> 2: deleted tasks move to history, malformed parts are repaired, not fatal
fs.writeFileSync(f, JSON.stringify({ version: 1, notes: [
  { id: 'n', title: 'T', tasks: [{ id: 't', text: 'x', pri: 9 }, null], deleted: [{ task: { id: 'd', text: 'gone' }, index: 0, at: 5 }] },
  { id: 'bare' }, 'junk',
], settings: { autoStart: true } }));
r = storage.load();
assert.strictEqual(r.data.schema_version, 2);
assert.deepStrictEqual(r.data.notes.map((n) => n.tasks.length), [1, 0]);
assert.strictEqual(r.data.notes[0].tasks[0].pri, 2);
assert.deepStrictEqual(r.data.history.map((e) => [e.kind, e.task.text, e.noteId, e.at]), [['task', 'gone', 'n', 5]]);

// a file from a newer app is never opened (and so never overwritten)
fs.writeFileSync(f, JSON.stringify({ schema_version: 99, notes: [] }));
assert.throws(() => storage.load(), (e) => e.code === 'NEWER_SCHEMA');

// only the newest 5 backups are kept; a named backup is one of them
fs.writeFileSync(f, JSON.stringify({ schema_version: 2, notes: [] }));
for (let d = 1; d <= 8; d++) fs.writeFileSync(path.join(dir, 'backups', `data-2020-01-0${d}.json`), '{"notes":[]}');
const named = storage.backup('before-import');
const kept = fs.readdirSync(path.join(dir, 'backups'));
assert.strictEqual(kept.length, 5);
assert.ok(kept.includes(named) && !kept.includes('data-2020-01-01.json'));

fs.rmSync(dir, { recursive: true });
console.log('storage ok');
