const { app, BrowserWindow, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const devServerUrl = process.env.CADENCE_DEV_SERVER_URL;
const desktopSearch = "desktop=1";
const desktopLogPath = path.join(app.getPath("userData"), "cadence-renderer.log");

function writeDesktopLog(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  fs.appendFile(desktopLogPath, line, () => {});
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: "Cadence",
    backgroundColor: "#f7f4ee",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    writeDesktopLog(`renderer level=${level} source=${sourceId}:${line} ${message}`);
  });

  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    writeDesktopLog(`load failed code=${errorCode} description=${errorDescription} url=${validatedURL}`);
  });

  writeDesktopLog(`Cadence window created. Renderer log path: ${desktopLogPath}`);

  if (devServerUrl) {
    const url = new URL(devServerUrl);
    url.searchParams.set("desktop", "1");
    window.loadURL(url.toString(), { userAgent: `${window.webContents.getUserAgent()} CadenceDesktop` });
    return;
  }

  window.loadFile(path.join(__dirname, "..", "dist", "index.html"), { search: desktopSearch });
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
