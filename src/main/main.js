const { app, BrowserWindow, ipcMain, Menu, screen, shell, nativeImage, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { PALETTE, newId, cleanTasks } = require('../models/model');
const storage = require('../storage/storage');
const taskfiles = require('../storage/taskfiles');
const migrate = require('../storage/migrate');
const transfer = require('../storage/transfer');
const pinning = require('./pinning');
const tray = require('./tray');
const icon = require('./icon');

// Notes live in %APPDATA%\StickyNotes, never next to the .exe. Chromium's caches go to %LOCALAPPDATA%.
// Developers: STICKYNOTES_DATA_DIR runs the app on a throwaway folder; STICKYNOTES_OLD_DIR is the old "Note" folder to migrate from.
const DEV_DIR = process.env.STICKYNOTES_DATA_DIR;
const DATA_DIR = DEV_DIR || path.join(app.getPath('appData'), 'StickyNotes');
const OLD_DIR = process.env.STICKYNOTES_OLD_DIR || (DEV_DIR ? null : path.join(app.getPath('appData'), 'Note'));
app.setPath('userData', DEV_DIR ? path.join(DEV_DIR, 'chromium') : path.join(process.env.LOCALAPPDATA || app.getPath('temp'), 'StickyNotes'));

const APP = 'Sticky Notes';
const RAISE_MS = 4000;
const SIZE = { w: [200, 800], h: [160, 1000] }; // note window limits
const SIZES = [
  { name: 'Small', width: 240, height: 220 },
  { name: 'Medium', width: 300, height: 360 },
  { name: 'Large', width: 400, height: 500 },
  { name: 'Wide', width: 520, height: 320 },
  { name: 'Tall', width: 300, height: 600 },
];

let data;
let launcher = null;
let quitting = false;
let hidden = false;
const wins = new Map(); // noteId -> BrowserWindow
const fresh = new Set(); // new notes that still need their first empty task
const closing = new Set(); // noteIds whose window is closing on purpose
const appIcon = () => nativeImage.createFromBuffer(icon.noteIcon(64));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(+v) || lo));
const liveNote = (id) => data.notes.find((n) => n.id === id);
const noteList = () => data.notes.map(({ id, title, color, bounds }) => ({ id, title, color, width: bounds.width, height: bounds.height }));
const lastClosed = () => data.history.filter((e) => e.kind === 'note').sort((a, b) => b.at - a.at)[0];
const launcherState = () => ({ palette: PALETTE, limits: SIZE, notes: noteList(), history: historyItems(), canReopen: !!lastClosed() });
const trayModel = () => ({ notes: noteList(), hidden, canReopen: !!lastClosed(), autoStart: data.settings.autoStart });
const save = () => {
  storage.save(data);
  launcher?.webContents.send('state', launcherState());
  tray.refresh(trayModel);
};

// Every problem is shown in a window of its own: a portable .exe has no Start Menu entry, so Windows may drop its notifications.
const tell = (message, detail = '', type = 'warning') => dialog.showMessageBox({ type, title: APP, message, detail, buttons: ['OK'], noLink: true });
const reason = (e) => ({
  EBUSY: 'another program is using the file', EPERM: 'Windows denied access to the file', EACCES: 'Windows denied access to the file',
  ENOSPC: 'the disk is full', EROFS: 'the disk is read-only',
}[e.code] || e.message);

// Keep the title bar on some visible screen (monitor unplugged, resolution changed).
function onScreen(b) {
  if (b.x == null) return b;
  const visible = screen.getAllDisplays().some(({ workArea: a }) =>
    b.x < a.x + a.width - 48 && b.x + b.width > a.x + 48 && b.y >= a.y - 8 && b.y < a.y + a.height - 48);
  if (visible) return b;
  const a = screen.getPrimaryDisplay().workArea;
  return { width: Math.min(b.width, a.width), height: Math.min(b.height, a.height), x: a.x + 48, y: a.y + 48 };
}

