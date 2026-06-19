const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cleaner', {
  listTasks: () => ipcRenderer.invoke('tasks:list'),
  scan: () => ipcRenderer.invoke('tasks:scan'),
  clean: (selectedIds) => ipcRenderer.invoke('tasks:clean', selectedIds)
});
