"use strict";
// AGOA PV — processus principal Electron
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require("electron");
const path = require("path");
const fs = require("fs");

const pkg = require("./package.json");
const INFO = { version: pkg.version, deploiement: (pkg.agoa && pkg.agoa.deploiement) || 0 };

let win = null;
let pendingFile = null; // fichier .pv à ouvrir dès que l'interface est prête
let ready = false;
let allowClose = false;   // vrai une fois la fermeture confirmée (ou pendant une mise à jour)
let closing = false;

/* ---------- fichiers de données (dans %APPDATA%\AGOA PV) ---------- */
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

/* ---------- ouverture d'un .pv passé en argument (double-clic) ---------- */
function agoarvFromArgs(argv) { return argv.find(a => /\.(pv|agoarv)$/i.test(a) && fs.existsSync(a)) || null; }
function openAgoarv(file) {
  if (!file) return;
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { dialog.showErrorBox("AGOA PV", "Impossible de lire " + file); return; }
  if (win && ready) win.webContents.send("open-file", path.basename(file), text, file);
  else pendingFile = { name: path.basename(file), text, file };
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

/* ---------- mises à jour (Releases GitHub agence-rt/agoa-rv) ---------- */
let updater = null;
let updateState = "idle"; // idle | checking | proposed | downloading | ready
const notesText = info => {
  const n = info && info.releaseNotes;
  const t = Array.isArray(n) ? n.map(x => x.note || "").join("\n") : (n || "");
  return String(t).replace(/<[^>]+>/g, "").trim();
};
async function proposeUpdate(info) {
  if (updateState === "downloading" || updateState === "ready") return;
  updateState = "proposed";
  const notes = notesText(info);
  const r = await dialog.showMessageBox(win, {
    type: "info", buttons: ["Mettre à jour maintenant", "Plus tard"], defaultId: 0, cancelId: 1, noLink: true,
    title: "Mise à jour disponible",
    message: `AGOA PV ${info.version} est disponible.`,
    detail: `Version installée : ${INFO.version} (déploiement n°${INFO.deploiement}).` + (notes ? `\n\nNouveautés :\n${notes}` : "") +
      "\n\nLa mise à jour se télécharge puis l'application redémarre. Vos dossiers et fichiers .pv ne sont pas modifiés."
  });
  if (r.response !== 0) { updateState = "idle"; return; }
  updateState = "downloading";
  win.setTitle(`AGOA PV — téléchargement de la mise à jour ${info.version}…`);
  updater.downloadUpdate().catch(err => {
    updateState = "idle"; win.setProgressBar(-1); win.setTitle(`AGOA PV — v${INFO.version}`);
    dialog.showErrorBox("Mise à jour", "Le téléchargement a échoué : " + (err && err.message ? err.message : err));
  });
}
function setupUpdates() {
  if (!app.isPackaged) return;
  try {
    updater = require("electron-updater").autoUpdater;
    updater.autoDownload = false;          // on demande d'abord à l'utilisateur
    updater.autoInstallOnAppQuit = false;
    updater.on("update-available", info => { proposeUpdate(info); });
    updater.on("download-progress", p => {
      win.setProgressBar(p.percent / 100);
      win.setTitle(`AGOA PV — téléchargement de la mise à jour… ${Math.round(p.percent)} %`);
    });
    updater.on("update-downloaded", () => {
      updateState = "ready"; win.setProgressBar(-1);
      win.webContents.executeJavaScript("typeof Store !== 'undefined' && Store.flush && Store.flush()").catch(() => {}).finally(() => {
        allowClose = true;
        setTimeout(() => updater.quitAndInstall(true, true), 600); // installation silencieuse puis relance
      });
    });
    updater.on("error", err => { console.warn("Mise à jour :", err && err.message); if (updateState === "checking") updateState = "idle"; });
    // Recherche au lancement, une fois la fenêtre affichée
    win.webContents.once("did-finish-load", () => setTimeout(() => { updateState = "checking"; updater.checkForUpdates().catch(() => { updateState = "idle"; }); }, 2500));
  } catch (e) { console.warn(e); }
}

/* ---------- écran de démarrage ---------- */
let splash = null, splashAt = 0;
function showSplash() {
  splash = new BrowserWindow({ width: 520, height: 330, frame: false, resizable: false, movable: true, center: true, show: false,
    skipTaskbar: true, alwaysOnTop: true, backgroundColor: "#FFFFFF", icon: path.join(__dirname, "build", "icon.ico"),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  splash.loadFile(path.join(__dirname, "app", "splash.html"), { query: { v: INFO.version, d: String(INFO.deploiement) } });
  splash.once("ready-to-show", () => { splash.show(); splashAt = Date.now(); });
}
let revealed = false;
function revealMain() {
  if (revealed) return; revealed = true;
  const wait = Math.max(0, 1800 - (Date.now() - (splashAt || Date.now()))); // le logo reste au moins 1,8 s
  setTimeout(() => {
    if (win && !win.isDestroyed()) { win.show(); win.focus(); }
    if (splash && !splash.isDestroyed()) splash.close();
    splash = null;
  }, wait);
}

/* ---------- fenêtre ---------- */
function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    title: `AGOA PV — v${INFO.version}`, icon: path.join(__dirname, "build", "icon.ico"),
    autoHideMenuBar: true, backgroundColor: "#EEF0ED", show: false,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^(https?|mailto):/i.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith("file:")) { e.preventDefault(); if (/^(https?|mailto):/i.test(url)) shell.openExternal(url); } });
  win.once("ready-to-show", revealMain);
  setTimeout(revealMain, 8000); // sécurité : la fenêtre s'affiche quoi qu'il arrive
  win.webContents.on("did-finish-load", () => { ready = true; if (pendingFile) { win.webContents.send("open-file", pendingFile.name, pendingFile.text, pendingFile.file); pendingFile = null; } });
  win.on("close", e => {
    if (allowClose) return;
    e.preventDefault();
    if (!closing) confirmClose();
  });
  win.loadFile(path.join(__dirname, "app", "index.html"));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "Fichier", submenu: [{ role: "quit", label: "Quitter" }] },
    { label: "Affichage", submenu: [{ role: "reload", label: "Recharger" }, { role: "zoomIn", label: "Zoom +" }, { role: "zoomOut", label: "Zoom −" }, { role: "resetZoom", label: "Zoom 100 %" }, { type: "separator" }, { role: "toggleDevTools", label: "Outils de développement" }] },
    { label: "Aide", submenu: [{ label: `AGOA PV v${INFO.version} — déploiement n°${INFO.deploiement}`, enabled: false }] }
  ]));
}

