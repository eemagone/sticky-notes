const { Tray, Menu, nativeImage } = require('electron');
const icon = require('./icon');

let tray, actions, packaged, timer;

function create(handlers, isPackaged) {
  actions = handlers;
  packaged = isPackaged;
  const img = nativeImage.createFromBuffer(icon.noteIcon(32), { scaleFactor: 2 });
  tray = new Tray(img);
  tray.setToolTip('Sticky Notes');
  tray.on('click', () => actions.launcher());
}

function build(m) {
  const a = actions;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'New note', click: a.newNote },
    { label: m.hidden ? 'Show all notes' : 'Hide all notes', click: a.toggleHidden, enabled: m.notes.length > 0 },
    { type: 'separator' },
    ...(m.notes.length
      ? m.notes.map((n) => ({
        label: n.title || 'Untitled', icon: nativeImage.createFromBuffer(icon.swatch(n.color)), click: () => a.focus(n.id),
      }))
      : [{ label: 'No open notes', enabled: false }]),
    { type: 'separator' },
    { label: 'Reopen last closed note', click: a.reopen, enabled: m.canReopen },
    { label: 'History', click: () => a.launcher('history') },
    { type: 'separator' },
    { label: 'Export backup…', click: a.exportData },
    { label: 'Import backup…', click: a.importData },
    { type: 'separator' },
    { label: 'Open notes folder (.txt)', click: a.openTxt },
    { label: 'Open data folder', click: a.openData },
    { label: 'Start with Windows', type: 'checkbox', checked: m.autoStart, enabled: packaged, click: a.toggleAutoStart },
    { type: 'separator' },
    { label: 'Quit', click: a.quit },
  ]));
}

// Debounced: called on every saved change (e.g. typing a title)
function refresh(model) {
  if (!tray) return;
  clearTimeout(timer);
  timer = setTimeout(() => build(model()), 200);
}

module.exports = { create, refresh };
