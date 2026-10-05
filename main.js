const { app, BrowserWindow, ipcMain, Menu, screen, Notification, shell, nativeImage } = require('electron');
const path = require('path');
const storage = require('./storage');
const taskfiles = require('./taskfiles');
const archive = require('./archive');
const pinning = require('./pinning');
const tray = require('./tray');
const icon = require('./icon');

const PALETTE = [
  { name: 'Yellow', hex: '#fff3a8' },
  { name: 'Pink', hex: '#ffd3df' },
  { name: 'Mint', hex: '#cdf3dc' },
  { name: 'Sky', hex: '#d1e6ff' },
  { name: 'Lavender', hex: '#e3d9ff' },
  { name: 'Peach', hex: '#ffddc2' },
  { name: 'Lime', hex: '#e6f4c0' },
  { name: 'Aqua', hex: '#c9f0ee' },
];
const RAISE_MS = 4000;

let data;
let launcher = null;
let quitting = false;
let hidden = false;
let archived = []; // cached archive.list()
const wins = new Map(); // noteId -> BrowserWindow
const fresh = new Set(); // new notes that still need their first empty task
const archiving = new Set(); // noteIds whose window is closing on purpose
const appIcon = () => nativeImage.createFromBuffer(icon.noteIcon(64));
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(+v) || lo));
const noteList = () => data.notes.map(({ id, title, color }) => ({ id, title, color }));
const launcherState = () => ({ palette: PALETTE, notes: noteList(), archived, lastClosed: !!data.lastClosed });
const trayModel = () => ({
  notes: noteList(), hidden, archived, lastClosed: !!data.lastClosed,
  autoStart: data.settings.autoStart, packaged: app.isPackaged,
});
const save = () => {
  storage.save(data);
  launcher?.webContents.send('state', launcherState());
  tray.refresh(trayModel);
};

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
    ...note.bounds, minWidth: 200, minHeight: 160, maxWidth: 800, maxHeight: 1000,
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
  const track = () => { if (!win.isDestroyed()) { note.bounds = win.getBounds(); save(); } };
  win.once('ready-to-show', () => {
    if (focus) win.show(); else win.showInactive(); // restoring at login must not steal focus
    pinning.apply(win, note.pinned);
    if (hidden && !focus) win.hide();
    track();
  });
  win.on('moved', track);
  win.on('resized', track);
  win.on('session-end', () => { quitting = true; storage.flush(data); }); // Windows shutdown/logoff
  win.on('system-context-menu', (e) => { e.preventDefault(); showMenu(note); }); // right-click on drag area
  win.on('closed', () => {
    wins.delete(note.id);
    // closed by something else (e.g. Explorer restart destroys desktop-owned windows): bring it back
    if (!quitting && !archiving.delete(note.id) && data.notes.includes(note)) setTimeout(() => openNote(note), 1500);
  });
  win.loadFile(path.join(__dirname, 'note', 'index.html'));
}

function newNote({ width = 300, height = 360, color } = {}) {
  const note = {
    id: newId(), title: '', pinned: false, tasks: [], deleted: [],
    color: PALETTE.some((c) => c.hex === color) ? color : PALETTE[0].hex,
    bounds: { width: clamp(width, 200, 600), height: clamp(height, 160, 800) },
  };
  data.notes.push(note);
  fresh.add(note.id);
  save();
  openNote(note, { focus: true });
}

function focusNote(id) {
  const note = data.notes.find((n) => n.id === id);
  const win = wins.get(id);
  if (!note || !win) return;
  if (note.pinned) return pinning.raise(win, RAISE_MS, () => note.pinned);
  win.show();
  win.focus();
}

function toggleHidden() {
  hidden = !hidden;
  for (const [id, win] of wins) {
    if (hidden) win.hide();
    else { win.showInactive(); pinning.apply(win, data.notes.find((n) => n.id === id).pinned); }
  }
  save();
}

/* ---------- archive ---------- */
function archiveNote(note) {
  let zip;
  try {
    zip = archive.archive(note); // fully written + verified before the note leaves live data
  } catch (e) {
    new Notification({ title: 'Note', body: `Could not archive "${note.title || 'Untitled'}": ${e.message}. The note was kept.` }).show();
    return;
  }
  data.notes = data.notes.filter((n) => n !== note);
  data.lastClosed = zip;
  storage.writeNow(data);
  archived = archive.list();
  archiving.add(note.id);
  wins.get(note.id)?.close();
  save();
}

function restoreZip(zip) {
  const linked = new Set(data.notes.flatMap((n) => [...n.tasks, ...n.deleted.map((d) => d.task)])
    .filter((t) => t.file).map((t) => t.file.toLowerCase()));
  let note;
  try {
    note = archive.restore(zip, data.notes.map((n) => n.id), (name) => linked.has(name.toLowerCase()), newId);
  } catch (e) {
    new Notification({ title: 'Note', body: `Could not restore ${zip}: ${e.message}` }).show();
    return;
  }
  data.notes.push(note);
  if (data.lastClosed === zip) data.lastClosed = null;
  save();
  openNote(note, { focus: true });
}

