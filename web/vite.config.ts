import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The site and the API are deployed as one Worker, so every call is
// same-origin. In development, `wrangler dev` serves the API on 8787.
const apiProxy = {
  "/api": {
    target: "http://127.0.0.1:8787",
    changeOrigin: false,
  },
  "/v1": {
    target: "http://127.0.0.1:8787",
    changeOrigin: false,
  },
};

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: apiProxy,
  },
  preview: {
    proxy: apiProxy,
  },
  build: {
    target: "es2022",
    outDir: "dist",
  },
});
