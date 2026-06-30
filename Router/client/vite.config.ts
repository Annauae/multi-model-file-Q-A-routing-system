import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/ask": "http://localhost:8002",
      "/knowledge-bases": "http://localhost:8002",
      "/preview-asset": "http://localhost:8002",
      "/documents": "http://localhost:8002",
      "/markdown-files": "http://localhost:8002",
      "/settings": "http://localhost:8002",
      "/logs": "http://localhost:8002",
      "/health": "http://localhost:8002",
      "/static": "http://localhost:8002",
    },
  },
});
