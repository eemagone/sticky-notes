const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => ipcRenderer.on(channel, (_e, ...args) => fn(...args));

contextBridge.exposeInMainWorld('api', {
  // note window
  init: () => ipcRenderer.invoke('init'),
  update: (patch) => ipcRenderer.send('update', patch),
  deleteTask: (taskId) => ipcRenderer.invoke('task:delete', taskId),
  menu: () => ipcRenderer.send('menu'),
  close: () => ipcRenderer.send('close'),
  pin: () => ipcRenderer.invoke('pin'),
  openInfo: (taskId) => ipcRenderer.invoke('info:open', taskId),
  hints: () => ipcRenderer.invoke('info:hints'),
  onColor: on('color'),
  onSync: on('sync'),
  onCloseRequest: on('close-request'),
  // both windows
  restore: (historyId) => ipcRenderer.send('history:restore', historyId),
  show: (view) => ipcRenderer.send('launcher:show', view),
  // launcher window
  launcher: {
    state: () => ipcRenderer.invoke('launcher:state'),
    create: (opts) => ipcRenderer.send('launcher:create', opts),
    focus: (id, activate) => ipcRenderer.send('launcher:focus', id, activate),
    resize: (id, width, height) => ipcRenderer.send('launcher:resize', id, width, height),
    reopen: () => ipcRenderer.send('launcher:reopen'),
    deleteForever: (historyId) => ipcRenderer.send('history:delete', historyId),
    onView: on('view'),
    onState: on('state'),
  },
});
