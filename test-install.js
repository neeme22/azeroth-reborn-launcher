const path = require("path");
const { installFromGithubRelease } = require("./app/downloader/installClient");

(async () => {
  const owner = "neeme22";                 // <-- pon tu usuario de GitHub
  const repo  = "game-client-dist";        // <-- repo donde subiste la Release del cliente
  const tag   = "v1.0.0";                  // <-- tag de la Release del cliente

  const downloadDir = path.join(process.cwd(), "downloads", tag);
  const installDir  = path.join(process.cwd(), "ClienteJuego");
  const sevenZipExe = path.join(process.cwd(), "resources", "bin", "7za.exe");

  const token = process.env.GITHUB_TOKEN || null; // solo si el repo es privado

  try {
    await installFromGithubRelease({
      owner, repo, tag, downloadDir, installDir, sevenZipExe, token,
      onLog: (m) => console.log("[CLIENTE]", m),
      onProgress: ({ file, pct }) => console.log(`[DESCARGA] ${file}: ${pct}%`)
    });
    console.log("✅ Cliente instalado en:", installDir);
  } catch (e) {
    console.error("❌ ERROR instalando cliente:", e.message);
    process.exit(1);
  }
})();
