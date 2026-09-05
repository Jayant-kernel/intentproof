import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiOrigin = process.env.CONTROL_ROOM_API_ORIGIN ?? "http://127.0.0.1:8787";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: {
    outDir: "../dist/frontend",
    emptyOutDir: true
  },
  server: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    proxy: { "/api": apiOrigin }
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    proxy: { "/api": apiOrigin }
  }
});