/* ---------- menus & launcher ---------- */
function showMenu(note) {
  const win = wins.get(note.id);
  const deleted = [...note.deleted].reverse().slice(0, 15);
  const short = (s) => (s.length > 40 ? `${s.slice(0, 40)}…` : s);
  Menu.buildFromTemplate([
    {
      label: 'Change colour',
      submenu: PALETTE.map((c) => ({
        label: c.name, type: 'radio', checked: c.hex === note.color, icon: nativeImage.createFromBuffer(icon.swatch(c.hex)),
        click: () => { note.color = c.hex; win.setBackgroundColor(c.hex); win.webContents.send('color', c.hex); save(); },
      })),
    },
    {
      label: 'Recently deleted tasks',
      submenu: deleted.length
        ? deleted.map((d) => ({ label: `Restore “${short(d.task.text)}”`, click: () => win.webContents.send('restore-task', d.task.id) }))
        : [{ label: 'Nothing deleted', enabled: false }],
    },
    { type: 'separator' },
    { label: 'Delete note', click: () => archiveNote(note) },
  ]).popup({ window: win });
}

function showLauncher(view = 'home') {
  if (launcher) {
    launcher.webContents.send('view', view);
    if (launcher.isMinimized()) launcher.restore();
    launcher.show();
    launcher.focus();
    return;
  }
  launcher = new BrowserWindow({
    width: 340, height: 560, resizable: false, maximizable: false, frame: false,
    backgroundColor: '#fbf8f1', show: false, title: 'Sticky notes', icon: appIcon(),
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  launcher.loadFile(path.join(__dirname, 'launcher', 'index.html'), { query: { view } });
  launcher.once('ready-to-show', () => launcher.show());
  launcher.on('closed', () => { launcher = null; });
}

function applyAutoStart() {
  if (!app.isPackaged) return; // never register the dev electron.exe
  app.setLoginItemSettings({ openAtLogin: !!data.settings.autoStart, args: ['--hidden'] });
}

function quit() {
  quitting = true;
  storage.flush(data);
  app.quit();
}

/* ---------- IPC ---------- */
const noteOf = (e) => data.notes.find((n) => n.id === BrowserWindow.fromWebContents(e.sender)?.noteId);

ipcMain.handle('init', (e) => {
  const note = noteOf(e);
  return { palette: PALETTE, note, fresh: fresh.delete(note.id) };
});
ipcMain.on('update', (e, patch) => {
  const note = noteOf(e);
  if (!note) return; // archived meanwhile
  ({ title: note.title, tasks: note.tasks, deleted: note.deleted } = patch);
  save();
});
ipcMain.on('menu', (e) => { const n = noteOf(e); if (n) showMenu(n); });
ipcMain.on('close', (e) => { const n = noteOf(e); if (n) archiveNote(n); });
ipcMain.handle('pin', (e) => {
  const note = noteOf(e);
  note.pinned = !note.pinned;
  pinning.apply(wins.get(note.id), note.pinned);
  save();
  return note.pinned;
});
ipcMain.handle('info:open', async (e, taskId) => {
  const t = noteOf(e)?.tasks.find((x) => x.id === taskId);
  if (!t) return null;
  const file = taskfiles.ensure(data, t);
  save();
  if (await shell.openPath(file)) shell.showItemInFolder(file); // non-empty = no .txt handler
  return { file: t.file, fileTitle: t.fileTitle };
});
ipcMain.handle('info:hints', (e) => taskfiles.hints(noteOf(e)));
ipcMain.handle('launcher:state', launcherState);
ipcMain.on('launcher:create', (_e, opts) => { newNote(opts); launcher?.close(); });
ipcMain.on('launcher:focus', (_e, id) => focusNote(id));
ipcMain.on('launcher:restore', (_e, zip) => restoreZip(zip));
ipcMain.on('launcher:reopen', () => data.lastClosed && restoreZip(data.lastClosed));
ipcMain.on('launcher:openArchive', () => shell.openPath(archive.dir()));

/* ---------- app ---------- */
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.setAppUserModelId('local.note.app');
  app.on('second-instance', () => showLauncher());
  app.whenReady().then(() => {
    const userData = app.getPath('userData');
    storage.init(userData);
    const r = storage.load();
    data = r.data;
    data.settings ||= { autoStart: true };
    if (r.recovered || r.lost) {
      new Notification({
        title: 'Note',
        body: r.lost ? 'Saved notes were unreadable and no backup worked. The bad file was kept in the data folder.'
          : `Saved notes were damaged, so they were restored from backup (${r.recovered}).`,
      }).show();
      storage.writeNow(data);
    }
    taskfiles.init(path.join(userData, 'tasks'));
    archive.init(path.join(userData, 'archive'), path.join(userData, 'tasks'));
    archived = archive.list();
    if (taskfiles.renamePending(data)) save();
    applyAutoStart();

    tray.create({
      launcher: () => showLauncher(),
      newNote: () => showLauncher('setup'),
      toggleHidden,
      focus: focusNote,
      reopen: () => data.lastClosed && restoreZip(data.lastClosed),
      restore: restoreZip,
      openArchive: () => shell.openPath(archive.dir()),
      openTxt: () => shell.openPath(taskfiles.dir()),
      openData: () => shell.openPath(userData),
      toggleAutoStart: () => { data.settings.autoStart = !data.settings.autoStart; applyAutoStart(); save(); },
      quit,
    });
    tray.refresh(trayModel);

    data.notes.forEach((n) => openNote(n));
    // auto-start is quiet; a manual start with nothing open shows the launcher so it isn't invisible
    if (!data.notes.length && !process.argv.includes('--hidden')) showLauncher();
  });
  app.on('before-quit', () => { quitting = true; storage.flush(data); });
  app.on('window-all-closed', () => {}); // keep running in the tray; only Quit exits
}
