// node storage.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const storage = require('./storage');

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

fs.rmSync(dir, { recursive: true });
console.log('storage ok');
