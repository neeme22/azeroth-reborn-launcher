const {contextBridge, ipcRenderer} = require('electron');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

let extractZip; try { extractZip = require('extract-zip'); } catch { extractZip = null; }

contextBridge.exposeInMainWorld('launcher', {
  // IPC al main
  loadCfg: () => ipcRenderer.invoke('cfg:load'),
  saveCfg: (c) => ipcRenderer.invoke('cfg:save', c),
  selectClient: () => ipcRenderer.invoke('selectClient'),
  saveDialog: (opts) => ipcRenderer.invoke('saveDialog', opts || {}),
  openLink: (u) => ipcRenderer.invoke('openLink', u),
  writeRealmlist: (args) => ipcRenderer.invoke('writeRealmlist', args),
  runWow: (p) => ipcRenderer.invoke('runWow', p),
  repair: (p) => ipcRenderer.invoke('repair', p),

  // Controles de ventana
  win: {
    control: (cmd) => ipcRenderer.invoke('win:control', cmd),
    onState: (cb) => ipcRenderer.on('win:state', (_e, s) => cb && cb(s)),
    isMaximized: () => ipcRenderer.invoke('win:control', 'isMax')
  },

  // Utilidades para el renderer
  utils: {
    tmpDir: () => os.tmpdir(),
    join: (a, b) => path.join(a, b),
    dirname: (p) => path.dirname(p),
    exists: (p) => fs.existsSync(p),
    ensureDir: (d) => { fs.mkdirSync(d, {recursive:true}); return true; },
    realpath: (p) => { try { return fs.realpathSync(p); } catch { return p; } },
    moveOrCopy: (src, dest) => { try { fs.renameSync(src, dest); } catch { fs.copyFileSync(src, dest); try{ fs.unlinkSync(src);}catch{} } return true; },
    extractZip: async (zipPath, destDir) => {
      if (extractZip) { await extractZip(zipPath, { dir: destDir }); return true; }
      await new Promise((resolve, reject) => {
        const {spawn} = require('child_process');
        const ps = spawn('powershell.exe', ['-NoLogo','-NoProfile','-Command', `Expand-Archive -Path "${zipPath}" -DestinationPath "${destDir}" -Force`], {windowsHide:true});
        ps.on('exit', code => code===0 ? resolve() : reject(new Error('Expand-Archive falló')));
      });
      return true;
    },
    statSize: (p) => { try { return fs.statSync(p).size; } catch { return 0; } },
    existsFileCI: (dir, filename) => {
      try {
        const want = filename.toLowerCase();
        return fs.readdirSync(dir).some(f => f.toLowerCase() === want);
      } catch { return false; }
    },
    // === Añadidos para gestionar versiones en Data ===
    listDir: (d) => { try { return fs.readdirSync(d); } catch { return []; } },
    remove: (p) => { try { fs.rmSync(p, {force:true}); return true; } catch { return false; } },
  },

  // Google Drive
  driveInfo: (fileId) => driveInfo(fileId),
  downloadDrive: (fileId, destPath) => downloadFromDrive(fileId, destPath)
});

/* ===================== Google Drive ===================== */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AzerothRebornLauncher';
const isRedirect = c => [301,302,303,307,308].includes(c);

function headers(jar){ return { 'User-Agent': UA, 'Cookie': jar.join('; '), 'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8' }; }
function addCookies(res, jar){ (res.headers['set-cookie'] || []).forEach(c => jar.push(c.split(';')[0])); }

function getFollow(url, jar, depth=10){
  return new Promise((resolve, reject)=>{
    if (depth<=0) return reject(new Error('Demasiadas redirecciones'));
    https.get(url, {headers: headers(jar)}, res => {
      addCookies(res, jar);
      if (isRedirect(res.statusCode) && res.headers.location){
        const next = new URL(res.headers.location, url).toString();
        res.resume();
        resolve(getFollow(next, jar, depth-1));
      } else resolve(res);
    }).on('error', reject);
  });
}

