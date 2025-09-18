// app/downloader/installClient.js
// Descarga/instala el cliente desde una GitHub Release con verificación y extracción segura.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const https = require('https');
const { URL } = require('url');

const { getReleaseByTag } = require('./githubReleaseClient');

const VERSION_MARK_FILE = 'CLIENTE_VERSION.txt';
const SHA_FILE_NAME = 'SHA256SUMS.txt';

/* ==================== Utils ==================== */
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); return p; }

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const rs = fs.createReadStream(file);
    rs.on('error', reject);
    rs.on('data', d => h.update(d));
    rs.on('end', () => resolve(h.digest('hex')));
  });
}

function log(onLog, msg) { try { onLog && onLog(String(msg)); } catch {} }
function prog(onProgress, file, pct) { try { onProgress && onProgress({ file, pct }); } catch {} }

function deleteIfExistsSync(p) {
  try {
    if (!fs.existsSync(p)) return;
    const st = fs.statSync(p);
    if (st.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
    else fs.unlinkSync(p);
  } catch {}
}

// Parser tolerante para SHA256SUMS.txt
function parseSha256Sums(text) {
  const map = new Map();
  const lines = String(text || '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/);
    if (!m) continue;
    const hash = m[1].toLowerCase();
    let name = m[2].trim();
    if ((name.startsWith('"') && name.endsWith('"')) || (name.startsWith("'") && name.endsWith("'"))) {
      name = name.slice(1, -1);
    }
    const base = path.basename(name).toLowerCase();
    map.set(base, hash);
  }
  return map;
}

function writeVersionMark(installDir, tag) {
  try { fs.writeFileSync(path.join(installDir, VERSION_MARK_FILE), String(tag || '').trim() + '\r\n'); } catch {}
}
function readVersionMark(installDir) {
  try {
    const p = path.join(installDir, VERSION_MARK_FILE);
    if (!fs.existsSync(p)) return null;
    return String(fs.readFileSync(p, 'utf8')).trim();
  } catch { return null; }
}

/* ==================== Descargador HTTP ==================== */
function downloadUrlToFile(urlStr, outPath, onPct, token, userAgent = 'AzerothRebornLauncher') {
  return new Promise((resolve, reject) => {
    const seen = new Set();
    function go(u) {
      if (seen.size > 8) return reject(new Error('Demasiadas redirecciones'));
      seen.add(u);

      const url = new URL(u);
      const headers = { 'User-Agent': userAgent, 'Accept': 'application/octet-stream' };
      if (token) headers['Authorization'] = `token ${token}`;

      const req = https.get({ hostname: url.hostname, path: url.pathname + url.search, protocol: url.protocol, headers }, (res) => {
        const code = res.statusCode || 0;
        if ([301,302,303,307,308].includes(code) && res.headers.location) {
          const next = new URL(res.headers.location, url).toString();
          res.resume();
          return go(next);
        }
        if (code < 200 || code >= 300) {
          res.resume();
          return reject(new Error(`HTTP ${code} descargando ${url.toString()}`));
        }

        const total = parseInt(res.headers['content-length'] || '0', 10);
        let done = 0;
        const tmp = outPath + '.part';
        const ws = fs.createWriteStream(tmp);

        res.on('data', (chunk) => {
          done += chunk.length;
          if (total > 0 && onPct) {
            const pct = Math.max(0, Math.min(100, Math.floor(done * 100 / total)));
            try { onPct(pct); } catch {}
          }
        });

        res.pipe(ws);
        ws.on('finish', () => {
          ws.close(() => {
            try { fs.renameSync(tmp, outPath); } catch { try { fs.copyFileSync(tmp, outPath); fs.unlinkSync(tmp); } catch {} }
            resolve(outPath);
          });
        });
        ws.on('error', err => { try { fs.unlinkSync(tmp); } catch {}; reject(err); });
      });

      req.on('error', reject);
    }
    go(urlStr);
  });
}

async function downloadAssetFile(asset, outPath, onPct, token) {
  const u = asset.browser_download_url || asset.url;
  return downloadUrlToFile(u, outPath, onPct, token);
}

/* ==================== 7-Zip ==================== */
function sevenZipExtract(sevenZipExe, firstPartPath, destDir, onLog) {
  return new Promise((resolve, reject) => {
    // -bso1/-bse1 para enviar stdout/stderr a pipes y poder loguearlo
    const args = ['x', firstPartPath, `-o${destDir}`, '-y', '-bso1', '-bse1'];
    const ps = spawn(sevenZipExe, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    ps.stdout.on('data', d => log(onLog, String(d)));
    ps.stderr.on('data', d => log(onLog, String(d)));

    ps.on('error', reject);
    ps.on('exit', (code) => code === 0 ? resolve(true) : reject(new Error(`7-Zip devolvió código ${code}`)));
  });
}

// Comprueba que realmente hay contenido tras extraer
function extractionLooksValid(dir) {
  try {
    if (!fs.existsSync(dir)) return false;
    const items = fs.readdirSync(dir);
    if (items.length === 0) return false;
    // Si hay subcarpeta única, entra y vuelve a comprobar
    if (items.length === 1) {
      const p = path.join(dir, items[0]);
      if (fs.statSync(p).isDirectory()) {
        const inner = fs.readdirSync(p);
        return inner.length > 0;
      }
    }
    return true;
  } catch { return false; }
}

/* ==================== Núcleo ==================== */
async function installFromGithubRelease(opts) {
  const {
    owner, repo, tag,
    downloadDir,
    installDir,
    sevenZipExe,
    token = null,
    cleanupParts = true,
    skipIfVersionInstalled = true,
    onLog, onProgress,
  } = opts || {};

  if (!owner || !repo || !tag) throw new Error('Parámetros inválidos (owner/repo/tag)');
  if (!downloadDir || !installDir) throw new Error('Parámetros inválidos (downloadDir/installDir)');
  if (!sevenZipExe || !fs.existsSync(sevenZipExe)) throw new Error('No se encontró 7za.exe');

  ensureDir(downloadDir);
  ensureDir(installDir);

  if (skipIfVersionInstalled) {
    const current = readVersionMark(installDir);
    if (current && String(current) === String(tag)) {
      log(onLog, `Versión ${tag} ya instalada. Omitiendo descarga.`);
      return { ok: true, skipped: true, version: tag, installDir };
    }
  }

  log(onLog, `[CLIENTE] Buscando release ${owner}/${repo} tag ${tag}...`);
  const release = await getReleaseByTag(owner, repo, tag, token);
  if (!release) throw new Error('No se encontró la release');

  const assets = release.assets || [];
  const partAssets = assets
    .filter(a => /\.7z\.\d{2,3}$/i.test(a.name))
    .sort((a,b)=> a.name.localeCompare(b.name, undefined, {numeric:true}));
  if (!partAssets.length) throw new Error('La release no contiene partes *.7z.001 ...');

  const shaAsset = assets.find(a => a.name === SHA_FILE_NAME);
  if (!shaAsset) throw new Error('No se encontró SHA256SUMS.txt en la release');

  // Descargar y parsear SHA256SUMS.txt
  const shaPath = path.join(downloadDir, SHA_FILE_NAME);
  log(onLog, `[CLIENTE] Leyendo ${SHA_FILE_NAME}...`);
  await downloadAssetFile(shaAsset, shaPath, (pct)=>prog(onProgress, SHA_FILE_NAME, pct), token);

  const buf = fs.readFileSync(shaPath);
  let text;
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
    text = buf.slice(2).toString('utf16le');
  } else if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
    const swapped = Buffer.alloc(buf.length - 2);
    for (let i=2;i<buf.length;i+=2){ swapped[i-2]=buf[i+1]; swapped[i-1]=buf[i]; }
    text = swapped.toString('utf16le');
  } else {
    text = buf.toString('utf8');
  }
  const shaMap = parseSha256Sums(text);
  if (!shaMap || shaMap.size === 0) throw new Error('SHA256SUMS.txt vacío o no válido');

  // Descargar partes (solo si faltan o difieren)
  log(onLog, `[CLIENTE] Se encontraron ${partAssets.length} partes + hashes. Descargando...`);
  const partsPaths = [];
  for (const a of partAssets) {
    const out = path.join(downloadDir, a.name);
    const key = path.basename(a.name).toLowerCase();
    const expected = (shaMap.get(key) || '').toLowerCase();
    if (!expected) throw new Error(`No hay hash esperado para ${a.name}`);

    let need = true;
    if (fs.existsSync(out)) {
      try {
        const actual = await sha256File(out);
        if (actual === expected) { need = false; prog(onProgress, a.name, 100); }
      } catch {}
    }

    if (need) {
      await downloadAssetFile(a, out, (pct)=>prog(onProgress, a.name, pct), token);
    }

    partsPaths.push(out);
  }

  // Verificación final
  log(onLog, '[CLIENTE] Verificando SHA-256...');
  for (const a of partAssets) {
    const p = path.join(downloadDir, a.name);
    const actual = await sha256File(p);
    const key = path.basename(a.name).toLowerCase();
    const expected = (shaMap.get(key) || '').toLowerCase();

    if (!expected) throw new Error(`No hay hash esperado para ${a.name}`);
    if (actual !== expected) throw new Error(`Hash inválido para ${a.name}\nesperado=${expected}\nactual=${actual}`);
    log(onLog, `[CLIENTE] OK ${a.name}`);
  }

  // Extraer
  const firstPart = partsPaths[0];
  log(onLog, `[CLIENTE] Extrayendo: ${firstPart} -> ${installDir}\n`);
  await sevenZipExtract(sevenZipExe, firstPart, installDir, onLog);

  // Validar extracción (no limpiamos si no hay contenido real)
  const good = extractionLooksValid(installDir);
  if (!good) {
    log(onLog, '[CLIENTE] La extracción no generó contenido en la carpeta de destino. Conservando las partes para diagnóstico.');
    throw new Error('La extracción no creó archivos. Revisa la ruta de destino o permisos.');
  }

  log(onLog, `[CLIENTE] Extracción completada.`);
  writeVersionMark(installDir, tag);

  // Limpieza
  if (cleanupParts) {
    log(onLog, `[CLIENTE] Limpiando particiones...`);
    try { for (const p of partsPaths) deleteIfExistsSync(p); } catch {}
    deleteIfExistsSync(shaPath);
    try { const left = fs.readdirSync(downloadDir); if (left.length === 0) fs.rmdirSync(downloadDir); } catch {}
  }

  return { ok: true, version: tag, installDir };
}

module.exports = { installFromGithubRelease };
