const { app, BrowserWindow, shell, nativeImage } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const isDev = !app.isPackaged;
const devUrl = "http://127.0.0.1:5173";

function getIconPath() {
  const iconPng = path.join(__dirname, isDev ? "icons" : "..", "icons", "icon.png");
  if (require("fs").existsSync(iconPng)) {
    return nativeImage.createFromPath(iconPng);
  }
  return undefined;
}

function getPackagedUrl() {
  return `http://${process.env.HOST || "127.0.0.1"}:${process.env.PORT || "8787"}`;
}

async function startPackagedBackend() {
  if (isDev) return;

  process.env.HOST ||= "127.0.0.1";
  process.env.PORT ||= "8787";
  process.env.PUBLIC_BASE_URL ||= getPackagedUrl();
  process.env.GATEWAY_DATA_DIR ||= path.join(app.getPath("userData"), "data");

  const serverEntry = path.join(__dirname, "..", "dist", "server", "index.js");
  const { startGatewayServer } = await import(pathToFileURL(serverEntry).href);
  await startGatewayServer({
    host: process.env.HOST,
    port: Number(process.env.PORT)
  });
}

function createWindow() {
  const icon = getIconPath();
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    title: "AI API load balancer",
    backgroundColor: "#F0EBE0",
    ...(icon ? { icon } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  if (isDev) {
    win.loadURL(devUrl);
  } else {
    win.loadURL(getPackagedUrl());
  }
}

app.whenReady().then(async () => {
  await startPackagedBackend();
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
