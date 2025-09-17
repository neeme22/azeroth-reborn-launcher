// main.js
const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

let tray = null;
let isQuitting = false;

function createWindow () {
  const win = new BrowserWindow({
    width: 1295, height: 925, minWidth: 880, minHeight: 560,
    backgroundColor: '#0a1220',
    title: 'Azeroth Reborn Launcher',
    frame: false,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.setMenu(null);
  win.loadFile('index.html');

  // Notifica al renderer cambios de estado (maximizado/restaurado)
  win.on('maximize',   () => win.webContents.send('win:state', { maximized: true  }));
  win.on('unmaximize', () => win.webContents.send('win:state', { maximized: false }));

  // ===== System Tray =====
  const trayIconPng = path.join(__dirname, 'assets', 'icon-32.png'); // si no existe, usará icon.ico
  let trayImg = nativeImage.createFromPath(trayIconPng);
  if (trayImg.isEmpty()) trayImg = nativeImage.createFromPath(path.join(__dirname, 'icon.ico'));

  tray = new Tray(trayImg);
  tray.setToolTip('Azeroth Reborn Launcher');

  const showWin = () => {
    if (win.isMinimized()) win.restore();
    win.show();
    try { win.webContents.setAudioMuted(false); } catch {}
  };

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Mostrar', click: showWin },
    { type: 'separator' },
    { label: 'Salir', click: () => { isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(contextMenu);
  tray.on('click', showWin);

  // Al “cerrar” la ventana: ocultar a bandeja y silenciar música
  win.on('close', (e) => {
    if (isQuitting) return;
    e.preventDefault();
    try { win.webContents.setAudioMuted(true); } catch {}
    win.hide();
  });

  // ⬇️ Al minimizar: YA NO se esconde a la bandeja; va a la barra de tareas.
  //    Mantengo solo el mute (sin ocultar).
  win.on('minimize', (_e) => {
    try { win.webContents.setAudioMuted(true); } catch {}
    // Nada de preventDefault ni hide(): así queda en la barra de tareas.
  });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

/* ---------- Config ---------- */
const userDir = app.getPath('userData');
const cfgFile = path.join(userDir, 'config.json');
function loadCfg() {
  try { return JSON.parse(fs.readFileSync(cfgFile, 'utf8')); }
  catch { return { wowPath:'', realmHost:'127.0.0.1', realmPort:3724 }; }
}
function saveCfg(c) {
  fs.mkdirSync(userDir, { recursive:true });
  fs.writeFileSync(cfgFile, JSON.stringify(c, null, 2));
}

/* ---------- IPC ---------- */
ipcMain.handle('cfg:load', () => loadCfg());
ipcMain.handle('cfg:save', (_e, c) => { saveCfg(c); return true; });

ipcMain.handle('selectClient', async () => {
  const res = await dialog.showOpenDialog({ properties:['openDirectory'] });
  if (res.canceled || !res.filePaths[0]) return null;
  return res.filePaths[0];
});

ipcMain.handle('saveDialog', async (_e, { defaultPath, filters }) => {
  const res = await dialog.showSaveDialog({
    title: 'Guardar archivo',
    defaultPath: defaultPath || path.join(app.getPath('downloads'), 'AzerothReborn-Cliente.zip'),
    filters: filters || [{ name:'ZIP', extensions:['zip'] }, { name:'Todos', extensions:['*'] }]
  });
  return res.canceled ? null : res.filePath;
});

ipcMain.handle('openLink', (_e, url) => shell.openExternal(url));

function writeRealmlist(base, host){
  const data = path.join(base, 'Data');
  const langs = ['esES','enGB','enUS','frFR','deDE','ruRU'];
  let written = 0;
  for (const L of langs) {
    const p = path.join(data, L, 'realmlist.wtf');
    try {
      if (fs.existsSync(path.dirname(p))) {
        fs.writeFileSync(p, `set realmlist ${host}\r\n`);
        written++;
      }
    } catch {}
  }
  return written > 0;
}
ipcMain.handle('writeRealmlist', (_e, { wowPath, host }) => writeRealmlist(wowPath, host));

ipcMain.handle('runWow', (e, wowPath) => {
  const exe = path.join(wowPath, 'wow.exe');
  if (!fs.existsSync(exe)) throw new Error('No se encontró wow.exe en esa carpeta.');

  // Lanzar juego
  spawn(exe, [], { cwd: wowPath, detached: true, stdio: 'ignore' }).unref();

  // Ocultar a bandeja y silenciar música
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) {
    try { win.webContents.setAudioMuted(true); } catch {}
    win.hide();
  }
  return true;
});

ipcMain.handle('repair', (_e, wowPath) => {
  const exe = path.join(wowPath, 'wow.exe');
  const cache = path.join(wowPath, 'Cache');
  const wdb = path.join(wowPath, 'WDB');
  let okExe = fs.existsSync(exe);
  try { if (fs.existsSync(cache)) fs.rmSync(cache, { recursive:true, force:true }); } catch {}
  try { if (fs.existsSync(wdb)) fs.rmSync(wdb, { recursive:true, force:true }); } catch {}
  return { okExe };
});

/* ---------- Controles de ventana ---------- */
ipcMain.handle('win:control', (e, cmd) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return false;
  switch (cmd) {
    case 'min':   win.minimize(); break;
    case 'max':   win.isMaximized() ? win.unmaximize() : win.maximize(); break;
    case 'close': win.close(); break; // esto invoca nuestro handler y lo manda a la bandeja
    case 'isMax': return win.isMaximized();
  }
  return true;
});
