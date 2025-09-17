// make-ico.js (compat con CJS/ESM de png-to-ico)
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

(async () => {
  // Carga compatible: si el paquete es ESM, usa .default
  let pngToIco = require('png-to-ico');
  pngToIco = pngToIco && pngToIco.default ? pngToIco.default : pngToIco;

  try {
    const srcPng = path.resolve(__dirname, 'assets', 'icon-1024.png'); // cambia si tu PNG base tiene otro nombre
    if (!fs.existsSync(srcPng)) {
      throw new Error(`No se encontró ${srcPng}. Coloca un PNG cuadrado (ej. 1024x1024).`);
    }

    const sizes = [256, 128, 64, 48, 32, 16];
    const buffers = [];

    for (const s of sizes) {
      const buf = await sharp(srcPng)
        .resize(s, s, { fit: 'cover' })
        .png()
        .toBuffer();
      buffers.push(buf);
    }

    const icoBuf = await pngToIco(buffers);
    const out = path.resolve(__dirname, 'icon.ico');
    fs.writeFileSync(out, icoBuf);
    console.log('✅ icon.ico generado correctamente en:', out);
  } catch (e) {
    console.error('❌ Error generando icon.ico:', e);
    process.exit(1);
  }
})();
