const { app, BrowserWindow, dialog, ipcMain, nativeImage, safeStorage, shell, utilityProcess } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const RESTART_DELAYS = [1000, 2000, 5000];
const LOG_LIMIT_BYTES = 2 * 1024 * 1024;
const LOG_GENERATIONS = 3;
const CURRENT_USER_DATA_DIRNAME = "AI Load Balancer";
const LEGACY_USER_DATA_DIRNAMES = ["ai-key-gateway", "AI API load balancer"];

const appDataRoot = app.getPath("appData");
const currentUserDataPath = path.join(appDataRoot, CURRENT_USER_DATA_DIRNAME);
app.setPath("userData", currentUserDataPath);

function migrateLegacyUserData() {
  const essentialPaths = ["installation-secret.bin", "Local State", "data", "logs"];
  for (const legacyDirname of LEGACY_USER_DATA_DIRNAMES) {
    const legacyUserDataPath = path.join(appDataRoot, legacyDirname);
    if (legacyUserDataPath === currentUserDataPath || !fs.existsSync(legacyUserDataPath)) continue;
    for (const relativePath of essentialPaths) {
      const source = path.join(legacyUserDataPath, relativePath);
      const target = path.join(currentUserDataPath, relativePath);
      if (!fs.existsSync(source) || fs.existsSync(target)) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.cpSync(source, target, { recursive: true, errorOnExist: false });
    }

    const legacySecretPath = path.join(legacyUserDataPath, "installation-secret.bin");
    const currentSecretPath = path.join(currentUserDataPath, "installation-secret.bin");
    const legacyLocalStatePath = path.join(legacyUserDataPath, "Local State");
    const currentLocalStatePath = path.join(currentUserDataPath, "Local State");
    if (!fs.existsSync(legacySecretPath) || !fs.existsSync(currentSecretPath) || !fs.existsSync(legacyLocalStatePath)) continue;
    if (!fs.readFileSync(legacySecretPath).equals(fs.readFileSync(currentSecretPath))) continue;

    try {
      const legacyLocalState = JSON.parse(fs.readFileSync(legacyLocalStatePath, "utf8"));
      const currentLocalState = fs.existsSync(currentLocalStatePath)
        ? JSON.parse(fs.readFileSync(currentLocalStatePath, "utf8"))
        : {};
      if (legacyLocalState.os_crypt) {
        currentLocalState.os_crypt = legacyLocalState.os_crypt;
        fs.mkdirSync(path.dirname(currentLocalStatePath), { recursive: true });
        fs.writeFileSync(currentLocalStatePath, JSON.stringify(currentLocalState));
      }
    } catch {
      if (!fs.existsSync(currentLocalStatePath)) fs.copyFileSync(legacyLocalStatePath, currentLocalStatePath);
    }
  }
}

migrateLegacyUserData();
const hasSingleInstanceLock = app.requestSingleInstanceLock();
let mainWindow;
let backendProcess;
let backendRuntime;
let restartCount = 0;
let isQuitting = false;
let manualRestart = false;
let quitBarrierStarted = false;
let quitBarrierComplete = false;

if (!hasSingleInstanceLock) app.quit();

function getLogPath() {
  return path.join(app.getPath("userData"), "logs", "app.log");
}

