'use strict';

const { app, Tray, Menu, nativeImage, dialog } = require('electron');
const path = require('path');
const { startMcpServer, stopMcpServer, getServerStatus } = require('./src/server-manager');

// ── Expose Chromium via CDP for Puppeteer/sap-auth ────────────────────────────
// sap-auth uses BROWSER_WS_ENDPOINT to connect to a running browser via CDP.
// Electron's own Chromium responds on this port — Kerberos + OS certificates work.
app.commandLine.appendSwitch('remote-debugging-port', '9222');
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
app.commandLine.appendSwitch('no-sandbox');

// Prevent the app from quitting when all windows are closed (tray app)
app.on('window-all-closed', (e) => e.preventDefault());

let tray = null;

app.whenReady().then(() => {
  // Hide from dock (Mac) — this is a tray-only app
  if (app.dock) app.dock.hide();

  tray = createTray();
  startMcpServer(tray);

  // Update tray every 5 seconds with current status
  setInterval(() => updateTrayMenu(tray), 5000);
});

app.on('before-quit', () => {
  stopMcpServer();
});

// ── Tray ──────────────────────────────────────────────────────────────────────

function getTrayIcon(status) {
  // Inline 16x16 PNG icons as base64 — no external files needed
  const icons = {
    green:  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAAdgAAAHYBTnsmCAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAABUSURBVDiNY/z//z8DJYCJgUIw8A0YNWDUgFEDhpABjEOtAf+HWgP+U2wAIyMjIzMzM4OjoyMDAwMDg5OTE4OzszMDCwsLgru7O4O7uzsDtWEAAFSBFpL0tZjRAAAAAElFTkSuQmCC',
    yellow: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAAdgAAAHYBTnsmCAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAABUSURBVDiNY/zP8J+BEsDEQCEY+AaMGjBqwKgBQ8gAxqHWgP9DrQH/KTaAkZGRkZmZmcHR0ZGBgYGBwcnJicHZ2ZmBhYWFwd3dncHd3Z2B2jAAAFm+FpKJpVl3AAAAAElFTkSuQmCC',
    red:    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAAdgAAAHYBTnsmCAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAABUSURBVDiNY/zP8J+REsDEQCEY+AaMGjBqwKgBQ8gAxqHWgP9DrQH/KTaAkZGRkZmZmcHR0ZGBgYGBwcnJicHZ2ZmBhYWFwd3dncHd3Z2B2jAAAFm+FpKJpVl3AAAAAElFTkSuQmCC',
  };
  return nativeImage.createFromDataURL(`data:image/png;base64,${icons[status] ?? icons.green}`);
}

function createTray() {
  const tray = new Tray(getTrayIcon('yellow'));
  tray.setToolTip('SAP Scrubbing MCP — iniciando...');
  updateTrayMenu(tray);
  return tray;
}

function updateTrayMenu(tray) {
  const status = getServerStatus();

  const iconKey = status.running ? (status.authenticated ? 'green' : 'yellow') : 'red';
  tray.setImage(getTrayIcon(iconKey));

  const statusLabel = status.running
    ? (status.authenticated ? `✅ Autenticado — ${status.tools} tools` : '🟡 Aguardando autenticação SAP...')
    : '🔴 Servidor parado';

  tray.setToolTip(`SAP Scrubbing MCP\n${statusLabel}`);

  const menu = Menu.buildFromTemplate([
    { label: 'SAP Scrubbing Desktop', enabled: false },
    { type: 'separator' },
    { label: statusLabel, enabled: false },
    { label: `Porta: 8812  |  URL: http://localhost:8812/mcp`, enabled: false },
    { type: 'separator' },
    {
      label: '🔄 Renovar autenticação SAP',
      click: () => {
        // Delete cached cookies so sap-auth re-authenticates
        const os = require('os');
        const fs = require('fs');
        const authFile = path.join(os.homedir(), '.sap-mcp', 'auth.json');
        if (fs.existsSync(authFile)) {
          fs.unlinkSync(authFile);
        }
        dialog.showMessageBox({ message: 'Cache de autenticação limpo. A próxima chamada ao Harmony vai pedir autenticação novamente.' });
      }
    },
    {
      label: '📋 Copiar URL do MCP',
      click: () => {
        require('electron').clipboard.writeText('http://localhost:8812/mcp');
      }
    },
    { type: 'separator' },
    {
      label: 'Sair',
      click: () => app.quit()
    }
  ]);

  tray.setContextMenu(menu);
}
