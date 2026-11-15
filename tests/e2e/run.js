// npm run test:e2e   (electron tests/e2e/run.js)
// Starts the real app on a throwaway data folder, clicks through it, and checks what lands on disk.
// The first start migrates a small old-style "Note" folder, so migration is covered too. Windows appear on screen for about a minute.
const { app, BrowserWindow, dialog, Menu } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stickynotes-e2e-'));
const dataDir = path.join(root, 'data');
const oldDir = path.join(root, 'Note');
const out = path.join(root, 'out');
for (const d of [dataDir, path.join(oldDir, 'tasks'), path.join(oldDir, 'archive'), out]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(oldDir, 'data.json'), JSON.stringify({ version: 1, settings: { autoStart: true }, notes: [
  { id: 'n1', title: 'Today', color: '#fff3a8', bounds: { x: 120, y: 120, width: 300, height: 360 },
    tasks: [{ id: 't1', text: 'Call the dentist', pri: 0, file: 'Call the dentist.txt', fileTitle: 'Call the dentist' }, { id: 't2', text: 'Send the invoice', pri: 0 },
      { id: 't3', text: 'Book train tickets', pri: 1 }, { id: 't4', text: 'Water the plants', pri: 2 }],
    deleted: [{ task: { id: 't7', text: 'Renew passport', pri: 1 }, index: 1, at: Date.now() - 2 * 864e5 }] },
  { id: 'n2', title: 'Pirkumi šķūnim', color: '#cdf3dc', bounds: { x: 460, y: 120, width: 240, height: 220 }, tasks: [{ id: 't5', text: 'Bread', pri: 2 }, { id: 't6', text: 'Coffee', pri: 2 }] },
] }));
fs.writeFileSync(path.join(oldDir, 'tasks', 'Call the dentist.txt'), 'Call the dentist\r\n\r\nAsk about Thursday.');
const zip = new AdmZip();
zip.addFile('note.json', Buffer.from(JSON.stringify({ id: 'n3', title: 'Holiday packing', color: '#d1e6ff', archivedAt: new Date(Date.now() - 5 * 864e5).toISOString(), tasks: [{ id: 't8', text: 'Sunscreen', done: true }, { id: 't9', text: 'Chargers' }] })));
zip.writeZip(path.join(oldDir, 'archive', 'Holiday packing_2026-01-01_10-00.zip'));
const oldBefore = fs.readFileSync(path.join(oldDir, 'data.json'), 'utf8');

process.env.STICKYNOTES_DATA_DIR = dataDir;
process.env.STICKYNOTES_OLD_DIR = oldDir;
const said = []; // every dialog the app shows
let pick = 0, saveTo = '', openFrom = '';
dialog.showMessageBox = async (...a) => { const o = a.at(-1); said.push(`${o.message} ${o.detail || ''}`); return { response: o.buttons.length === 3 ? pick : 0 }; };
dialog.showMessageBoxSync = (...a) => { said.push(a.at(-1).message); return 0; };
dialog.showSaveDialog = async (o) => { said.push(`save as ${path.basename(o.defaultPath)}`); return { filePath: saveTo }; };
dialog.showOpenDialog = async () => ({ filePaths: [openFrom] });
dialog.showErrorBox = (t, m) => said.push(`ERROR ${m}`);
require('../../src/main/main.js');

let failed = 0;
const ok = (c, m) => { console.log(c ? 'PASS' : 'FAIL', m); if (!c) failed++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const disk = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'data.json'), 'utf8'));
const js = (w, code) => w.webContents.executeJavaScript(code, true);
const noteWin = (id) => BrowserWindow.getAllWindows().find((w) => w.noteId === id);
const noteWins = () => BrowserWindow.getAllWindows().filter((w) => w.noteId);
const launcherWin = () => BrowserWindow.getAllWindows().find((w) => !w.noteId);
const key = (k, mods = '') => `document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: '${k}', bubbles: true, cancelable: true ${mods} }))`;
const ctrl = (k) => `document.body.focus(); document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '${k}', ctrlKey: true, bubbles: true, cancelable: true }))`;
const texts = (note) => note.tasks.map((t) => t.text).join(' | ');
const rows = (l) => js(l, `[...document.querySelectorAll('#hist li')].map((li) => li.querySelector('.date').textContent.split(' · ')[0] + ':' + li.querySelector('.name').textContent)`);
const search = (l, q) => js(l, `q.value = ${JSON.stringify(q)}; q.dispatchEvent(new Event('input'))`);
const errors = [];
app.on('web-contents-created', (_e, wc) => wc.on('console-message', (e) => { if (e.level === 'error' || e.level === 3) errors.push(e.message); }));
process.on('uncaughtException', (e) => { console.log('FAIL uncaught', e.stack); failed++; });
const finish = () => {
  ok(!errors.length, `no errors in any window ${JSON.stringify(errors)}`);
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* temp folder: Windows may still hold the cache */ }
  app.exit(failed ? 1 : 0);
};

