// app/downloader/githubReleaseClient.js
// Cliente simple para releases de GitHub: lista assets, descarga con progreso y verificación.

const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const path = require('path');

const GITHUB_API = 'https://api.github.com';

function ghRequest(pathname, token) {
  const headers = {
    'User-Agent': 'WowLauncher/1.0',
    'Accept': 'application/vnd.github+json',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  return new Promise((resolve, reject) => {
    const req = https.request(GITHUB_API + pathname, { headers }, (res) => {
      let data = '';

      function follow(r) {
        let d2 = '';
        r.on('data', (c) => (d2 += c));
        r.on('end', () => resolve({ statusCode: r.statusCode, data: d2, headers: r.headers }));
        r.on('error', reject);
      }

      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        https.get(res.headers.location, follow).on('error', reject);
      } else {
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ statusCode: res.statusCode, data, headers: res.headers }));
      }
    });
    req.on('error', reject);
    req.end();
  });
}

async function getReleaseByTag(owner, repo, tag, token) {
  const r = await ghRequest(`/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`, token);
  if (r.statusCode !== 200) throw new Error(`GitHub API ${r.statusCode}: ${r.data}`);
  return JSON.parse(r.data);
}

function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);

    function handleStream(stream) {
      const total = Number(stream.headers['content-length'] || 0);
      let downloaded = 0;

      stream.on('data', (chunk) => {
        downloaded += chunk.length;
        if (onProgress && total) onProgress(downloaded, total);
      });

      stream.pipe(file);
      stream.on('end', () => file.close(() => resolve()));
      stream.on('error', reject);
    }

    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          https.get(res.headers.location, handleStream).on('error', reject);
        } else {
          handleStream(res);
        }
      })
      .on('error', reject);
  });
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const s = fs.createReadStream(filePath);
    s.on('error', reject);
    s.on('data', (d) => hash.update(d));
    s.on('end', () => resolve(hash.digest('hex')));
  });
}

// ==== PARSER ROBUSTO DE SHA256SUMS ====
// Acepta:
// - "<hash>  Cliente.7z.001" (hash pegado o con espacios)
// - "<hash>\tCliente.7z.001"
// - "<hash>  E:\\GAMES\\Cliente.7z.001" (con o sin comillas)
// - Nombres con NBSP o espacios múltiples
// - Ignora BOM si lo hubiera
function parseSha256Sums(content) {
  // Quita BOM (UTF-8 con BOM)
  if (content && content.charCodeAt(0) === 0xfeff) {
    content = content.slice(1);
  }

  const NBSP = /\u00A0/g; // espacio no separable
  const lines = String(content).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const map = new Map();

  for (const line of lines) {
    // Captura "cualquier cosa" de hash (hex y espacios) + separador + nombre/ruta
    const m = line.match(/^([0-9a-fA-F\s]+)\s+(.+)$/);
    if (!m) continue;

    // Normaliza el hash: quita todo lo que no sea [0-9a-f], y pásalo a minúsculas
    const rawHash = m[1].replace(/[^0-9a-fA-F]/g, '').toLowerCase();
    if (rawHash.length !== 64) continue; // no es un SHA256 válido

    // segunda parte: nombre o ruta
    let rawName = m[2].trim().replace(/^"+|"+$/g, '').replace(NBSP, ' ');
    const fname = path.basename(rawName).trim().replace(/\s+/g, ' ');
    const key = fname.toLowerCase(); // normalizamos

    map.set(key, rawHash);
  }

  return map;
}

async function ensureDir(p) {
  await fs.promises.mkdir(p, { recursive: true });
}

async function downloadAssetsSequential(assets, outDir, onProgress, retries = 3) {
  await ensureDir(outDir);
  for (const a of assets) {
    const dest = path.join(outDir, a.name);
    let attempt = 0;
    while (true) {
      try {
        await downloadFile(a.browser_download_url, dest, (done, total) => {
          if (onProgress) onProgress(a.name, done, total);
        });
        break;
      } catch (e) {
        attempt++;
        if (attempt > retries) throw new Error(`Fallo descargando ${a.name}: ${e.message}`);
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
  }
}

module.exports = {
  getReleaseByTag,
  downloadAssetsSequential,
  sha256File,
  parseSha256Sums,
};
