"use strict";
// AGOA RV — processus principal Electron
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require("electron");
const path = require("path");
const fs = require("fs");

const pkg = require("./package.json");
const INFO = { version: pkg.version, deploiement: (pkg.agoa && pkg.agoa.deploiement) || 0 };

let win = null;
let pendingFile = null; // fichier .agoarv à ouvrir dès que l'interface est prête
let ready = false;

/* ---------- fichiers de données (dans %APPDATA%\AGOA RV) ---------- */
const userDir = () => app.getPath("userData");
const dataPath = () => path.join(userDir(), "agoa-rv-donnees.json");
const configPath = () => path.join(userDir(), "agoa-rv-config.json");

function readJson(p, def) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return def; } }
function writeAtomic(p, text) {
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, text, "utf8");
  if (fs.existsSync(p)) fs.copyFileSync(p, p + ".bak"); // copie de secours de la version précédente
  fs.renameSync(tmp, p);
}

/* ---------- ouverture d'un .agoarv passé en argument (double-clic) ---------- */
function agoarvFromArgs(argv) { return argv.find(a => /\.agoarv$/i.test(a) && fs.existsSync(a)) || null; }
function openAgoarv(file) {
  if (!file) return;
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { dialog.showErrorBox("AGOA RV", "Impossible de lire " + file); return; }
  if (win && ready) win.webContents.send("open-file", path.basename(file), text);
  else pendingFile = { name: path.basename(file), text };
}

/* ---------- API Ragic (HTTP) ---------- */
function ragicCfg() {
  const c = readJson(configPath(), {});
  if (!c.ragicKey) throw new Error("[no_key] Clé API Ragic manquante");
  return { host: (c.ragicHost || "https://eu2.ragic.com").replace(/\/+$/, ""), key: c.ragicKey };
}
async function ragicGet(url, key) {
  let r;
  try { r = await fetch(url, { headers: { Authorization: "Basic " + key } }); }
  catch (e) { throw new Error("[network] " + e.message); }
  if (r.status === 401 || r.status === 403) throw new Error("[auth] Accès refusé par Ragic");
  if (!r.ok) throw new Error("[tool_error] Ragic HTTP " + r.status);
  const j = await r.json();
  if (j && j.status === "ERROR") throw new Error("[tool_error] " + (j.msg || "Erreur Ragic"));
  return j;
}
function whereParams(filters) {
  return Object.entries(filters || {}).map(([fid, f]) => {
    const op = f && f.op === "like" ? "like" : "eq";
    return "&where=" + encodeURIComponent(`${fid},${op},${f.value}`);
  }).join("");
}
const toList = obj => Object.entries(obj || {}).filter(([k]) => /^\d+$/.test(k)).map(([id, rec]) => ({ id: Number(id), rec }));

async function ragic(tool, input) {
  const { host, key } = ragicCfg();
  const base = `${host}/${input.apname}${input.sheet_id}`;
  if (tool === "list_page") {
    const j = await ragicGet(`${base}?api&v=3&limit=${input.limit || 25}${whereParams(input.filters)}`, key);
    return { records: toList(j).map(x => ({ record_id: x.id, ...x.rec })) };
  }
  if (tool === "get_records") {
    if (input.record_id != null) {
      const ids = [].concat(input.record_id);
      const out = [];
      for (const id of ids) { const j = await ragicGet(`${base}/${id}?api&v=3`, key); const rec = j[String(id)] || Object.values(j)[0]; if (rec) out.push({ record_id: id, record: rec }); }
      return { records: out };
    }
    const j = await ragicGet(`${base}?api&v=3&limit=${input.count || 50}${whereParams(input.filters)}`, key);
    return { records: toList(j).map(x => ({ record_id: x.id, record: x.rec })) };
  }
  throw new Error("[tool_error] Outil inconnu : " + tool);
}

