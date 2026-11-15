const { app, BrowserWindow, ipcMain, Menu, screen, shell, nativeImage, nativeTheme, dialog, globalShortcut } = require('electron');
const fs = require('fs');
const path = require('path');
const { PALETTE, cleanTasks, makeNote } = require('../models/model');
const history = require('../models/history');
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
const MIGRATED = path.join(app.getPath('userData'), 'migrated-from-note'); // outside the data folder: deleting your data never brings the old notes back

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
const LAUNCHER = { width: 340, height: 560 };

let data;
let launcher = null;
let quitting = false;
let hidden = false;
let hotkeysOk = true;
const wins = new Map(); // noteId -> BrowserWindow
const fresh = new Set(); // new notes that still need their first empty task
const closing = new Set(); // noteIds whose window is closing on purpose
const appIcon = () => nativeImage.createFromBuffer(icon.noteIcon(64));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(+v) || lo));
const liveNote = (id) => data.notes.find((n) => n.id === id);
const noteList = () => data.notes.map(({ id, title, color, bounds }) => ({ id, title, color, width: bounds.width, height: bounds.height }));
const launcherState = () => ({
  palette: PALETTE, limits: SIZE, notes: noteList(), history: history.items(data), canReopen: !!history.lastClosed(data),
  settings: data.settings, packaged: app.isPackaged, hotkeys: Object.keys(HOTKEYS), hotkeysOk,
});
const trayModel = () => ({ notes: noteList(), hidden, canReopen: !!history.lastClosed(data), autoStart: data.settings.autoStart });
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
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

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

function newNote({ width, height, color } = {}) {
  const note = makeNote({ color, width: clamp(width, ...SIZE.w), height: clamp(height, ...SIZE.h) });
  data.notes.push(note);
  fresh.add(note.id);
  save();
  if (hidden) toggleHidden();
  openNote(note, { focus: true });
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

/* ---------- history (rules are in models/history.js; this part moves the windows and files) ---------- */
// Tell an open note window about a task the main process changed. A window that is still loading reads it from init.
function sync({ noteId, op }) {
  const win = wins.get(noteId);
  if (win && !win.isDestroyed() && !win.webContents.isLoading()) win.webContents.send('sync', op);
}

function closeNote(note) {
  if (!history.closeNote(data, note)) return; // menu and × racing
  storage.writeNow(data);
  closing.add(note.id);
  if (!data.notes.length) hidden = false;
  wins.get(note.id)?.close();
  save();
}

// show: bring the note forward (asked from the launcher); an Undo inside the note leaves the windows alone
function restoreHistory(id, show = true) {
  const r = history.restore(data, id);
  if (!r) return;
  if (r.open.length && hidden) toggleHidden();
  r.open.forEach((n) => openNote(n, { focus: true }));
  if (r.sync) sync(r.sync);
  if (show) focusNote(r.focus);
  save();
}

function deleteForever(ids) {
  const what = history.describe(data, ids);
  if (!what.names.length) return;
  const one = what.names[0].length > 60 ? `${what.names[0].slice(0, 60)}…` : what.names[0];
  const files = what.tasks.filter((t) => t.file).length;
  const choice = dialog.showMessageBoxSync(launcher, {
    type: 'warning', title: APP, noLink: true, buttons: ['Delete permanently', 'Cancel'], defaultId: 1, cancelId: 1,
    message: what.names.length === 1 ? `Delete “${one}” permanently?` : `Delete ${what.names.length} items permanently?`,
    detail: `${what.notes ? `${plural(what.notes, 'closed note')} with all tasks. ` : ''}`
      + `${files ? `${plural(files, 'notes file')} (.txt) will be deleted too. ` : ''}This cannot be undone.`,
  });
  if (choice !== 0) return;
  const gone = history.forget(data, ids);
  gone.syncs.forEach(sync);
  try { taskfiles.remove(data, gone.tasks); } catch (e) {
    tell('The items were deleted, but a notes file could not be removed.', `Reason: ${reason(e)}.\nYou can delete it yourself in the notes folder (tray icon → Open notes folder).`);
  }
  save();
}

/* ---------- export / import ---------- */
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
    detail: 'Merge adds the notes, tasks and history items you do not have yet. Nothing you have now is changed.\n\n'
      + 'Replace swaps everything you have now for the backup.\n\nEither way, a backup of your current notes is made first.',
  });
  if (response === 2) return;
  try {
    if (!storage.writeNow(data)) throw new Error('your current notes could not be saved first');
    storage.backup('before-import');
    const r = transfer.apply(data, backup, response === 0 ? 'merge' : 'replace', taskfiles.dir());
    swapData(r.data);
    tell('Import finished.', response === 0 ? `Added ${plural(r.added.notes, 'note')}, ${plural(r.added.tasks, 'task')} on notes you already had, and ${plural(r.added.history, 'history item')}.`
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
  applySettings();
  data.notes.forEach((n) => openNote(n));
  save();
}

// The task .txt files are edited outside the app, so they get their own daily zip next to the data backups.
let backupFailed = false;
function backupTasks() {
  try { transfer.backupTasks(taskfiles.dir(), path.join(DATA_DIR, 'backups')); } catch (e) {
    if (!backupFailed) tell('The daily backup of your notes files could not be made.', `Reason: ${reason(e)}.\nYour notes are fine; only the extra copy is missing.`);
    backupFailed = true; // said once per run
  }
}

/* ---------- settings ---------- */
const HOTKEYS = { // work from any program, while the app runs
  'Alt+Shift+N': () => showLauncher('setup'),
  'Alt+Shift+H': () => { if (data.notes.length) toggleHidden(); },
};

function applySettings() {
  // A portable .exe unpacks itself to a temp folder on every start: Windows must be given the real file. Never register the dev electron.exe.
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!data.settings.autoStart, path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath, args: ['--hidden'] });
  globalShortcut.unregisterAll();
  hotkeysOk = !data.settings.hotkeys || Object.entries(HOTKEYS).map(([keys, run]) => globalShortcut.register(keys, run)).every(Boolean); // false: another program owns one
  for (const win of wins.values()) if (!win.isDestroyed()) win.webContents.send('spellcheck', data.settings.spellcheck);
}

