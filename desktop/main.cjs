const { app, BrowserWindow, shell, nativeImage, dialog } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const isDev = !app.isPackaged;
const devUrl = "http://127.0.0.1:5173";

function errorText(error) {
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}

function logMainProcessError(error) {
  const message = errorText(error);
  console.error(message);

  try {
    const logPath = path.join(app.getPath("userData"), "main-process.log");
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `[${new Date().toISOString()}]\n${message}\n\n`);
  } catch {
    // Logging must never create another crash loop.
  }
}

process.on("uncaughtException", logMainProcessError);
process.on("unhandledRejection", logMainProcessError);

function getIconPath() {
  const iconPng = path.join(__dirname, "..", "icons", "icon.png");
  if (fs.existsSync(iconPng)) {
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
  try {
    await startPackagedBackend();
    createWindow();
  } catch (error) {
    logMainProcessError(error);
    dialog.showErrorBox(
      "AI API load balancer failed to start",
      "The local gateway backend could not start. Details were written to main-process.log in the app data folder."
    );
    app.quit();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
