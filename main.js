"use strict";
// AGOA PV — processus principal Electron
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, safeStorage } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");

const pkg = require("./package.json");
const INFO = { version: pkg.version, deploiement: (pkg.agoa && pkg.agoa.deploiement) || 0 };

let win = null;
let pendingFile = null; // fichier .pv à ouvrir dès que l'interface est prête
let ready = false;
let allowClose = false;   // vrai une fois la fermeture confirmée (ou pendant une mise à jour)
let closing = false;
let booting = true;        // démarrage en cours (écran de démarrage, mise à jour, connexion)

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
  // Seule l'origine compte (https://eu2.ragic.com) : une adresse collée depuis le navigateur
  // (https://eu2.ragic.com/agoa/...) ajouterait un chemin en trop et Ragic renverrait la liste des feuilles.
  let host = String(c.ragicHost || "").trim() || "https://eu2.ragic.com";
  if (!/^https?:\/\//i.test(host)) host = "https://" + host;
  try { host = new URL(host).origin; } catch { host = "https://eu2.ragic.com"; }
  return { host, key: String(c.ragicKey).trim() };
}
// Clé passée dans l'adresse (?APIKey=…), méthode documentée par Ragic pour une clé API seule :
// l'en-tête « Authorization: Basic » attend base64(e-mail:clé) et, mal formé, Ragic répond sans aucune fiche.
async function ragicGet(url, key) {
  let r;
  const full = url + (url.includes("?") ? "&" : "?") + "APIKey=" + encodeURIComponent(key);
  try { r = await fetch(full); }
  catch (e) { throw new Error("[network] " + e.message); }
  if (r.status === 401 || r.status === 403) throw new Error("[auth] Accès refusé par Ragic");
  if (!r.ok) throw new Error("[tool_error] Ragic HTTP " + r.status);
  const txt = await r.text();
  let j;
  try { j = JSON.parse(txt); }
  catch { throw new Error(/<html|login/i.test(txt) ? "[auth] Ragic demande une connexion : clé API non reconnue" : "[tool_error] Réponse Ragic illisible"); }
  if (j && (j.status === "ERROR" || j.status === "INVALID")) {
    const m = j.msg || j.message || "Erreur Ragic";
    throw new Error((/auth|key|login|permission|denied|cl[ée]/i.test(m) ? "[auth] " : "[tool_error] ") + m);
  }
  // Réponse sans fiche mais avec d'autres informations (message, code) : on la montre plutôt que « 0 résultat ».
  const keys = j && typeof j === "object" ? Object.keys(j) : [];
  if (keys.length && !keys.some(k => /^\d+$/.test(k)) && keys.some(k => j[k] && typeof j[k] === "object" && "children" in j[k]))
    throw new Error("[tool_error] Ragic n'a pas trouvé la feuille " + url.split("?")[0].replace(/^https?:\/\/[^/]+/, "") + " (il a renvoyé la liste des feuilles du compte).");
  if (keys.length && !keys.some(k => /^\d+$/.test(k))) throw new Error("[tool_error] Réponse Ragic inattendue : " + txt.slice(0, 200));
  return j;
}
function whereParams(filters) {
  return Object.entries(filters || {}).map(([fid, f]) => {
    const op = f && f.op === "like" ? "like" : "eq";
    return "&where=" + encodeURIComponent(`${fid},${op},${f.value}`);
  }).join("");
}
const norm = v => String(v == null ? "" : Array.isArray(v) ? v.join(" ") : v).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
// Vrai si chaque terme recherché apparaît dans au moins un champ texte de la fiche (sans accents ni casse).
// Champs connus de l'application (identifiant Ragic → libellé renvoyé par l'API) ; sinon tous les champs.
const FIELD_NAMES = { "1000113": "Nom", "1000295": "CODE TRAVAUX", "1000307": "adresse" };
const matchAll = (rec, likes) => likes.every(f => {
  const name = FIELD_NAMES[f.fid];
  const hay = name && rec && name in rec ? norm(rec[name]) : Object.entries(rec || {}).filter(([k]) => !k.startsWith("_")).map(([, v]) => norm(v)).join(" | ");
  return hay.includes(norm(f.value).trim());
});
const toList = obj => Object.entries(obj || {}).filter(([k]) => /^\d+$/.test(k)).map(([id, rec]) => ({ id: Number(id), rec }));

