// main.js
const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// ===== Auto-update (añadido, no rompe nada) =====
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');
autoUpdater.logger = log;
log.transports.file.level = 'info';

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
    try { win.focus(); } catch {}
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

  // Al minimizar: se queda en la barra de tareas; solo mutea
  win.on('minimize', (_e) => {
    try { win.webContents.setAudioMuted(true); } catch {}
  });

  return win;
}

/* ================== SINGLE INSTANCE LOCK ================== */
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // Ya hay una instancia: salimos inmediatamente
  app.quit();
} else {
  // Si el usuario intenta abrir otra instancia, enfocamos la actual
  app.on('second-instance', (_event, _argv, _cwd) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      try { win.focus(); win.webContents.setAudioMuted(false); } catch {}
    } else {
      createWindow();
    }
  });

  // ===== Arranque + Updater =====
  app.whenReady().then(() => {
    createWindow();

    // Config y eventos del updater (no afecta a tu UI)
    autoUpdater.on('checking-for-update', () => log.info('checking-for-update'));
    autoUpdater.on('update-available', i => log.info('update-available', i && i.version));
    autoUpdater.on('update-not-available', () => log.info('update-not-available'));
    autoUpdater.on('error', e => log.error('autoUpdater error', e));
    autoUpdater.on('download-progress', p => log.info(`down ${Math.round(p.percent)}%`));

    autoUpdater.on('update-downloaded', async () => {
      const win = BrowserWindow.getAllWindows()[0];
      const res = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['Reiniciar ahora', 'Luego'],
        defaultId: 0,
        cancelId: 1,
        title: 'Actualización lista',
        message: 'Hay una nueva versión del launcher. ¿Reiniciar para instalarla?'
      });
      if (res.response === 0) {
        isQuitting = true;          // evita que el close lo mande a la bandeja
        autoUpdater.quitAndInstall();
      }
    });

    // Comprobar en el arranque y cada 30 minutos
    autoUpdater.checkForUpdatesAndNotify();
    setInterval(() => autoUpdater.checkForUpdatesAndNotify(), 30 * 60 * 1000);
  });
}

// 🔸 Clave: marcar salida real para que el handler de 'close' no oculte la ventana
app.on('before-quit', () => { isQuitting = true; });

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

/* =======================================================================
   AÑADIDO (PASO 2): Ventana para elegir carpeta, comprobar espacio
   y lanzar instalación del cliente con borrado de particiones al final.
   ======================================================================= */

// Dependencias del paso 2 (no tocan lo existente)
const checkDiskSpace = require('check-disk-space').default;
const { getReleaseByTag } = require('./app/downloader/githubReleaseClient');
const { installFromGithubRelease } = require('./app/downloader/installClient');

const OWNER = 'neeme22';                  // <-- tu usuario de GitHub (repo de cliente)
const CLIENT_REPO = 'game-client-dist';   // <-- repo donde publicas las releases del cliente
const CLIENT_TAG  = 'v1.0.0';             // <-- versión de cliente a instalar
const SEVEN_ZIP   = path.join(process.cwd(), 'resources', 'bin', '7za.exe');

function bytesToGiB(n){ return (n / (1024**3)).toFixed(2); }

// Handler IPC que puedes invocar desde tu UI (sin cambiar tu diseño)
ipcMain.handle('instalar-cliente-con-dialogo', async (event) => {
  // 1) Elegir carpeta de instalación (y usaremos ahí la descarga)
  const win = BrowserWindow.getFocusedWindow();
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Elige carpeta de instalación',
    properties: ['openDirectory', 'createDirectory']
  });
  if (canceled || !filePaths || !filePaths[0]) return { canceled: true };

  const installDir = filePaths[0];
  const downloadDir = path.join(installDir, '_downloads', CLIENT_TAG); // misma unidad

  // 2) Obtener tamaños de la release (para requisitos)
  const release = await getReleaseByTag(OWNER, CLIENT_REPO, CLIENT_TAG, process.env.GITHUB_TOKEN || null);
  const partAssets = (release.assets || []).filter(a => /\.7z\.\d{2,3}$/i.test(a.name));
  if (!partAssets.length) {
    await dialog.showMessageBox(win, { type: 'error', message: 'No hay partes *.7z.001 en la release.' });
    return { error: 'no_parts' };
  }

  const totalDownloadBytes = partAssets.reduce((acc, a) => acc + (a.size || 0), 0);
  const estimatedFinalBytes = totalDownloadBytes; // usamos -mx0, ~mismo tamaño
  const marginBytes = 1 * 1024 ** 3; // 1 GiB de margen
  const minRequiredBytes = totalDownloadBytes + estimatedFinalBytes + marginBytes;

  // 3) Espacio libre de la unidad de installDir
  const spaceInfo = await checkDiskSpace(installDir);
  const freeBytes = spaceInfo.free;

  // 4) Ventanita con requisitos y confirmación
  const msg =
    `Carpeta: ${installDir}\n` +
    `Descarga: ${bytesToGiB(totalDownloadBytes)} GiB\n` +
    `Instalado: ${bytesToGiB(estimatedFinalBytes)} GiB\n` +
    `Margen: ${bytesToGiB(marginBytes)} GiB\n` +
    `Mínimo requerido: ${bytesToGiB(minRequiredBytes)} GiB\n` +
    `Libre en disco: ${bytesToGiB(freeBytes)} GiB\n\n` +
    (freeBytes >= minRequiredBytes
      ? 'Hay espacio suficiente. ¿Continuar?'
      : 'No hay espacio suficiente. Elige otra carpeta o libera espacio.');

  const buttons = freeBytes >= minRequiredBytes ? ['Continuar', 'Cancelar'] : ['Cambiar carpeta', 'Cancelar'];
  const { response } = await dialog.showMessageBox(win, {
    type: freeBytes >= minRequiredBytes ? 'info' : 'warning',
    buttons,
    defaultId: 0,
    cancelId: 1,
    message: 'Requisitos de espacio',
    detail: msg,
    noLink: true
  });

  if (freeBytes < minRequiredBytes) {
    if (response === 0) {
      // “Cambiar carpeta”: el renderer puede volver a invocar este IPC
      return { notEnoughSpace: true };
    }
    return { canceled: true };
  }
  if (response !== 0) return { canceled: true };

  // 5) Ejecutar instalación con borrado de particiones al final
  try {
    const res = await installFromGithubRelease({
      owner: OWNER,
      repo: CLIENT_REPO,
      tag: CLIENT_TAG,
      downloadDir,
      installDir,
      sevenZipExe: SEVEN_ZIP,
      token: process.env.GITHUB_TOKEN || null,
      cleanupParts: true,            // <-- BORRAR PARTES .7z.* y SHA al finalizar
      skipIfVersionInstalled: true,  // <-- salta si ya está esa versión
      onLog: (m) => win?.webContents.send('instal-log', m),
      onProgress: ({ file, pct }) => win?.webContents.send('instal-progreso', { file, pct })
    });
    await dialog.showMessageBox(win, { type: 'info', message: 'Instalación completada', detail: `Carpeta: ${installDir}` });
    return { ok: true, ...res, installDir };
  } catch (e) {
    await dialog.showMessageBox(win, { type: 'error', message: 'Error instalando cliente', detail: e.message });
    return { error: e.message };
  }
});

/* ======= AÑADIDO PARA LA VERSIÓN DEL LAUNCHER ======= */
ipcMain.handle('app:getVersion', () => app.getVersion());