app.whenReady().then(async () => {
  await wait(3500);
  const ORDER = 'Call the dentist | Send the invoice | Book train tickets | Water the plants';
  let d = disk();

  // first start: migration from the old folder
  ok(d.schema_version === 2 && d.notes.length === 2 && d.history.map((e) => e.kind).sort().join() === 'note,task', 'migration: notes, deleted task and closed note carried over');
  ok(d.settings.autoStart === false && d.settings.hotkeys === true && d.settings.spellcheck === false, 'migration: settings start from safe defaults');
  ok(said.some((m) => /copied from the old Note app/.test(m)), 'migration: the user is told');
  ok(fs.readFileSync(path.join(oldDir, 'data.json'), 'utf8') === oldBefore && fs.readdirSync(path.join(oldDir, 'archive')).length === 1, 'migration: old folder unchanged');
  ok(fs.existsSync(path.join(dataDir, 'chromium', 'migrated-from-note')), 'migration: marked as done, outside the data folder');
  ok(fs.readdirSync(path.join(dataDir, 'backups')).some((f) => /^tasks-.*\.zip$/.test(f)), 'backup: daily zip of the task files');
  ok(Menu.getApplicationMenu() === null, 'no hidden application menu');
  ok(noteWins().length === 2 && !launcherWin(), 'two note windows, no launcher');
  const w = noteWin('n1'), w2 = noteWin('n2');

  // fonts: letters outside basic Latin come from the bundled font, not a fallback
  ok(await js(w2, `document.fonts.ready.then(() => [...document.fonts].some((f) => f.status === 'loaded' && f.family === 'Caveat' && /U\\+100-/i.test(f.unicodeRange)))`), 'fonts: latin-ext Caveat loaded for the title "Pirkumi šķūnim"');

  // tick box: instant, undo with Ctrl+Z
  await js(w, `document.querySelectorAll('.check')[1].click()`); await wait(450);
  ok(disk().notes[0].tasks[1].done === true && disk().notes[0].tasks[1].doneAt > 0, 'tick box ticks at once');
  ok(await js(w, `document.querySelectorAll('.label')[1].getAttribute('aria-checked')`) === 'true', 'ticked state is readable by screen readers');
  await js(w, ctrl('z')); await wait(450);
  ok(disk().notes[0].tasks[1].done === false, 'Ctrl+Z unticks');
  // priority
  await js(w, `document.querySelectorAll('.dot')[3].click()`); await wait(450);
  ok(disk().notes[0].tasks[3].pri === 0 && /High/.test(await js(w, `document.querySelectorAll('.dot')[3].title`)), 'priority changes and is labelled');
  await js(w, ctrl('z')); await wait(450);
  ok(disk().notes[0].tasks[3].pri === 2, 'Ctrl+Z restores priority');
  // keyboard reorder
  await js(w, `document.querySelector('.label').focus()`); await js(w, key('ArrowDown', ', altKey: true')); await wait(450);
  ok(texts(disk().notes[0]).startsWith('Send the invoice | Call the dentist') && await js(w, `document.activeElement.textContent`) === 'Call the dentist', 'Alt+Down moves the task and keeps it selected');
  await js(w, ctrl('z')); await wait(450);
  ok(texts(disk().notes[0]) === ORDER, 'Ctrl+Z moves it back');
  // edit
  await js(w, `document.querySelectorAll('.label')[2].focus()`); await js(w, key('Enter'));
  await js(w, `document.execCommand('insertText', false, ' today')`); await js(w, key('Enter')); await js(w, key('Escape')); await wait(450);
  ok(disk().notes[0].tasks[2].text === 'Book train tickets today' && disk().notes[0].tasks.length === 4, 'Enter edits, Enter saves, Esc drops the empty next row');
  await js(w, ctrl('z')); await wait(450);
  ok(disk().notes[0].tasks[2].text === 'Book train tickets', 'Ctrl+Z restores the old text');
  // delete + undo
  await js(w, `document.querySelectorAll('.label')[2].focus()`); await js(w, key('Delete')); await wait(450);
  d = disk();
  ok(d.notes[0].tasks.length === 3 && d.history.at(-1).task?.text === 'Book train tickets' && await js(w, `!!document.querySelector('.toast')`), 'Del moves the task to History and offers Undo');
  await js(w, ctrl('z')); await wait(600);
  ok(texts(disk().notes[0]) === ORDER && disk().history.length === 2, 'Ctrl+Z puts it back in place');
  await js(w, `document.querySelectorAll('.task .x')[0].click()`); await wait(450);
  await js(w, `document.querySelector('.toast button').click()`); await wait(600);
  ok(texts(disk().notes[0]) === ORDER && disk().notes[0].tasks[0].file === 'Call the dentist.txt', 'toast Undo restores the task with its notes file link');
  // clear completed
  ok(await js(w, `document.querySelector('.clear').hidden`), 'Clear completed is hidden while nothing is ticked');
  await js(w, `document.querySelectorAll('.check')[0].click(); document.querySelectorAll('.check')[2].click()`); await wait(300);
  await js(w, `document.querySelector('.clear').click()`); await wait(500);
  d = disk();
  ok(texts(d.notes[0]) === 'Send the invoice | Water the plants' && d.history.filter((e) => e.task?.done).length === 2, 'Clear completed moves ticked tasks to History');
  await js(w, ctrl('z')); await wait(700);
  d = disk();
  ok(texts(d.notes[0]) === ORDER && d.notes[0].tasks[0].done && d.notes[0].tasks[2].done && d.history.length === 2, 'Ctrl+Z brings them back, in order, still ticked');
  await js(w, ctrl('z')); await js(w, ctrl('z')); await wait(450);
  ok(disk().notes[0].tasks.every((t) => !t.done), 'further Ctrl+Z steps undo the two ticks');
  // a dropped file or a link must not replace the note
  await js(w, `location.href = 'https://example.com/'`); await wait(700);
  ok(/note\/index\.html$/.test(w.webContents.getURL()), 'navigation away from the note is blocked');
  // Ctrl+N
  await js(w, ctrl('n')); await js(w, `document.execCommand('insertText', false, 'Typed task')`); await js(w, key('Enter')); await js(w, key('Escape')); await wait(450);
  ok(disk().notes[0].tasks.at(-1).text === 'Typed task', 'Ctrl+N adds a task');
  ok(await js(w, `document.querySelector('.chev').classList.contains('has')`), 'the arrow marks a task whose notes file has text');

  // close a note: stays 4 s for Undo, then goes to History
  await js(w2, `document.querySelector('#close').click()`); await wait(500);
  ok(disk().notes.length === 2 && await js(w2, `document.body.classList.contains('closing')`), 'closing waits for Undo');
  await wait(4300);
  ok(disk().notes.length === 1 && disk().history.at(-1).note?.title === 'Pirkumi šķūnim', 'closed note is in History');

  // launcher: Ctrl+F from a note opens History
  await js(w, ctrl('f')); await wait(1800);
  let l = launcherWin();
  ok(l && await js(l, `!document.querySelector('#history').hidden && document.activeElement.id`) === 'q', 'Ctrl+F opens History with the search box focused');
  ok(JSON.stringify(await rows(l)) === JSON.stringify(['Closed note:Pirkumi šķūnim', 'Deleted:Renew passport', 'Closed note:Holiday packing']), 'History lists closed notes and deleted tasks, newest first');
  await search(l, 'bread');
  ok(JSON.stringify(await rows(l)) === JSON.stringify(['Closed note:Pirkumi šķūnim']), 'search finds a closed note by a task inside it');
  await search(l, 'water');
  ok(JSON.stringify(await rows(l)) === JSON.stringify(['Open task:Water the plants']) && await js(l, `document.querySelector('#hist .restore').textContent`) === 'Show', 'search also finds open tasks');
  await search(l, '');
  await js(l, `from.value = to.value = '${new Date(Date.now() - 2 * 864e5).toLocaleDateString('sv')}'; from.dispatchEvent(new Event('input'))`);
  ok(JSON.stringify(await rows(l)) === JSON.stringify(['Deleted:Renew passport']), 'date filter');
  await js(l, `from.value = to.value = ''; from.dispatchEvent(new Event('input'))`);
  // restore
  await search(l, 'pirkumi'); await js(l, `document.querySelector('#hist .restore').click()`); await wait(1500);
  ok(disk().notes.length === 2 && noteWins().length === 2, 'Restore reopens a closed note');
  await search(l, 'renew'); await js(l, `document.querySelector('#hist .restore').click()`); await wait(700);
  ok(disk().notes[0].tasks[1].text === 'Renew passport', 'Restore puts a deleted task back where it was');
  // delete permanently, one and many
  await search(l, '');
  await js(w, `document.querySelectorAll('.task .x')[0].click()`); await wait(500);
  await js(w, `document.querySelectorAll('.task .x')[0].click()`); await wait(500);
  ok(await js(l, `!document.querySelector('#bulk').hidden && document.querySelector('#bulk').textContent`) === 'Delete 3 shown', 'bulk delete is offered for what is listed');
  await search(l, 'dentist'); await js(l, `document.querySelector('#hist .del').click()`); await wait(600);
  ok(!disk().history.some((e) => e.task?.text === 'Call the dentist') && !fs.existsSync(path.join(dataDir, 'tasks', 'Call the dentist.txt')), 'Delete permanently removes the entry and its notes file');
  ok(fs.existsSync(path.join(oldDir, 'tasks', 'Call the dentist.txt')), '... and never the file in the old folder');
  await search(l, ''); await js(l, `document.querySelector('#bulk').click()`); await wait(600);
  ok(disk().history.length === 0 && said.some((m) => /Delete 2 items permanently\?/.test(m)), 'bulk delete, after asking');

  // settings
  await js(l, ctrl('n')); await wait(200);
  ok(await js(l, `!document.querySelector('#setup').hidden`), 'Ctrl+N in the launcher opens New note');
  await js(l, key('Escape'));
  await js(l, `document.querySelector('#settingsBtn').click(); document.querySelector('#setSpellcheck').click()`); await wait(600);
  ok(disk().settings.spellcheck === true && await js(w, `document.querySelector('.label').spellcheck`) === true, 'Settings: spellcheck reaches open notes');
  ok(await js(l, `document.querySelector('#setAutoStart').disabled`), 'Settings: auto-start is off limits when run from source');
  await js(l, `document.querySelector('#setHotkeys').click()`); await wait(500);
  ok(disk().settings.hotkeys === false, 'Settings: global shortcuts can be turned off');
  await js(l, `document.querySelector('#setHotkeys').click()`);
  await js(l, `document.querySelector('#helpBtn').click()`);
  ok(await js(l, `!document.querySelector('#help').hidden && document.querySelectorAll('#help dt').length > 10`), 'help panel lists the shortcuts');
  await js(l, key('Escape')); await wait(600);

  // export, change, import
  const before = disk();
  saveTo = path.join(out, 'backup.zip');
  await js(l, `document.querySelector('#export').click()`); await wait(1200);
  ok(fs.existsSync(saveTo) && said.some((m) => /^save as StickyNotes-backup-\d{4}-\d\d-\d\d\.zip$/.test(m)), 'export writes one zip, named with the date');
  await js(w, `document.querySelectorAll('.task .x')[0].click()`); await wait(600);
  openFrom = saveTo; pick = 1;
  await js(l, `document.querySelector('#import').click()`); await wait(2500);
  ok(JSON.stringify(disk()) === JSON.stringify(before) && noteWins().length === 2, 'import Replace: data is exactly what was exported, windows rebuilt');
  ok(fs.readdirSync(path.join(dataDir, 'backups')).some((f) => /before-import/.test(f)) && said.some((m) => /^This backup has 2 notes, \d+ tasks and 0 history items\./.test(m)), 'import: summary shown, backup made first');
  pick = 0;
  await js(l, `document.querySelector('#import').click()`); await wait(2500);
  ok(JSON.stringify(disk()) === JSON.stringify(before) && said.some((m) => /Added 0 notes, 0 tasks/.test(m)), 'import Merge of the same backup changes nothing');
  openFrom = path.join(out, 'bad.zip'); fs.writeFileSync(openFrom, 'not a zip');
  await js(l, `document.querySelector('#import').click()`); await wait(800);
  ok(said.some((m) => /^Nothing was imported\. This file is not a Sticky Notes backup/.test(m)) && JSON.stringify(disk()) === JSON.stringify(before), 'import of a bad file: plain message, nothing changed');

  // new note: empty state; launcher place and size remembered
  l.setBounds({ x: 640, y: 200, width: 400, height: 600 }); await wait(300);
  await js(l, `document.querySelector('#new').click(); document.querySelector('#create').click()`); await wait(2200);
  const fresh = noteWins().find((x) => !['n1', 'n2'].includes(x.noteId));
  ok(fresh && await js(fresh, `!document.querySelector('#hint').hidden && !!document.querySelector('.label[contenteditable]')`), 'new note: hint shown, first task ready for typing');
  ok(!launcherWin(), 'launcher closes after creating a note');
  app.emit('second-instance'); await wait(1500);
  l = launcherWin();
  ok(JSON.stringify(l.getBounds()) === JSON.stringify({ x: 640, y: 200, width: 400, height: 600 }), 'launcher place and size remembered');
  ok(!said.some((m) => /^ERROR|could not/i.test(m)), 'no error dialogs');

  // Quit button ends the app
  app.once('will-quit', (e) => { e.preventDefault(); ok(true, 'Quit button stops the app'); finish(); });
  setTimeout(() => { ok(false, 'Quit button stops the app'); finish(); }, 5000);
  await js(l, `document.querySelector('#quit').click()`);
});