async function ragic(tool, input) {
  const { host, key } = ragicCfg();
  const base = `${host}/${input.apname}${input.sheet_id}`;
  if (tool === "list_page") {
    const limit = input.limit || 25;
    const j = await ragicGet(`${base}?api&v=3&limit=${limit}${whereParams(input.filters)}`, key);
    let list = toList(j);
    // Recherche « contient » : l'API HTTP est sensible aux accents et à la casse, contrairement au connecteur
    // de claude.ai. On complète par la recherche plein texte, puis par un filtrage local de la liste.
    const likes = Object.entries(input.filters || {}).filter(([, f]) => f && f.op === "like" && String(f.value || "").trim()).map(([fid, f]) => ({ fid, value: f.value }));
    if (likes.length && list.length < limit) {
      const seen = new Set(list.map(x => x.id));
      const add = arr => { for (const x of arr) if (!seen.has(x.id) && matchAll(x.rec, likes)) { seen.add(x.id); list.push(x); } };
      try { add(toList(await ragicGet(`${base}?api&v=3&limit=200&fts=${encodeURIComponent(likes[0].value)}`, key))); } catch {}
      if (list.length < limit) add(toList(await ragicGet(`${base}?api&v=3&limit=2000&listing=true`, key)));
      list = list.slice(0, limit);
    }
    return { records: list.map(x => ({ record_id: x.id, ...x.rec })) };
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
  if (tool === "update_record") {
    // Écriture d'un ou plusieurs champs d'une fiche existante (ex. code porte d'une opération)
    if (!input.record_id) throw new Error("[tool_error] Fiche Ragic inconnue");
    const body = new URLSearchParams();
    Object.entries(input.fields || {}).forEach(([fid, v]) => body.append(String(fid), v == null ? "" : String(v)));
    let r;
    try { r = await fetch(`${base}/${input.record_id}?api&v=3&APIKey=${encodeURIComponent(key)}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() }); }
    catch (e) { throw new Error("[network] " + e.message); }
    if (r.status === 401 || r.status === 403) throw new Error("[auth] Ragic refuse la modification avec cette clé");
    if (!r.ok) throw new Error("[tool_error] Ragic HTTP " + r.status);
    let j = {}; try { j = JSON.parse(await r.text()); } catch {}
    if (j.status && j.status !== "SUCCESS") throw new Error("[tool_error] " + (j.msg || "Modification refusée par Ragic"));
    return { ok: true };
  }
  throw new Error("[tool_error] Outil inconnu : " + tool);
}

/* ---------- écran de démarrage ---------- */
let splash = null, splashAt = 0, splashLoaded = null;
function showSplash() {
  splash = new BrowserWindow({ width: 520, height: 330, frame: false, resizable: false, movable: true, center: true, show: false,
    skipTaskbar: false, alwaysOnTop: true, backgroundColor: "#FFFFFF", title: "AGOA PV", icon: path.join(__dirname, "build", "icon.ico"),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  splashLoaded = new Promise(res => splash.webContents.once("did-finish-load", res));
  splash.loadFile(path.join(__dirname, "app", "splash.html"), { query: { v: INFO.version, d: String(INFO.deploiement) } });
  splash.once("ready-to-show", () => { splash.show(); splashAt = Date.now(); });
}
function splashStatus(text, pct = null) {
  if (!splash || splash.isDestroyed()) return;
  splash.webContents.executeJavaScript(`window.setStatus && setStatus(${JSON.stringify(text)}, ${pct == null ? "null" : Math.round(pct)})`).catch(() => {});
}
function closeSplash() { if (splash && !splash.isDestroyed()) splash.close(); splash = null; }
let revealed = false;
function revealMain() {
  if (revealed) return; revealed = true;
  const wait = Math.max(0, 1800 - (Date.now() - (splashAt || Date.now()))); // le logo reste au moins 1,8 s
  setTimeout(() => {
    if (win && !win.isDestroyed()) { win.show(); win.focus(); }
    closeSplash(); phase = "running";
  }, wait);
}

/* ---------- mises à jour (Releases GitHub agence-rt/agoa-rv) ---------- */
// Au démarrage : vérification pendant l'écran de démarrage, puis installation automatique et relance.
// En cours d'utilisation : « Agence › Rechercher une mise à jour » propose la mise à jour.
let updater = null;
let phase = "splash";       // splash | running
let updateState = "idle";   // idle | checking | proposed | downloading | ready
let startupDone = null;     // résout le contrôle de démarrage ("none" si aucune mise à jour installée)
let pendingVersion = "";
const notesText = info => {
  const n = info && info.releaseNotes;
  const t = Array.isArray(n) ? n.map(x => x.note || "").join("\n") : (n || "");
  return String(t).replace(/<[^>]+>/g, "").trim();
};
function startDownload() {
  updateState = "downloading";
  updater.downloadUpdate().catch(err => {
    updateState = "idle";
    if (phase === "splash") { splashStatus("Échec du téléchargement — démarrage de la version actuelle…"); setTimeout(() => startupDone && startupDone("none"), 1500); return; }
    win.setProgressBar(-1); win.setTitle(`AGOA PV — v${INFO.version}`);
    dialog.showErrorBox("Mise à jour", "Le téléchargement a échoué : " + (err && err.message ? err.message : err));
  });
}
async function proposeUpdate(info) {
  if (updateState === "downloading" || updateState === "ready") return;
  updateState = "proposed";
  const notes = notesText(info);
  const r = await dialog.showMessageBox(win, {
    type: "info", buttons: ["Mettre à jour maintenant", "Plus tard"], defaultId: 0, cancelId: 1, noLink: true,
    title: "Mise à jour disponible", message: `AGOA PV ${info.version} est disponible.`,
    detail: `Version installée : ${INFO.version} (déploiement n°${INFO.deploiement}).` + (notes ? `\n\nNouveautés :\n${notes}` : "") +
      "\n\nLa mise à jour se télécharge puis l'application redémarre. Vos dossiers et fichiers .pv ne sont pas modifiés."
  });
  if (r.response !== 0) { updateState = "idle"; return; }
  win.setTitle(`AGOA PV — téléchargement de la mise à jour ${info.version}…`);
  startDownload();
}
function initUpdater() {
  if (!app.isPackaged) return;
  try {
    updater = require("electron-updater").autoUpdater;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.on("update-available", info => {
      pendingVersion = info.version;
      if (phase === "splash") { splashStatus(`Mise à jour ${info.version} disponible — téléchargement…`, 0); startDownload(); }
      else proposeUpdate(info);
    });
    updater.on("update-not-available", () => { if (phase === "splash" && startupDone) startupDone("none"); });
    updater.on("download-progress", p => {
      if (phase === "splash") splashStatus(`Téléchargement de la mise à jour ${pendingVersion}… ${Math.round(p.percent)} %`, p.percent);
      else if (win) { win.setProgressBar(p.percent / 100); win.setTitle(`AGOA PV — téléchargement de la mise à jour… ${Math.round(p.percent)} %`); }
    });
    updater.on("update-downloaded", () => {
      updateState = "ready";
      const install = () => { allowClose = true; setTimeout(() => updater.quitAndInstall(true, true), 900); }; // installation silencieuse puis relance
      if (phase === "splash") { splashStatus(`Installation de la version ${pendingVersion}… AGOA PV va redémarrer`, 100); install(); return; }
      if (win) win.setProgressBar(-1);
      win.webContents.executeJavaScript("typeof Store !== 'undefined' && Store.flush && Store.flush()").catch(() => {}).finally(install);
    });
    updater.on("error", err => {
      console.warn("Mise à jour :", err && err.message);
      if (updateState === "checking") updateState = "idle";
      if (phase === "splash" && updateState !== "downloading" && startupDone) startupDone("none");
    });
  } catch (e) { console.warn(e); updater = null; }
}
function startupUpdateCheck() {
  if (!updater) return Promise.resolve("none");
  return new Promise(resolve => {
    let done = false;
    startupDone = r => { if (!done) { done = true; resolve(r); } };
    splashStatus("Recherche de mise à jour…");
    updateState = "checking";
    // Hors connexion ou GitHub lent : on démarre au bout de 6 s (sauf si un téléchargement a commencé)
    setTimeout(() => { if (updateState !== "downloading" && updateState !== "ready") startupDone("none"); }, 6000);
    updater.checkForUpdates().then(r => { if (r && r.isUpdateAvailable === false) startupDone("none"); }).catch(() => startupDone("none"));
  }).then(r => { if (updateState === "checking") updateState = "idle"; return r; });
}

/* ---------- accès réservé : identification Google ---------- */
// Réglages dans package.json → agoa.google : { clientId, clientSecret, allowed: [sha256(e-mail en minuscules)] }
const GOOGLE = (pkg.agoa && pkg.agoa.google) || {};
const authEnabled = () => !!(GOOGLE.clientId && Array.isArray(GOOGLE.allowed) && GOOGLE.allowed.length);
const sha256 = s => crypto.createHash("sha256").update(String(s).trim().toLowerCase()).digest("hex");
const b64url = buf => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function readAuth() {
  try {
    const enc = readJson(configPath(), {}).auth;
    if (!enc || !safeStorage.isEncryptionAvailable()) return null;
    return JSON.parse(safeStorage.decryptString(Buffer.from(enc, "base64")));
  } catch { return null; }
}
function writeAuth(obj) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Chiffrement Windows indisponible");
  const enc = safeStorage.encryptString(JSON.stringify(obj)).toString("base64"); // lié à la session Windows (DPAPI)
  writeAtomic(configPath(), JSON.stringify({ ...readJson(configPath(), {}), auth: enc }, null, 2));
}
const isAllowed = email => !!email && GOOGLE.allowed.includes(sha256(email));
function authPage(ok, msg) {
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>AGOA PV</title><style>body{font-family:"Segoe UI",Arial,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#fff;color:#1F2328}div{text-align:center}b{display:inline-flex;width:84px;height:84px;border-radius:16px;background:#B3261E;color:#fff;align-items:center;justify-content:center;font-size:22px}h1{font-size:20px;letter-spacing:.12em;margin:18px 0 8px}p{color:#666}</style></head><body><div><b>AGOA</b><h1>AGOA <span style="color:#B3261E">PV CHANTIER</span></h1><p>${ok ? "Identification terminée. Vous pouvez fermer cet onglet et revenir dans AGOA PV." : "Identification interrompue : " + msg}</p></div></body></html>`;
}
async function googleSignIn() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  const server = http.createServer();
  await new Promise((res, rej) => { server.once("error", rej); server.listen(0, "127.0.0.1", res); });
  const redirect = `http://127.0.0.1:${server.address().port}`;
  try {
    const code = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("Délai dépassé (5 minutes).")), 5 * 60 * 1000);
      server.on("request", (req, resp) => {
        const u = new URL(req.url, redirect);
        if (u.pathname !== "/") { resp.writeHead(404); resp.end(); return; }
        const err = u.searchParams.get("error"), c = u.searchParams.get("code"), st = u.searchParams.get("state");
        const ok = !err && c && st === state;
        resp.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        resp.end(authPage(ok, err === "access_denied" ? "accès refusé." : (err || "réponse invalide.")));
        clearTimeout(t);
        if (ok) resolve(c); else reject(new Error(err === "access_denied" ? "Connexion annulée." : "Réponse de Google invalide."));
      });
      const q = new URLSearchParams({ client_id: GOOGLE.clientId, redirect_uri: redirect, response_type: "code", scope: "openid email",
        code_challenge: challenge, code_challenge_method: "S256", state, prompt: "select_account" });
      shell.openExternal("https://accounts.google.com/o/oauth2/v2/auth?" + q);
    });
    const body = new URLSearchParams({ code, client_id: GOOGLE.clientId, redirect_uri: redirect, grant_type: "authorization_code", code_verifier: verifier });
    if (GOOGLE.clientSecret) body.set("client_secret", GOOGLE.clientSecret);
    const tok = await (await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body })).json();
    if (!tok.id_token) throw new Error("Google n'a pas renvoyé d'identité (" + (tok.error_description || tok.error || "erreur") + ").");
    const info = await (await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(tok.id_token))).json();
    if (info.aud !== GOOGLE.clientId || !/accounts\.google\.com$/.test(info.iss || "") || String(info.email_verified) !== "true") throw new Error("Identité Google non vérifiée.");
    return { email: info.email, sub: info.sub };
  } finally { server.close(); }
}
function askLogin() {
  return new Promise(resolve => {
    let settled = false;
    const done = v => { if (settled) return; settled = true; resolve(v); if (lw && !lw.isDestroyed()) lw.destroy(); };
    const lw = new BrowserWindow({ width: 520, height: 400, resizable: false, minimizable: true, maximizable: false, center: true, show: false,
      title: "AGOA PV — Connexion", icon: path.join(__dirname, "build", "icon.ico"), autoHideMenuBar: true, backgroundColor: "#FFFFFF",
      webPreferences: { preload: path.join(__dirname, "login-preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: false } });
    lw.setMenu(null);
    lw.once("ready-to-show", () => lw.show());
    lw.on("closed", () => done(false));
    const onStart = async e => {
      if (e.sender !== lw.webContents) return;
      try {
        const id = await googleSignIn();
        if (lw.isDestroyed()) return;
        if (!isAllowed(id.email)) { lw.webContents.send("login-status", "err", `Le compte ${id.email} n'est pas autorisé à utiliser AGOA PV.`); return; }
        writeAuth({ email: id.email, sub: id.sub, le: new Date().toISOString() });
        lw.webContents.send("login-status", "ok", `Connecté : ${id.email}`);
        setTimeout(() => done(true), 900);
      } catch (err) { if (!lw.isDestroyed()) lw.webContents.send("login-status", "err", err.message || String(err)); }
      finally { if (!lw.isDestroyed()) lw.focus(); }
    };
    const onQuit = e => { if (e.sender === lw.webContents) done(false); };
    ipcMain.on("login-start", onStart); ipcMain.on("login-quit", onQuit);
    lw.on("closed", () => { ipcMain.removeListener("login-start", onStart); ipcMain.removeListener("login-quit", onQuit); });
    lw.loadFile(path.join(__dirname, "app", "login.html"));
  });
}
async function ensureAuthorized() {
  if (!authEnabled()) return true;
  const a = readAuth();
  if (a && isAllowed(a.email)) return true;
  closeSplash();
  return await askLogin();
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
    { label: "Aide", submenu: [{ label: `AGOA PV v${INFO.version} — déploiement n°${INFO.deploiement}`, enabled: false }].concat(authEnabled() && readAuth() ? [{ label: `Compte : ${readAuth().email}`, enabled: false }] : []) }
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
ipcMain.on("get-config", e => { const { auth, ...c } = readJson(configPath(), {}); e.returnValue = c; });
ipcMain.on("set-config", (e, patch) => { const { auth, ...p } = patch || {}; writeAtomic(configPath(), JSON.stringify({ ...readJson(configPath(), {}), ...p }, null, 2)); e.returnValue = true; });
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
  app.whenReady().then(async () => {
    migrateOldData();
    showSplash(); initUpdater();
    await Promise.race([splashLoaded, new Promise(r => setTimeout(r, 3000))]);
    if (await startupUpdateCheck() === "updating") return;   // (l'application redémarre après installation)
    if (updateState === "downloading" || updateState === "ready") return;
    splashStatus("Vérification de l'accès…");
    if (!(await ensureAuthorized())) { app.quit(); return; }
    splashStatus("Démarrage…");
    createWindow(); booting = false;
    openAgoarv(agoarvFromArgs(process.argv));
  });
  app.on("window-all-closed", () => { if (!booting) app.quit(); });
}