/* ---------- confirmation de fermeture ---------- */
const js = code => win.webContents.executeJavaScript(code, true);
async function confirmClose() {
  closing = true;
  try {
    const info = await js("window.__agoaCloseInfo ? window.__agoaCloseInfo() : null").catch(() => null);
    let buttons, detail, actions;
    if (info && info.fichier) {
      buttons = ["Enregistrer et fermer", "Annuler"]; actions = ["save", "cancel"];
      detail = `L'opération ${info.code} sera enregistrée dans :\n${info.fichier}`;
    } else if (info) {
      buttons = ["Enregistrer le fichier .pv et fermer", "Fermer sans fichier .pv", "Annuler"]; actions = ["saveas", "close", "cancel"];
      detail = `L'opération ${info.code} n'a pas encore de fichier .pv sur le disque.\nSes données restent enregistrées dans l'application.`;
    } else {
      buttons = ["Fermer", "Annuler"]; actions = ["close", "cancel"];
      detail = "Les opérations sont enregistrées sur ce poste.";
    }
    const r = await dialog.showMessageBox(win, { type: "question", buttons, defaultId: 0, cancelId: buttons.length - 1, noLink: true, title: "Fermer AGOA PV", message: "Voulez-vous fermer AGOA PV ?", detail });
    const act = actions[r.response];
    if (act === "cancel") return;
    if (act === "save") await js("window.__agoaSaveNow()");
    if (act === "saveas") { const ok = await js("window.__agoaSaveAsNow()"); if (!ok) return; }
    if (act === "close") await js("typeof Store !== 'undefined' && Store.flush && Store.flush()").catch(() => {});
    allowClose = true; win.close();
  } catch (err) {
    const r = await dialog.showMessageBox(win, { type: "warning", buttons: ["Fermer quand même", "Annuler"], defaultId: 1, cancelId: 1, title: "Fermer AGOA PV", message: "L'enregistrement du fichier .pv a échoué.", detail: String(err && err.message || err) });
    if (r.response === 0) { allowClose = true; win.close(); }
  } finally { closing = false; }
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
  const names = { pv: "Dossier PV (AGOA)", html: "Page HTML", pdf: "PDF" };
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath("documents"), filename), filters: [{ name: names[ext] || ext.toUpperCase(), extensions: [ext] }, { name: "Tous les fichiers", extensions: ["*"] }] });
  if (r.canceled || !r.filePath) return false;
  fs.writeFileSync(r.filePath, Buffer.from(bytes));
  return true;
});
ipcMain.handle("save-as", async (e, filename, text) => {
  const r = await dialog.showSaveDialog(win, { title: "Enregistrer le dossier", defaultPath: path.join(app.getPath("documents"), filename), filters: [{ name: "Dossier PV (AGOA)", extensions: ["pv"] }] });
  if (r.canceled || !r.filePath) return null;
  writeAtomic(r.filePath, text);
  return r.filePath;
});
ipcMain.handle("write-file", async (e, file, text) => {
  if (!/\.pv$/i.test(file)) throw new Error("Seuls les fichiers .pv peuvent être écrits");
  writeAtomic(file, text);
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
  if (updateState === "downloading") return "Téléchargement en cours…";
  try {
    updateState = "checking";
    const r = await updater.checkForUpdates();
    const v = r && r.updateInfo && r.updateInfo.version;
    if (r && r.isUpdateAvailable === false || !v || v === INFO.version) { updateState = "idle"; return `À jour (v${INFO.version}, déploiement n°${INFO.deploiement}).`; }
    return `Version ${v} disponible.`;
  } catch (err) { updateState = "idle"; return "GitHub injoignable : vérifiez la connexion Internet."; }
});

/* ---------- reprise des données de l'ancien nom (AGOA RV → AGOA PV) ---------- */
function migrateOldData() {
  try {
    const oldDir = path.join(app.getPath("appData"), "AGOA RV");
    const newDir = userDir();
    if (!fs.existsSync(oldDir) || fs.existsSync(dataPath())) return;
    fs.mkdirSync(newDir, { recursive: true });
    for (const f of ["agoa-rv-donnees.json", "agoa-rv-donnees.json.bak", "agoa-rv-config.json"]) {
      const src = path.join(oldDir, f);
      if (fs.existsSync(src) && !fs.existsSync(path.join(newDir, f))) fs.copyFileSync(src, path.join(newDir, f));
    }
  } catch (e) { console.warn("Reprise des données :", e.message); }
}

/* ---------- démarrage ---------- */
if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.on("second-instance", (e, argv) => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } openAgoarv(agoarvFromArgs(argv)); });
  app.on("open-file", (e, file) => { e.preventDefault(); openAgoarv(file); });
  app.whenReady().then(() => { migrateOldData(); showSplash(); createWindow(); openAgoarv(agoarvFromArgs(process.argv)); setupUpdates(); });
  app.on("window-all-closed", () => app.quit());
}