function filenameFromHeaders(res){
  const cd = res.headers['content-disposition'];
  if (!cd) return null;
  let m = /filename\*=(?:UTF-8''|)([^;]+)$/i.exec(cd);
  if (m) return decodeURIComponent(m[1].replace(/"/g,'').trim());
  m = /filename="?([^"]+)"?/i.exec(cd);
  return m ? m[1] : null;
}
function filenameFromHTML(html){
  let m = html.match(/class="uc-name-size"[^>]*title="([^"]+)"/i);
  if (m) return m[1];
  m = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i);
  if (m) return m[1];
  m = html.match(/[“"]([^"”]+?\.(?:zip|rar|7z|mpq|iso|exe|bin|tar(?:\.gz)?))[”"]/i);
  if (m) return m[1];
  m = html.match(/"filename"\s*:\s*"([^"]+)"/i);
  if (m) return m[1];
  m = html.match(/<title>(.*?)<\/title>/i);
  if (m) return (m[1]||'').replace(/\s*- Google Drive\s*$/i,'').trim();
  return null;
}
function confirmUrlFromHTML(html, base){
  let m = html.match(/<a[^>]+id="uc-download-link"[^>]+href="([^"]+)"/i);
  if (m) return new URL(m[1].replace(/&amp;/g,'&'), 'https://drive.google.com').toString();

  const forms = [...html.matchAll(/<form[^>]+action="([^"]*uc\?export=download[^"]*)"[^>]*>([\s\S]*?)<\/form>/ig)];
  for (const f of forms){
    const action = f[1].replace(/&amp;/g,'&');
    const body   = f[2];
    const params = new URLSearchParams();
    for (const m2 of body.matchAll(/<input[^>]+name="([^"]+)"[^>]+value="([^"]*)"/gi)) {
      params.append(m2[1], m2[2]);
    }
    const sep = action.includes('?') ? '&' : '?';
    return new URL(action + sep + params.toString(), 'https://drive.google.com').toString();
  }

  m = html.match(/confirm=([0-9A-Za-z_]+)/);
  if (m) return `${base}&confirm=${m[1]}`;

  return null;
}

async function driveInfo(fileId){
  const jar = [];
  const base = `https://drive.google.com/uc?export=download&id=${fileId}`;
  const res1 = await getFollow(base, jar);
  const ct1  = (res1.headers['content-type']||'').toLowerCase();

  if (!ct1.includes('text/html')) {
    const name = filenameFromHeaders(res1) || 'archivo.bin';
    res1.destroy();
    return { filename: name, confirmUrl: base, cookies: jar };
  }

  let html = '';
  await new Promise(r => { res1.on('data',d=> html += d); res1.on('end', r); });

  const name = filenameFromHTML(html) || 'archivo.bin';
  const confirmUrl = confirmUrlFromHTML(html, base);

  if (/Cuota|quota|exceeded/i.test(html)) return { filename: name, error: 'quota' };
  if (/No se ha podido comprobar si este archivo tiene virus|virus/i.test(html) && !confirmUrl)
    return { filename: name, error: 'needsConfirm' };

  return { filename: name, confirmUrl: confirmUrl || base, cookies: jar };
}

async function downloadFromDrive(fileId, destPath){
  const info = await driveInfo(fileId);
  if (info.error === 'quota') throw new Error('Cuota excedida en Google Drive. Inténtalo más tarde o cambia el enlace.');
  const url = info.confirmUrl || `https://drive.google.com/uc?export=download&id=${fileId}`;
  const jar = info.cookies || [];

  const res = await getFollow(url, jar);
  const ct  = (res.headers['content-type']||'').toLowerCase();

  if (ct.includes('text/html')) {
    let err = 'El archivo no es público o la cuota de descarga se ha excedido.';
    try{ let s=''; await new Promise(r=>{res.on('data',d=>s+=d); res.on('end',r);});
      if (/Cuota|quota|exceeded/i.test(s)) err='Cuota excedida en Google Drive.';
      else if (/Acceso|denegado|forbidden|inicia sesión/i.test(s)) err='Acceso restringido: cambia el archivo a "Cualquiera con el enlace".';
      else if (/virus/i.test(s)) err='Aviso de virus: no se pudo confirmar automáticamente.';
    }catch{}
    throw new Error(err);
  }

  const total = parseInt(res.headers['content-length']||'0', 10);
  let done = 0;
  const ws = fs.createWriteStream(destPath);
  res.on('data', chunk => {
    done += chunk.length;
    try { window.postMessage({type:'progress', done, total}, '*'); } catch {}
  });
  await new Promise((resolve, reject)=>{ res.pipe(ws); ws.on('finish', resolve); ws.on('error', reject); });

  return { done:true, size: fs.existsSync(destPath)? fs.statSync(destPath).size : 0, filename: info.filename || filenameFromHeaders(res) || 'archivo.bin' };
}