function redact(value) {
  return String(value)
    .replace(/\b(aigw_[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{8,})\b/g, "[REDACTED_KEY]")
    .replace(/(authorization|x-api-key|api[_-]?key)(["':=\s]+)([^\s,}"]+)/gi, "$1$2[REDACTED]");
}

function rotateLogs(logPath) {
  try {
    if (!fs.existsSync(logPath) || fs.statSync(logPath).size < LOG_LIMIT_BYTES) return;
    for (let index = LOG_GENERATIONS - 1; index >= 1; index -= 1) {
      const source = index === 1 ? logPath : `${logPath}.${index - 1}`;
      const target = `${logPath}.${index}`;
      if (fs.existsSync(target)) fs.rmSync(target, { force: true });
      if (fs.existsSync(source)) fs.renameSync(source, target);
    }
  } catch {
    // Logging must never create a second failure path.
  }
}

function writeLog(level, value) {
  const message = redact(value instanceof Error ? value.stack || value.message : value);
  if (level === "ERROR") console.error(message);
  else console.log(message);
  try {
    const logPath = getLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    rotateLogs(logPath);
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] [${level}] ${message}\n`);
  } catch {
    // Best-effort diagnostic output only.
  }
}

process.on("uncaughtException", (error) => writeLog("ERROR", error));
process.on("unhandledRejection", (error) => writeLog("ERROR", error));

function getIcon() {
  const iconPath = path.join(__dirname, "..", "icons", "icon.png");
  return fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined;
}

function installationSecretPath() {
  return path.join(app.getPath("userData"), "installation-secret.bin");
}

function getInstallationSecret() {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Windows credential encryption is unavailable. The gateway will not store provider keys without SafeStorage protection.");
  }
  const secretPath = installationSecretPath();
  if (fs.existsSync(secretPath)) return safeStorage.decryptString(fs.readFileSync(secretPath));
  const secret = crypto.randomBytes(48).toString("base64url");
  const encrypted = safeStorage.encryptString(secret);
  fs.mkdirSync(path.dirname(secretPath), { recursive: true });
  fs.writeFileSync(secretPath, encrypted, { mode: 0o600 });
  return secret;
}

function broadcastBackendState(state, detail) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("gateway:backend-state", { state, detail, runtime: backendRuntime });
  }
}

function recoveryUrl(reason) {
  const page = path.join(__dirname, "recovery.html");
  return `${new URL(`file:///${page.replace(/\\/g, "/")}`).href}?reason=${encodeURIComponent(reason)}`;
}

async function showRecovery(reason) {
  writeLog("ERROR", reason);
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  await mainWindow.loadURL(recoveryUrl(reason));
}

function backendEnvironment() {
  return {
    ...process.env,
    HOST: process.env.HOST || "127.0.0.1",
    GATEWAY_DATA_DIR: process.env.GATEWAY_DATA_DIR || path.join(app.getPath("userData"), "data"),
    GATEWAY_SECRET: getInstallationSecret(),
    NODE_ENV: "production"
  };
}

function forkBackend() {
  return new Promise((resolve, reject) => {
    const backendEntry = path.join(__dirname, "backend.cjs");
    const child = utilityProcess.fork(backendEntry, [], {
      serviceName: "AI Load Balancer Backend",
      env: backendEnvironment(),
      stdio: "pipe"
    });
    backendProcess = child;
    let settled = false;
    const startupTimeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error("Backend did not become ready within 30 seconds."));
      }
    }, 30_000);

    child.stdout?.on("data", (chunk) => writeLog("BACKEND", chunk));
    child.stderr?.on("data", (chunk) => writeLog("BACKEND_ERROR", chunk));
    child.on("error", (type, location, report) => writeLog("ERROR", `${type} at ${location}\n${report}`));
    child.on("message", (message) => {
      if (message?.type === "ready") {
        backendRuntime = message.runtime;
        if (!settled) {
          settled = true;
          clearTimeout(startupTimeout);
          resolve(message.runtime);
        }
        broadcastBackendState("ready");
      } else if (message?.type === "fatal") {
        writeLog("ERROR", message.error || "Backend reported a fatal error.");
        if (!settled) {
          settled = true;
          clearTimeout(startupTimeout);
          reject(new Error(message.error || "Backend failed to start."));
        }
      }
    });
    child.once("exit", (code) => {
      clearTimeout(startupTimeout);
      if (backendProcess === child) backendProcess = undefined;
      writeLog(code === 0 || isQuitting ? "INFO" : "ERROR", `Backend utility process exited with code ${code}.`);
      if (!settled) {
        settled = true;
        reject(new Error(`Backend exited during startup with code ${code}.`));
      }
      if (!isQuitting && !manualRestart) void recoverBackend();
      manualRestart = false;
    });
  });
}

async function recoverBackend() {
  broadcastBackendState("restarting", { attempt: restartCount + 1 });
  if (restartCount >= RESTART_DELAYS.length) {
    await showRecovery("The isolated backend stopped repeatedly. Your configuration is preserved; use Retry backend or open the redacted log.");
    return;
  }
  const delay = RESTART_DELAYS[restartCount++];
  await new Promise((resolve) => setTimeout(resolve, delay));
  if (isQuitting) return;
  try {
    const oldPort = backendRuntime?.port;
    const runtime = await forkBackend();
    backendRuntime = runtime;
    if (mainWindow && !mainWindow.isDestroyed() && (mainWindow.webContents.getURL().startsWith("file:") || oldPort !== runtime.port)) {
      await mainWindow.loadURL(runtime.baseUrls.anthropic);
    }
  } catch (error) {
    writeLog("ERROR", error);
    if (!isQuitting && !backendProcess) await recoverBackend();
  }
}

function waitForBackendShutdown() {
  const child = backendProcess;
  if (!child) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      clearTimeout(abandonTimer);
      resolve();
    };
    const forceTimer = setTimeout(() => child.kill(), 3000);
    const abandonTimer = setTimeout(finish, 5000);
    child.once("exit", finish);
    try {
      child.postMessage({ type: "shutdown" });
    } catch {
      child.kill();
    }
  });
}

async function retryBackend() {
  restartCount = 0;
  const previous = backendProcess;
  if (previous) {
    manualRestart = true;
    await new Promise((resolve) => {
      const forceTimer = setTimeout(() => previous.kill(), 1500);
      previous.once("exit", () => {
        clearTimeout(forceTimer);
        resolve();
      });
      previous.postMessage({ type: "shutdown" });
    });
    manualRestart = false;
  }
  broadcastBackendState("restarting", { attempt: 1 });
  try {
    backendRuntime = await forkBackend();
    await mainWindow.loadURL(backendRuntime.baseUrls.anthropic);
    return { ok: true, runtime: backendRuntime };
  } catch (error) {
    await showRecovery(error instanceof Error ? error.message : String(error));
    return { ok: false, error: String(error) };
  }
}

function createWindow() {
  const icon = getIcon();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 860,
    minHeight: 620,
    show: false,
    title: "AI Load Balancer",
    backgroundColor: "#f0ebe0",
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const allowedRoot = backendRuntime?.baseUrls?.anthropic;
    if (url.startsWith("file:") || (allowedRoot && url.startsWith(allowedRoot))) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    writeLog("ERROR", `Renderer exited: ${details.reason} (${details.exitCode})`);
    if (!isQuitting) void showRecovery("The interface process stopped unexpectedly. The backend and saved configuration remain isolated and safe.");
  });
  mainWindow.on("closed", () => { mainWindow = undefined; });
  return mainWindow;
}

ipcMain.handle("gateway:retry-backend", () => retryBackend());
ipcMain.handle("gateway:open-logs", () => {
  const logPath = getLogPath();
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  if (!fs.existsSync(logPath)) fs.writeFileSync(logPath, "No log entries yet.\n");
  shell.showItemInFolder(logPath);
  return logPath;
});
ipcMain.handle("gateway:backend-status", () => ({ state: backendProcess ? "ready" : "stopped", runtime: backendRuntime }));

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  createWindow();
  try {
    backendRuntime = await forkBackend();
    await mainWindow.loadURL(backendRuntime.baseUrls.anthropic);
  } catch (error) {
    await showRecovery(error instanceof Error ? error.message : String(error));
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
    void mainWindow.loadURL(backendRuntime?.baseUrls?.anthropic || recoveryUrl("Backend is not ready yet."));
  }
});

app.on("before-quit", (event) => {
  isQuitting = true;
  if (quitBarrierComplete) return;
  event.preventDefault();
  if (quitBarrierStarted) return;
  quitBarrierStarted = true;
  void waitForBackendShutdown().finally(() => {
    quitBarrierComplete = true;
    app.quit();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
