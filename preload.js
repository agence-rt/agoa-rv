"use strict";
// Pont sécurisé entre l'interface (app/index.html) et Windows
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agoa", {
  native: true,
  info: () => ipcRenderer.sendSync("info"),
  loadData: () => ipcRenderer.sendSync("load-data"),
  saveData: text => ipcRenderer.send("save-data", text),
  getConfig: () => ipcRenderer.sendSync("get-config"),
  setConfig: patch => ipcRenderer.sendSync("set-config", patch),
  ragic: (tool, input) => ipcRenderer.invoke("ragic", tool, input),
  saveFile: (filename, bytes) => ipcRenderer.invoke("save-file", filename, bytes),
  savePDF: filename => ipcRenderer.invoke("save-pdf", filename),
  checkUpdates: () => ipcRenderer.invoke("check-updates"),
  onOpenFile: cb => ipcRenderer.on("open-file", (e, name, text) => cb(name, text))
});
