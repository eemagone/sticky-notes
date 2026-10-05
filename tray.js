const { Tray, Menu, nativeImage } = require('electron');
const icon = require('./icon');

let tray, actions, timer;

function create(handlers) {
  actions = handlers;
  const img = nativeImage.createFromBuffer(icon.noteIcon(32), { scaleFactor: 2 });
  tray = new Tray(img);
  tray.setToolTip('Sticky notes');
  tray.on('click', () => actions.launcher());
}

const fmt = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');

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
    { label: 'Reopen last closed note', click: a.reopen, enabled: m.lastClosed },
    {
      label: 'Archived notes',
      submenu: [
        ...(m.archived.length
          ? m.archived.slice(0, 10).map((z) => ({ label: `Restore “${z.title}”  ·  ${fmt(z.archivedAt)}`, click: () => a.restore(z.zip) }))
          : [{ label: 'Nothing archived yet', enabled: false }]),
        { type: 'separator' },
        { label: 'Show all in launcher…', click: a.launcher },
        { label: 'Open archive folder', click: a.openArchive },
      ],
    },
    { type: 'separator' },
    { label: 'Open txt folder', click: a.openTxt },
    { label: 'Open data folder', click: a.openData },
    { label: m.packaged ? 'Start with PC' : 'Start with PC (installed app only)', type: 'checkbox', checked: m.autoStart, click: a.toggleAutoStart },
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
