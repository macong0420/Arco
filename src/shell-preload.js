'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('arco', {
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  onState: callback => { const listener = (_, state) => callback(state); ipcRenderer.on('arco:state', listener); return () => ipcRenderer.removeListener('arco:state', listener); },
  onCapture: callback => { const listener = (_, value) => callback(value); ipcRenderer.on('arco:password-capture', listener); return () => ipcRenderer.removeListener('arco:password-capture', listener); },
  onCommand: callback => { const listener = (_, value) => callback(value); ipcRenderer.on('arco:command', listener); return () => ipcRenderer.removeListener('arco:command', listener); },
  onEditBookmark: callback => ipcRenderer.on('arco:edit-bookmark', (_, value) => callback(value)),
  onEditFolder: callback => ipcRenderer.on('arco:edit-folder', (_, value) => callback(value))
});
