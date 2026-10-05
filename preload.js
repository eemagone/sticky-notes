const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // note window
  init: () => ipcRenderer.invoke('init'),
  update: (patch) => ipcRenderer.send('update', patch),
  menu: () => ipcRenderer.send('menu'),
  close: () => ipcRenderer.send('close'),
  pin: () => ipcRenderer.invoke('pin'),
  openInfo: (taskId) => ipcRenderer.invoke('info:open', taskId),
  hints: () => ipcRenderer.invoke('info:hints'),
  onColor: (fn) => ipcRenderer.on('color', (_e, hex) => fn(hex)),
  onRestoreTask: (fn) => ipcRenderer.on('restore-task', (_e, id) => fn(id)),
  // launcher window
  launcher: {
    state: () => ipcRenderer.invoke('launcher:state'),
    create: (opts) => ipcRenderer.send('launcher:create', opts),
    focus: (id) => ipcRenderer.send('launcher:focus', id),
    restore: (zip) => ipcRenderer.send('launcher:restore', zip),
    reopen: () => ipcRenderer.send('launcher:reopen'),
    openArchive: () => ipcRenderer.send('launcher:openArchive'),
    onView: (fn) => ipcRenderer.on('view', (_e, v) => fn(v)),
    onState: (fn) => ipcRenderer.on('state', (_e, s) => fn(s)),
  },
});
