const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const VITE_PORT = 5173;
const VITE_URL = `http://localhost:${VITE_PORT}`;

function checkServerReady() {
  return new Promise((resolve) => {
    const req = http.get(VITE_URL, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(800, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForServer(maxAttempts = 40) {
  for (let i = 0; i < maxAttempts; i++) {
    const ready = await checkServerReady();
    if (ready) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function main() {
  const alreadyRunning = await checkServerReady();
  let viteProc = null;

  if (!alreadyRunning) {
    console.log('[PulseSlide] Démarrage du serveur Vite...');
    const viteBin = path.join(__dirname, '..', 'node_modules', 'vite', 'bin', 'vite.js');
    viteProc = spawn(process.execPath, [viteBin], {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
    });
  } else {
    console.log('[PulseSlide] Serveur Vite déjà actif sur http://localhost:5173');
  }

  const ready = await waitForServer();
  if (!ready) {
    console.error('[PulseSlide] Impossible de joindre le serveur Vite sur le port 5173.');
    process.exit(1);
  }

  console.log('[PulseSlide] Ouverture de la fenêtre bureau Electron au premier plan...');
  const electronExe = require('electron');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const electronProc = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `Start-Process -FilePath '${electronExe}' -ArgumentList '.' -WindowStyle Normal -Wait`,
    ],
    {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
      env,
    }
  );

  electronProc.on('exit', (code) => {
    if (viteProc) {
      try {
        viteProc.kill();
      } catch {}
    }
    process.exit(code ?? 0);
  });
}

main();