/* ---------- mises à jour ---------- */
let updater = null;
function setupUpdates() {
  if (!app.isPackaged) return;
  try {
    updater = require("electron-updater").autoUpdater;
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.on("update-downloaded", info => {
      dialog.showMessageBox(win, {
        type: "info", buttons: ["Redémarrer maintenant", "Plus tard"], defaultId: 0,
        title: "Mise à jour AGOA RV", message: `La version ${info.version} est prête.`,
        detail: "Elle s'installera au redémarrage de l'application. Vos dossiers ne sont pas modifiés."
      }).then(r => { if (r.response === 0) updater.quitAndInstall(); });
    });
    updater.checkForUpdates().catch(() => {});
  } catch (e) { console.warn(e); }
}

/* ---------- fenêtre ---------- */
function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    title: `AGOA RV — v${INFO.version}`, icon: path.join(__dirname, "build", "icon.ico"),
    autoHideMenuBar: true, backgroundColor: "#EEF0ED",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^(https?|mailto):/i.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith("file:")) { e.preventDefault(); if (/^(https?|mailto):/i.test(url)) shell.openExternal(url); } });
  win.webContents.on("did-finish-load", () => { ready = true; if (pendingFile) { win.webContents.send("open-file", pendingFile.name, pendingFile.text); pendingFile = null; } });
  win.loadFile(path.join(__dirname, "app", "index.html"));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "Fichier", submenu: [{ role: "quit", label: "Quitter" }] },
    { label: "Affichage", submenu: [{ role: "reload", label: "Recharger" }, { role: "zoomIn", label: "Zoom +" }, { role: "zoomOut", label: "Zoom −" }, { role: "resetZoom", label: "Zoom 100 %" }, { type: "separator" }, { role: "toggleDevTools", label: "Outils de développement" }] },
    { label: "Aide", submenu: [{ label: `AGOA RV v${INFO.version} — déploiement n°${INFO.deploiement}`, enabled: false }] }
  ]));
}

/* ---------- IPC ---------- */
ipcMain.on("info", e => { e.returnValue = INFO; });
ipcMain.on("load-data", e => { e.returnValue = readJson(dataPath(), {}); });
ipcMain.on("save-data", (e, text) => { try { writeAtomic(dataPath(), text); } catch (err) { console.error(err); } });
ipcMain.on("get-config", e => { e.returnValue = readJson(configPath(), {}); });
ipcMain.on("set-config", (e, patch) => { writeAtomic(configPath(), JSON.stringify({ ...readJson(configPath(), {}), ...patch }, null, 2)); e.returnValue = true; });
ipcMain.handle("ragic", (e, tool, input) => ragic(tool, input));
ipcMain.handle("save-file", async (e, filename, bytes) => {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  const names = { agoarv: "Dossier AGOA RV", html: "Page HTML", pdf: "PDF" };
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath("documents"), filename), filters: [{ name: names[ext] || ext.toUpperCase(), extensions: [ext] }, { name: "Tous les fichiers", extensions: ["*"] }] });
  if (r.canceled || !r.filePath) return false;
  fs.writeFileSync(r.filePath, Buffer.from(bytes));
  return true;
});
ipcMain.handle("save-pdf", async (e, filename) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath("documents"), filename), filters: [{ name: "PDF", extensions: ["pdf"] }] });
  if (r.canceled || !r.filePath) return false;
  const pdf = await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
  fs.writeFileSync(r.filePath, pdf);
  shell.openPath(r.filePath);
  return true;
});
ipcMain.handle("check-updates", async () => {
  if (!app.isPackaged || !updater) return "Disponible uniquement dans la version installée.";
  const r = await updater.checkForUpdates();
  const v = r && r.updateInfo && r.updateInfo.version;
  return v && v !== INFO.version ? `Version ${v} en cours de téléchargement…` : `À jour (v${INFO.version}).`;
});

/* ---------- démarrage ---------- */
if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.on("second-instance", (e, argv) => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } openAgoarv(agoarvFromArgs(argv)); });
  app.on("open-file", (e, file) => { e.preventDefault(); openAgoarv(file); });
  app.whenReady().then(() => { createWindow(); openAgoarv(agoarvFromArgs(process.argv)); setupUpdates(); });
  app.on("window-all-closed", () => app.quit());
}
