import { defineConfig } from "vite";

import react from "@vitejs/plugin-react";



const apiTarget = "http://localhost:8002";



export default defineConfig({

  plugins: [react()],

  server: {

    port: 5173,

    proxy: {

      "/ask": apiTarget,

      "/knowledge-bases": apiTarget,

      "/preview-asset": apiTarget,

      "/documents/extract/stream": {

        target: apiTarget,

        changeOrigin: true,

        proxyTimeout: 0,

        timeout: 0,

        configure: (proxy) => {

          proxy.on("proxyRes", (proxyRes) => {

            proxyRes.headers["cache-control"] = "no-cache, no-transform";

            proxyRes.headers["x-accel-buffering"] = "no";

            delete proxyRes.headers["content-length"];

          });

        },

      },

      "/documents": apiTarget,

      "/markdown-files": apiTarget,

      "/settings": apiTarget,

      "/logs": apiTarget,

      "/health": apiTarget,

      "/rag": apiTarget,

      "/static": apiTarget,

    },

  },

});


