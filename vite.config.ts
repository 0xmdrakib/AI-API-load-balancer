import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: "src/client",
  build: {
    outDir: "../../dist-web",
    emptyOutDir: true
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      "/api/": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true
      },
      "/v1/": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true
      },
      "/health": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true
      }
    }
  }
});
