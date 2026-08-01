const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("gatewayDesktop", {
  retryBackend: () => ipcRenderer.invoke("gateway:retry-backend"),
  openLogs: () => ipcRenderer.invoke("gateway:open-logs"),
  backendStatus: () => ipcRenderer.invoke("gateway:backend-status"),
  onBackendState: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on("gateway:backend-state", handler);
    return () => ipcRenderer.removeListener("gateway:backend-state", handler);
  }
});
