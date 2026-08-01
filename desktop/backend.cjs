const path = require("node:path");
const { pathToFileURL } = require("node:url");

let app;
let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await app?.close();
  } finally {
    process.exit(0);
  }
}

process.parentPort?.on("message", (event) => {
  const message = event.data;
  if (message?.type === "shutdown") void shutdown();
  if (message?.type === "simulate-crash") process.exit(86);
});
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());

(async () => {
  try {
    const serverEntry = path.join(__dirname, "..", "dist", "server", "index.js");
    const { getRuntimeMetadata } = await import(pathToFileURL(path.join(__dirname, "..", "dist", "server", "runtime.js")).href);
    const { startGatewayServer } = await import(pathToFileURL(serverEntry).href);
    app = await startGatewayServer();
    process.parentPort?.postMessage({ type: "ready", runtime: getRuntimeMetadata() });
  } catch (error) {
    const details = error instanceof Error ? error.stack || error.message : String(error);
    process.parentPort?.postMessage({ type: "fatal", error: details });
    console.error(details);
    process.exit(1);
  }
})();