/* ---------- note windows ---------- */
function openNote(note, { focus = false } = {}) {
  note.bounds = onScreen(note.bounds);
  const win = new BrowserWindow({
    ...note.bounds, minWidth: SIZE.w[0], minHeight: SIZE.h[0], maxWidth: SIZE.w[1], maxHeight: SIZE.h[1],
    frame: false, // opaque + frameless: Win11 gives native rounded corners, shadow and edge-resize
    backgroundColor: note.color,
    alwaysOnTop: !note.pinned,
    skipTaskbar: true, // the tray lists notes
    show: false,
    icon: appIcon(),
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.noteId = note.id;
  wins.set(note.id, win);
  pinning.setup(win);
  const track = () => { if (!win.isDestroyed()) rescue(win, note); };
  win.once('ready-to-show', () => {
    if (focus) win.show(); else if (!hidden) win.showInactive(); // restoring at login must not steal focus
    pinning.apply(win, note.pinned);
    track();
  });
  win.on('moved', track);
  win.on('resized', track);
  win.on('session-end', () => { quitting = true; storage.flush(data); }); // Windows shutdown/logoff
  win.on('close', (e) => { if (!quitting && !closing.has(note.id)) e.preventDefault(); }); // Alt+F4: use × to close
  win.on('system-context-menu', (e) => { e.preventDefault(); showMenu(note); }); // right-click on drag area
  win.on('closed', () => {
    if (wins.get(note.id) === win) wins.delete(note.id); // after an import a new window may already own this id
    // closed by something else (e.g. Explorer restart destroys desktop-owned windows): bring it back
    if (quitting || closing.delete(note.id)) return;
    setTimeout(() => { if (!quitting && data.notes.includes(note) && !wins.has(note.id)) openNote(note); }, 1500);
  });
  win.loadFile(path.join(__dirname, '..', 'ui', 'note', 'index.html'));
}

function newNote({ width = 300, height = 360, color, title = '' } = {}) {
  const note = {
    id: newId(), title, pinned: false, tasks: [],
    color: PALETTE.some((c) => c.hex === color) ? color : PALETTE[0].hex,
    bounds: { width: clamp(width, ...SIZE.w), height: clamp(height, ...SIZE.h) },
  };
  data.notes.push(note);
  save();
  if (hidden) toggleHidden();
  openNote(note, { focus: true });
  return note;
}

// Save the window's bounds, pulling it back first if it drifted off every screen
// (pinned notes have been seen at x = -1.7e9, and monitors get unplugged).
function rescue(win, note) {
  if (!note || win.isDestroyed()) return;
  const b = win.getBounds();
  const fixed = onScreen(b);
  if (fixed !== b) pinning.setBounds(win, fixed);
  note.bounds = win.getBounds();
  save();
}
const rescueAll = () => { for (const [id, win] of wins) rescue(win, liveNote(id)); };

function resizeNote(note, { width, height }) {
  const win = wins.get(note.id);
  if (!win || win.isDestroyed()) return;
  pinning.setBounds(win, onScreen({ ...win.getBounds(), width, height }));
  rescue(win, note);
}

// activate=false: bring it into view but leave focus where it is (launcher resize panel)
function focusNote(id, activate = true) {
  const note = liveNote(id);
  const win = wins.get(id);
  if (!note || !win) return;
  if (hidden) toggleHidden();
  rescue(win, note);
  if (note.pinned) return pinning.raise(win, RAISE_MS, () => note.pinned, activate);
  if (!activate) return win.showInactive();
  win.show();
  win.focus();
}

function toggleHidden() {
  hidden = !hidden;
  for (const [id, win] of wins) {
    if (hidden) win.hide();
    else {
      const note = liveNote(id);
      if (!note) continue; // closed, window still closing
      rescue(win, note);
      win.showInactive();
      pinning.apply(win, note.pinned);
    }
  }
  save();
}

/* ---------- history: closed notes, deleted tasks, completed tasks ---------- */
// Tell an open note window about a task the main process changed. A window that is still loading reads it from init.
function sync(noteId, op) {
  const win = wins.get(noteId);
  if (win && !win.isDestroyed() && !win.webContents.isLoading()) win.webContents.send('sync', op);
}

function closeNote(note) {
  if (!data.notes.includes(note)) return; // menu and × racing
  data.notes = data.notes.filter((n) => n !== note);
  if (note.title || note.tasks.some((t) => t.text)) data.history.push({ id: newId(), kind: 'note', at: Date.now(), note });
  storage.writeNow(data);
  closing.add(note.id);
  if (!data.notes.length) hidden = false;
  wins.get(note.id)?.close();
  save();
}

// The note window has already dropped the task from its own list. Returns the history id for Undo.
function deleteTask(note, taskId) {
  const index = note.tasks.findIndex((t) => t.id === taskId);
  if (index < 0) return null;
  const [task] = note.tasks.splice(index, 1);
  const entry = { id: newId(), kind: 'task', at: Date.now(), noteId: note.id, noteTitle: note.title, index, task };
  if (task.text) data.history.push(entry);
  save();
  return task.text ? entry.id : null;
}

// Completed tasks stay on their note; History lists them next to the stored entries under a "done:" id.
const doneRef = (id) => {
  const [, noteId, taskId] = /^done:([^:]+):(.+)$/.exec(id) || [];
  const note = liveNote(noteId);
  const task = note?.tasks.find((t) => t.id === taskId && t.done);
  return task ? { note, task } : null;
};
function historyItems() {
  return [
    ...data.history.map((e) => (e.kind === 'note'
      ? { id: e.id, kind: 'note', at: e.at, text: e.note.title || 'Untitled', find: e.note.tasks.map((t) => t.text).join('\n'), count: e.note.tasks.length }
      : { id: e.id, kind: 'deleted', at: e.at, text: e.task.text, note: e.noteTitle })),
    ...data.notes.flatMap((n) => n.tasks.filter((t) => t.done)
      .map((t) => ({ id: `done:${n.id}:${t.id}`, kind: 'done', at: t.doneAt, text: t.text, note: n.title }))),
  ].sort((a, b) => b.at - a.at);
}

// show: bring the note forward (asked from the launcher); an Undo inside the note leaves the windows alone
function restoreHistory(id, show = true) {
  const done = doneRef(id);
  if (done) {
    done.task.done = false;
    delete done.task.doneAt;
    sync(done.note.id, { op: 'upsert', task: done.task });
    return save();
  }
  const k = data.history.findIndex((e) => e.id === id);
  if (k < 0) return;
  const [e] = data.history.splice(k, 1);
  if (e.kind === 'note') {
    if (liveNote(e.note.id)) e.note.id = newId();
    data.notes.push(e.note);
    if (hidden) toggleHidden();
    openNote(e.note, { focus: true });
  } else {
    // back onto its note; if that note was closed it is reopened, if it is gone for good a new one is made
    const closed = data.history.find((h) => h.kind === 'note' && h.note.id === e.noteId);
    if (!liveNote(e.noteId) && closed) restoreHistory(closed.id);
    const note = liveNote(e.noteId) || newNote({ title: e.noteTitle });
    const index = Math.min(e.index, note.tasks.length);
    note.tasks.splice(index, 0, e.task);
    sync(note.id, { op: 'upsert', task: e.task, index });
    if (show) focusNote(note.id);
  }
  save();
}

function deleteForever(id) {
  const done = doneRef(id);
  const entry = data.history.find((e) => e.id === id);
  if (!done && !entry) return;
  const tasks = done ? [done.task] : entry.kind === 'note' ? entry.note.tasks : [entry.task];
  const name = done ? done.task.text : entry.kind === 'note' ? entry.note.title || 'Untitled' : entry.task.text;
  const files = tasks.filter((t) => t.file).length;
  const choice = dialog.showMessageBoxSync(launcher, {
    type: 'warning', title: APP, noLink: true, buttons: ['Delete permanently', 'Cancel'], defaultId: 1, cancelId: 1,
    message: `Delete “${name.length > 60 ? `${name.slice(0, 60)}…` : name}” permanently?`,
    detail: `${entry?.kind === 'note' ? `This closed note has ${tasks.length} task${tasks.length === 1 ? '' : 's'}. ` : ''}`
      + `${files ? `The notes file${files === 1 ? '' : 's'} (.txt) will be deleted too. ` : ''}This cannot be undone.`,
  });
  if (choice !== 0) return;
  if (done) {
    done.note.tasks = done.note.tasks.filter((t) => t !== done.task);
    sync(done.note.id, { op: 'remove', id: done.task.id });
  } else data.history = data.history.filter((e) => e !== entry);
  try { taskfiles.remove(data, tasks); } catch (e) {
    tell('The item was deleted, but its notes file could not be removed.', `Reason: ${reason(e)}.\nYou can delete it yourself in the notes folder (tray icon → Open notes folder).`);
  }
  save();
}

/* ---------- export / import ---------- */
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const summary = (c) => `${plural(c.notes, 'note')}, ${plural(c.tasks, 'task')} and ${plural(c.history, 'history item')}`;
const BACKUP_FILTER = [{ name: 'Sticky Notes backup', extensions: ['zip'] }];

async function exportData() {
  const { filePath } = await dialog.showSaveDialog({
    title: 'Export backup', filters: BACKUP_FILTER,
    defaultPath: path.join(app.getPath('documents'), `StickyNotes-backup-${new Date().toLocaleDateString('sv')}.zip`),
  });
  if (!filePath) return;
  try {
    const c = transfer.exportTo(filePath, data, taskfiles.dir());
    tell('Backup saved.', `${summary(c)}, with the notes files, were saved to:\n${filePath}`, 'info');
  } catch (e) {
    tell('The backup could not be saved.', `Reason: ${reason(e)}.\nPick another folder and try again.`);
  }
}

async function importData() {
  const { filePaths: [file] } = await dialog.showOpenDialog({ title: 'Import backup', properties: ['openFile'], filters: BACKUP_FILTER });
  if (!file) return;
  let backup;
  try { backup = transfer.read(file); } catch (e) { return tell('Nothing was imported.', e.message); }
  const { response } = await dialog.showMessageBox({
    type: 'question', title: APP, noLink: true, buttons: ['Merge', 'Replace', 'Cancel'], defaultId: 0, cancelId: 2,
    message: `This backup has ${summary(backup.counts)}.`,
    detail: 'Merge adds the notes and history items you do not have yet. Nothing you have now is changed.\n\n'
      + 'Replace swaps everything you have now for the backup.\n\nEither way, a backup of your current notes is made first.',
  });
  if (response === 2) return;
  try {
    if (!storage.writeNow(data)) throw new Error('your current notes could not be saved first');
    storage.backup('before-import');
    const r = transfer.apply(data, backup, response === 0 ? 'merge' : 'replace', taskfiles.dir());
    swapData(r.data);
    tell('Import finished.', response === 0 ? `Added ${plural(r.added.notes, 'note')} and ${plural(r.added.history, 'history item')}.`
      : `Your notes are now the ${summary(backup.counts)} from the backup.`, 'info');
  } catch (e) {
    tell('Nothing was imported.', `Reason: ${reason(e)}.\nYour notes are unchanged.`);
  }
}

// Swap in imported data: every note window is rebuilt from it.
function swapData(next) {
  for (const [id, win] of wins) { closing.add(id); win.destroy(); }
  wins.clear();
  data = next;
  hidden = false;
  storage.writeNow(data);
  applyAutoStart();
  data.notes.forEach((n) => openNote(n));
  save();
}

/* ---------- menus & launcher ---------- */
function showMenu(note) {
  const win = wins.get(note.id);
  if (!win || win.isDestroyed()) return;
  const live = () => !win.isDestroyed();
  Menu.buildFromTemplate([
    {
      label: 'Change colour',
      submenu: PALETTE.map((c) => ({
        label: c.name, type: 'radio', checked: c.hex === note.color, icon: nativeImage.createFromBuffer(icon.swatch(c.hex)),
        click: () => { if (!live()) return; note.color = c.hex; win.setBackgroundColor(c.hex); win.webContents.send('color', c.hex); save(); },
      })),
    },
    {
      label: 'Size',
      submenu: SIZES.map((z) => ({ label: `${z.name}  (${z.width} × ${z.height})`, click: () => resizeNote(note, z) })),
    },
    { label: 'History', click: () => showLauncher('history') },
    { type: 'separator' },
    { label: 'Close note', click: () => live() && win.webContents.send('close-request') },
  ]).popup({ window: win });
}

function showLauncher(view = 'home') {
  if (launcher) {
    // still loading: the page reads ?view= itself only on first load, so send once it can listen
    if (launcher.webContents.isLoading()) return launcher.webContents.once('did-finish-load', () => launcher?.webContents.send('view', view));
    launcher.webContents.send('view', view);
    if (launcher.isMinimized()) launcher.restore();
    launcher.show();
    launcher.focus();
    return;
  }
  const at = data.settings.launcher ? onScreen({ ...data.settings.launcher, width: 340, height: 560 }) : {};
  launcher = new BrowserWindow({
    ...at, width: 340, height: 560, resizable: false, maximizable: false, frame: false,
    backgroundColor: '#fbf8f1', show: false, title: APP, icon: appIcon(),
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  launcher.loadFile(path.join(__dirname, '..', 'ui', 'launcher', 'index.html'), { query: { view } });
  launcher.once('ready-to-show', () => launcher.show());
  launcher.on('close', () => { const [x, y] = launcher.getPosition(); data.settings.launcher = { x, y }; storage.save(data); }); // remembered for next time
  launcher.on('session-end', () => { quitting = true; storage.flush(data); });
  launcher.on('closed', () => { launcher = null; });
}

// A portable .exe unpacks itself to a temp folder on every start: Windows must be given the real file.
function applyAutoStart() {
  if (!app.isPackaged) return; // never register the dev electron.exe
  app.setLoginItemSettings({ openAtLogin: !!data.settings.autoStart, path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath, args: ['--hidden'] });
}

function quit() {
  quitting = true;
  storage.flush(data);
  app.quit();
}

/* ---------- IPC ---------- */
const noteOf = (e) => liveNote(BrowserWindow.fromWebContents(e.sender)?.noteId);

ipcMain.handle('init', (e) => {
  const note = noteOf(e);
  return { note, fresh: !!note && fresh.delete(note.id) };
});
ipcMain.on('update', (e, patch) => {
  const note = noteOf(e);
  if (!note || !patch || !Array.isArray(patch.tasks)) return; // closed meanwhile, or not a real update
  note.title = String(patch.title ?? '').slice(0, 80);
  note.tasks = cleanTasks(patch.tasks);
  save();
});
ipcMain.handle('task:delete', (e, taskId) => { const n = noteOf(e); return n ? deleteTask(n, taskId) : null; });
ipcMain.on('history:restore', (e, id) => restoreHistory(id, e.sender === launcher?.webContents));
ipcMain.on('history:delete', (_e, id) => deleteForever(id));
ipcMain.on('menu', (e) => { const n = noteOf(e); if (n) showMenu(n); });
ipcMain.on('close', (e) => { const n = noteOf(e); if (n) closeNote(n); });
ipcMain.handle('pin', (e) => {
  const note = noteOf(e);
  if (!note) return false;
  note.pinned = !note.pinned;
  pinning.apply(wins.get(note.id), note.pinned);
  save();
  return note.pinned;
});
ipcMain.handle('info:open', async (e, taskId) => {
  const t = noteOf(e)?.tasks.find((x) => x.id === taskId);
  if (!t) return null;
  let file;
  try { file = taskfiles.ensure(data, t); } catch (err) {
    tell('Could not open the notes file for this task.', `Reason: ${reason(err)}.`);
    return null;
  }
  save();
  if (await shell.openPath(file)) shell.showItemInFolder(file); // non-empty = no .txt handler
  return { file: t.file, fileTitle: t.fileTitle };
});
ipcMain.handle('info:hints', (e) => taskfiles.hints(noteOf(e) ?? { tasks: [] }));
ipcMain.handle('launcher:state', launcherState);
ipcMain.on('launcher:show', (_e, view) => showLauncher(view));
ipcMain.on('launcher:create', (_e, opts) => { fresh.add(newNote(opts).id); launcher?.close(); });
ipcMain.on('launcher:focus', (_e, id, activate) => focusNote(id, !!activate));
ipcMain.on('launcher:resize', (_e, id, width, height) => {
  const note = liveNote(id);
  if (note) resizeNote(note, { width: clamp(width, ...SIZE.w), height: clamp(height, ...SIZE.h) });
});
ipcMain.on('launcher:export', exportData);
ipcMain.on('launcher:import', importData);
ipcMain.on('launcher:reopen', () => { const e = lastClosed(); if (e) restoreHistory(e.id); });

/* ---------- app ---------- */
// Read the saved notes, or copy them from the old "Note" app on the very first start. Returns false if the app must not start.
function loadData() {
  const dataFile = path.join(DATA_DIR, 'data.json');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    storage.init(DATA_DIR, (e) => tell('Your notes could not be saved.',
      `Reason: ${reason(e)}.\nThe app keeps trying every few seconds. Leave it open until this is fixed, or your latest changes may be lost.`));
    const moved = !storage.exists() && OLD_DIR && fs.existsSync(OLD_DIR) ? migrate.fromNote(OLD_DIR, DATA_DIR) : null;
    if (moved) {
      data = moved.data;
      if (!storage.writeNow(data)) throw new Error('the copied notes could not be saved');
      tell('Your notes were copied from the old Note app.',
        `${data.notes.length} open notes and ${moved.closed} closed notes were copied to:\n${DATA_DIR}\n\n`
        + `The old files in ${OLD_DIR} were not changed.${moved.skipped ? ` ${moved.skipped} damaged archive files were left there.` : ''}\n\n`
        + 'If the old Note app is still installed, quit and uninstall it: the two apps do not share notes.', 'info');
      return true;
    }
    const r = storage.load();
    data = r.data;
    if (r.recovered || r.lost) {
      tell(r.lost ? 'Your saved notes could not be read, and no backup could be read either.'
        : 'Your saved notes were damaged, so the latest backup was loaded.',
      r.lost ? `The app starts empty. The damaged file was kept in:\n${DATA_DIR}` : `Backup used: ${r.recovered}. Changes made after that backup are missing.`);
      storage.writeNow(data);
    }
    return true;
  } catch (e) {
    dialog.showErrorBox(APP, e.code === 'NEWER_SCHEMA'
      ? `Your notes were saved by a newer version of ${APP}.\n\nDownload the latest version to open them. Nothing was changed.`
      : `Could not open your notes in:\n${dataFile}\n\nReason: ${reason(e)}.\n\n`
        + 'Another program (antivirus, OneDrive, a backup tool) may be holding the file. Close it and start the app again. Nothing was changed.');
    return false;
  }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.setAppUserModelId('local.stickynotes.app');
  app.on('second-instance', () => { if (data) showLauncher(); });
  app.whenReady().then(() => {
    if (!loadData()) return app.exit(1);
    taskfiles.init(path.join(DATA_DIR, 'tasks'));
    if (taskfiles.renamePending(data)) save();
    applyAutoStart();

    tray.create({
      launcher: showLauncher,
      newNote: () => showLauncher('setup'),
      toggleHidden,
      focus: focusNote,
      reopen: () => { const e = lastClosed(); if (e) restoreHistory(e.id); },
      exportData,
      importData,
      openTxt: () => shell.openPath(taskfiles.dir()),
      openData: () => shell.openPath(DATA_DIR),
      toggleAutoStart: () => { data.settings.autoStart = !data.settings.autoStart; applyAutoStart(); save(); },
      quit,
    }, app.isPackaged);
    tray.refresh(trayModel);

    data.notes.forEach((n) => openNote(n));
    screen.on('display-removed', rescueAll);
    screen.on('display-metrics-changed', rescueAll);
    // auto-start is quiet; a manual start with nothing open shows the launcher so it isn't invisible
    if (!data.notes.length && !process.argv.includes('--hidden')) showLauncher();
  });
  app.on('before-quit', () => { quitting = true; storage.flush(data); });
  app.on('window-all-closed', () => {}); // keep running in the tray; only Quit exits
}
