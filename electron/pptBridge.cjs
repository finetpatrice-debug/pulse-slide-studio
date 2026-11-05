const { spawn } = require('child_process');
const path = require('path');

class PowerPointBridge {
  constructor() {
    this.psProcess = null;
    this.pendingQueue = [];
    this.buffer = '';
    this.lastStatus = {
      connected: false,
      inSlideShow: false,
      presentationName: null,
      currentSlide: 1,
      totalSlides: 1,
      slideTitle: '',
      slideText: '',
      isVoteSlide: false,
      propositionSlide: 1,
      propositionTitle: '',
      slideButtonClicked: false,
    };
    this.initProcess();
  }

  initProcess() {
    if (process.platform !== 'win32') return;

    const workerScript = path.join(__dirname, 'pptWorker.ps1');

    try {
      this.psProcess = spawn(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', workerScript],
        {
          stdio: ['pipe', 'pipe', 'ignore'],
          windowsHide: true,
        }
      );

      this.psProcess.on('error', () => {
        this.psProcess = null;
      });

      if (this.psProcess.stdin) {
        this.psProcess.stdin.on('error', () => {});
      }

      if (this.psProcess.stdout) {
        this.psProcess.stdout.on('error', () => {});
        this.psProcess.stdout.setEncoding('utf8');
        this.psProcess.stdout.on('data', (chunk) => {
          this.buffer += chunk;
          let newlineIdx;
          while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
            const line = this.buffer.slice(0, newlineIdx).trim();
            this.buffer = this.buffer.slice(newlineIdx + 1);
            if (!line) continue;
            try {
              const parsed = JSON.parse(line);
              this.lastStatus = parsed;
              const resolver = this.pendingQueue.shift();
              if (resolver) resolver(parsed);
            } catch {
              const resolver = this.pendingQueue.shift();
              if (resolver) resolver(this.lastStatus);
            }
          }
        });
      }

      this.psProcess.on('exit', () => {
        this.psProcess = null;
        while (this.pendingQueue.length > 0) {
          const resolver = this.pendingQueue.shift();
          if (resolver) resolver(this.lastStatus);
        }
      });
    } catch {
      this.psProcess = null;
    }
  }

  sendCommand(cmd, timeoutMs = 4000) {
    // Ne jamais empiler plusieurs commandes STATUS si une commande est déjà en cours d'exécution
    if (cmd === 'STATUS' && this.pendingQueue.length > 0) {
      return Promise.resolve({ ...this.lastStatus, slideButtonClicked: false });
    }

    return new Promise((resolve) => {
      if (!this.psProcess || !this.psProcess.stdin || !this.psProcess.stdin.writable || this.psProcess.killed) {
        this.initProcess();
      }
      if (!this.psProcess || !this.psProcess.stdin || !this.psProcess.stdin.writable) {
        resolve(this.lastStatus);
        return;
      }

      const timeout = setTimeout(() => {
        const idx = this.pendingQueue.indexOf(wrappedResolve);
        if (idx !== -1) this.pendingQueue.splice(idx, 1);
        resolve(this.lastStatus);
      }, timeoutMs);

      const wrappedResolve = (result) => {
        clearTimeout(timeout);
        resolve(result);
      };

      this.pendingQueue.push(wrappedResolve);
      try {
        this.psProcess.stdin.write(cmd + '\n', (err) => {
          if (err) {
            const idx = this.pendingQueue.indexOf(wrappedResolve);
            if (idx !== -1) this.pendingQueue.splice(idx, 1);
            clearTimeout(timeout);
            resolve(this.lastStatus);
          }
        });
      } catch {
        const idx = this.pendingQueue.indexOf(wrappedResolve);
        if (idx !== -1) this.pendingQueue.splice(idx, 1);
        clearTimeout(timeout);
        resolve(this.lastStatus);
      }
    });
  }

  destroy() {
    if (this.psProcess) {
      try {
        this.psProcess.kill();
      } catch {}
      this.psProcess = null;
    }
  }
}

module.exports = { PowerPointBridge };
