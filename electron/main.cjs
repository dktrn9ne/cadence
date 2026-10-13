const { app, BrowserWindow, shell, session } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { buildCsp } = require("./csp.cjs");

const devServerUrl = process.env.CADENCE_DEV_SERVER_URL;
const desktopSearch = "desktop=1";
const desktopLogPath = path.join(app.getPath("userData"), "cadence-renderer.log");

function writeDesktopLog(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  fs.appendFile(desktopLogPath, line, () => {});
}

// Delivers the CSP as a response header on every document load. Electron's
// webRequest listener sees both http(s) (Vite dev server) and file:// (built
// dist) main-frame responses in Electron 41, so one mechanism covers both
// load paths without touching the shipped index.html used by the web deploy.
function attachContentSecurityPolicy() {
  const devOrigin = devServerUrl ? new URL(devServerUrl).origin : null;
  const productionCsp = buildCsp();
  const devCsp = devOrigin ? buildCsp({ devServerOrigin: devOrigin }) : null;

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType !== "mainFrame") {
      callback({});
      return;
    }

    const isDevDocument = Boolean(devCsp && details.url.startsWith(`${devOrigin}/`));
    const isBuiltDocument = details.url.startsWith("file://");
    const policy = isDevDocument ? devCsp : isBuiltDocument ? productionCsp : null;
    if (!policy) {
      callback({});
      return;
    }

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [policy],
      },
    });
  });
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: "Cadence",
    backgroundColor: "#0B1026",
    icon: path.join(__dirname, "..", "src", "brand", "app-icon.png"),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    // Never hand arbitrary file/custom protocols to the operating system.
    try {
      const parsed = new URL(url);
      if (["https:", "http:"].includes(parsed.protocol)) shell.openExternal(url);
    } catch { /* Invalid URLs stay inside the denied navigation. */ }
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

// Electron's process lock covers separate desktop processes as well as tabs.
// The Web Locks owner in the renderer then protects same-origin windows.
const ownsDesktop = app.requestSingleInstanceLock();
if (!ownsDesktop) app.quit();
else app.on("second-instance", () => {
  const existing = BrowserWindow.getAllWindows()[0];
  if (existing) { if (existing.isMinimized()) existing.restore(); existing.focus(); }
});

if (ownsDesktop) app.whenReady().then(() => {
  attachContentSecurityPolicy();
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