function setSetting(key, value) {
  if (!['autoStart', 'spellcheck', 'hotkeys'].includes(key)) return;
  data.settings[key] = !!value;
  applySettings();
  save();
}

/* ---------- menus & launcher ---------- */
function showMenu(note) {
  const win = wins.get(note.id);
  if (!win || win.isDestroyed()) return;
  const live = () => !win.isDestroyed();
  const ask = (channel) => () => live() && win.webContents.send(channel);
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
    { label: 'Clear completed tasks', enabled: note.tasks.some((t) => t.done), click: ask('clear-request') },
    { label: 'History', click: () => showLauncher('history') },
    { type: 'separator' },
    { label: 'Close note', click: ask('close-request') },
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
  const at = data.settings.launcher ? onScreen({ ...LAUNCHER, ...data.settings.launcher }) : LAUNCHER;
  launcher = new BrowserWindow({
    ...at, minWidth: LAUNCHER.width, minHeight: 400, maxWidth: 560, maximizable: false, frame: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1f1d1a' : '#fbf8f1', show: false, title: APP, icon: appIcon(),
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  launcher.loadFile(path.join(__dirname, '..', 'ui', 'launcher', 'index.html'), { query: { view } });
  launcher.once('ready-to-show', () => launcher.show());
  launcher.on('close', () => { data.settings.launcher = launcher.getBounds(); storage.save(data); }); // size and place remembered for next time
  launcher.on('session-end', () => { quitting = true; storage.flush(data); });
  launcher.on('closed', () => { launcher = null; });
}

function quit() {
  quitting = true;
  storage.flush(data);
  app.quit();
}

/* ---------- IPC ---------- */
const noteOf = (e) => liveNote(BrowserWindow.fromWebContents(e.sender)?.noteId);
const changed = (result) => { save(); return result; };

ipcMain.handle('init', (e) => {
  const note = noteOf(e);
  return { note, fresh: !!note && fresh.delete(note.id), spellcheck: data.settings.spellcheck };
});
ipcMain.on('update', (e, patch) => {
  const note = noteOf(e);
  if (!note || !patch || !Array.isArray(patch.tasks)) return; // closed meanwhile, or not a real update
  note.title = String(patch.title ?? '').slice(0, 80);
  note.tasks = cleanTasks(patch.tasks);
  save();
});
// the note window has already dropped these tasks from its own list; the ids returned are for Undo
ipcMain.handle('task:delete', (e, taskId) => { const n = noteOf(e); return n ? changed(history.deleteTask(data, n, taskId)) : null; });
ipcMain.handle('task:clearDone', (e) => { const n = noteOf(e); return n ? changed(history.clearDone(data, n)) : []; });
ipcMain.on('history:restore', (e, id) => restoreHistory(id, e.sender === launcher?.webContents));
ipcMain.on('history:delete', (_e, ids) => deleteForever([].concat(ids).map(String)));
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
ipcMain.on('launcher:create', (_e, opts) => { newNote(opts); launcher?.close(); });
ipcMain.on('launcher:focus', (_e, id, activate) => focusNote(id, !!activate));
ipcMain.on('launcher:resize', (_e, id, width, height) => {
  const note = liveNote(id);
  if (note) resizeNote(note, { width: clamp(width, ...SIZE.w), height: clamp(height, ...SIZE.h) });
});
const reopen = () => { const e = history.lastClosed(data); if (e) restoreHistory(e.id); };
ipcMain.on('launcher:reopen', reopen);
ipcMain.on('launcher:export', exportData);
ipcMain.on('launcher:import', importData);
ipcMain.on('launcher:setting', (_e, key, value) => setSetting(key, value));
ipcMain.on('launcher:openData', () => shell.openPath(DATA_DIR));
ipcMain.on('launcher:quit', quit);

/* ---------- app ---------- */
// Read the saved notes, or copy them from the old "Note" app on the very first start. Returns false if the app must not start.
function loadData() {
  const dataFile = path.join(DATA_DIR, 'data.json');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    storage.init(DATA_DIR, (e) => tell('Your notes could not be saved.',
      `Reason: ${reason(e)}.\nThe app keeps trying every few seconds. Leave it open until this is fixed, or your latest changes may be lost.`));
    const first = !storage.exists() && !fs.existsSync(MIGRATED) && OLD_DIR && fs.existsSync(OLD_DIR);
    const moved = first ? migrate.fromNote(OLD_DIR, DATA_DIR) : null;
    if (moved) {
      data = moved.data;
      if (!storage.writeNow(data)) throw new Error('the copied notes could not be saved');
      fs.mkdirSync(path.dirname(MIGRATED), { recursive: true });
      fs.writeFileSync(MIGRATED, new Date().toISOString());
      tell('Your notes were copied from the old Note app.',
        `${plural(data.notes.length, 'open note')} and ${plural(moved.closed, 'closed note')} were copied to:\n${DATA_DIR}\n\n`
        + `The old files in ${OLD_DIR} were not changed.${moved.skipped ? ` ${plural(moved.skipped, 'damaged archive file')} stayed there.` : ''}\n\n`
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

Menu.setApplicationMenu(null); // no hidden menu: its shortcuts would reload (Ctrl+R) or zoom (Ctrl+-) a note
// A window only ever shows its own page: a file dropped on a note, or any link, must not replace it.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (e) => e.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.setAppUserModelId('local.stickynotes.app');
  app.on('second-instance', () => { if (data) showLauncher(); });
  app.whenReady().then(() => {
    if (!loadData()) return app.exit(1);
    taskfiles.init(path.join(DATA_DIR, 'tasks'));
    if (taskfiles.renamePending(data)) save();
    applySettings();
    backupTasks();
    setInterval(backupTasks, 6 * 3600 * 1000); // the app runs for weeks; the check itself makes at most one zip a day

    tray.create({
      launcher: showLauncher,
      newNote: () => showLauncher('setup'),
      toggleHidden,
      focus: focusNote,
      reopen,
      exportData,
      importData,
      openTxt: () => shell.openPath(taskfiles.dir()),
      openData: () => shell.openPath(DATA_DIR),
      toggleAutoStart: () => setSetting('autoStart', !data.settings.autoStart),
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
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => {}); // keep running in the tray; only Quit exits
}
